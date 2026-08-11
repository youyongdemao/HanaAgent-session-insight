// lib/usage-parser.js — 解析 Hana 会话 JSONL，产出统计与图表序列
// 口径 v2（2026-08-11 校准）：
//   - usage.cacheRead / usage.totalTokens 是「累计值」（当前上下文缓存总量），
//     单轮新增缓存命中 = 本轮 cacheRead − 上一轮 cacheRead（会话内单调递增，
//     上下文压缩后归零重新累积，故按增量逐轮累加最稳）
//   - usage.input / output / reasoning 是「单轮增量」
//   - 单轮处理量 total = input + cacheInc + output + reasoning
//   - 会话总计 sessionTokens = Σ单轮处理量（含推理）
//   - 上下文占用 lastWindowTokens = last.input + last.cacheRead（累计窗口大小）
//   - 费用：input×miss + cacheInc×hit + (output+reasoning)×output 价
//     （DeepSeek 官方惯例 reasoning 按输出价计费）

const PRICING = {
  // DeepSeek 官方 2026-08（元/百万 tokens，缓存命中价已按官方列示）
  "deepseek-v4-flash": { inputMiss: 1.0, inputHit: 0.02, output: 2.0 },
  "deepseek-v4-pro": { inputMiss: 3.0, inputHit: 0.025, output: 6.0 },
  // MiMo-V2.5 官方 2026-05-27 永久降价后（元/百万 tokens）
  "mimo-v2.5": { inputMiss: 1.0, inputHit: 0.02, output: 2.0 },
  "mimo-v2.5-pro": { inputMiss: 3.0, inputHit: 0.025, output: 6.0 },
  // 智谱 GLM-5.2 官方标准定价（缓存命中价为估算）
  "glm-5.2": { inputMiss: 8.0, inputHit: 0.8, output: 28.0 },
};

const PROVIDER_OF_MODEL = {
  "deepseek-v4-flash": "deepseek",
  "deepseek-v4-pro": "deepseek",
  "mimo-v2.5": "mimo",
  "mimo-v2.5-pro": "mimo",
  "mimo-v2.5-tts-voicedesign": "mimo",
  "mimo-v2-omni": "mimo",
  "glm-5.2": "zhipu",
  "glm-5.1": "zhipu",
  "glm-5": "zhipu",
  "glm-4-plus": "zhipu",
  "glm-4-flash": "zhipu",
  "glm-4-air": "zhipu",
  "gpt-4o": "openai",
  "gpt-5.5": "openai",
  "gpt-5.4-pro": "openai",
  "gemini-2.5-pro": "gemini",
  "gemini-2.5-flash": "gemini",
  "gemini-2.0-flash": "gemini",
  "agnes-2.0-flash": "agnes",
  "agnes-image-2.1-flash": "agnes",
  "agnes-video-v2.0": "agnes",
  "moonshot-v1": "moonshot",
};

// 各供应商上下文窗口（默认 1M）
const CONTEXT_WINDOW = {
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "mimo-v2.5": 1_000_000,
  "mimo-v2.5-pro": 1_000_000,
};

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// 费用：input(未命中) + cacheInc(命中) + (output + reasoning) × 输出价
function calcCost(input, cacheInc, output, reasoning, model) {
  const p = PRICING[model];
  if (!p) return null;
  return (
    (input / 1e6) * p.inputMiss +
    (cacheInc / 1e6) * p.inputHit +
    ((output + (reasoning || 0)) / 1e6) * p.output
  );
}

// 解析单个会话文件内容，limitTurns 限制返回的逐轮序列长度（用于图表）
function parseSession(content, limitTurns = 200) {
  const lines = content.split("\n");
  const turns = [];
  let model = null;
  let sessionStart = null;
  let sessionId = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "session" && !sessionStart) {
      sessionStart = obj.timestamp;
      sessionId = obj.id || null;
    }
    if (obj.type === "model_change" && !model) model = obj.modelId;
    if (obj.type === "message" && obj.message && obj.message.role === "assistant" && obj.message.usage) {
      const u = obj.message.usage;
      turns.push({
        ts: obj.timestamp,
        input: u.input || 0,
        output: u.output || 0,
        cacheRead: u.cacheRead || 0,
        cacheWrite: u.cacheWrite || 0,
        reasoning: u.reasoning || 0,
        total: u.totalTokens || 0,
        m: obj.message.model || null, // 该轮实际模型（多模型会话计费用）
      });
      if (!model) model = obj.message.model;
    }
  }

  if (turns.length === 0) return null;

  // 逐轮补充缓存增量，并做累计统计
  let sumInput = 0, sumOutput = 0, sumCacheInc = 0, sumCacheWrite = 0, sumReasoning = 0;
  let prevCache = 0;
  for (const t of turns) {
    t.cacheInc = Math.max(0, (t.cacheRead || 0) - prevCache);
    prevCache = t.cacheRead;
    sumInput += t.input;
    sumOutput += t.output;
    sumCacheInc += t.cacheInc;
    sumCacheWrite += t.cacheWrite || 0;
    sumReasoning += t.reasoning || 0;
  }

  const last = turns[turns.length - 1];
  const avgHit = sumInput + sumCacheInc > 0 ? (sumCacheInc / (sumInput + sumCacheInc)) * 100 : 0;
  const lastHit = last.input + last.cacheInc > 0 ? (last.cacheInc / (last.input + last.cacheInc)) * 100 : 0;

  // 逐轮序列（图表用）：只保留最近 limitTurns 轮；同时累计逐轮实际费用
  const series = [];
  let cumInput = 0, cumOutput = 0, cumCache = 0, cumReason = 0, cumCost = 0;
  const modelCounts = {}; // 每轮实际模型出现次数（多模型会话归属判定）
  for (const t of turns) {
    const m = t.m || model;
    modelCounts[m] = (modelCounts[m] || 0) + 1;
    cumInput += t.input;
    cumOutput += t.output;
    cumCache += t.cacheInc;
    cumReason += t.reasoning || 0;
    const c = calcCost(t.input, t.cacheInc, t.output, t.reasoning, m) || 0;
    cumCost += c;
    const turnTotal = t.input + t.cacheInc + t.output + (t.reasoning || 0);
    series.push({
      i: series.length + 1,
      input: t.input,
      output: t.output,
      cacheRead: t.cacheInc, // 单轮增量（图表口径）
      total: turnTotal, // 单轮处理量
      hit: t.input + t.cacheInc > 0 ? round((t.cacheInc / (t.input + t.cacheInc)) * 100, 1) : 0,
      cost: round(c, 6),
      cumTokens: cumInput + cumOutput + cumCache + cumReason,
      cumCost: round(cumCost, 4),
    });
  }
  const trimmed = series.slice(-limitTurns);

  // 会话归属模型：主模型 = 出现轮次最多的模型；会话费用 = 逐轮按各自模型价格累计
  const dominant = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0];
  const dominantModel = dominant ? dominant[0] : model;
  const sessionCost = cumCost;
  const lastCost = calcCost(last.input, last.cacheInc, last.output, last.reasoning, last.m || model);
  const models = Object.entries(modelCounts).map(([m, cnt]) => ({ model: m, turns: cnt }));
  model = dominantModel; // 会话归属用主模型

  const contextWindow = CONTEXT_WINDOW[model] || 1_000_000;

  // 上下文窗口占用：最近一次请求的 input + cacheRead（累计）即当前窗口大小
  const lastWindowTokens = last.input + last.cacheRead;
  const compactThreshold = 0.8; // 压缩阈值（Hana 默认 80%）
  const contextPercent = contextWindow > 0 ? (lastWindowTokens / contextWindow) * 100 : 0;
  const remainingToCompact = Math.max(0, contextWindow * compactThreshold - lastWindowTokens);

  // 会话时长（分钟）
  let durationMinutes = null;
  if (sessionStart && turns.length > 0) {
    const start = Date.parse(sessionStart);
    const end = Date.parse(turns[turns.length - 1].ts) || Date.now();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durationMinutes = Math.max(0, Math.round((end - start) / 60000));
    }
  }

  return {
    model,
    provider: PROVIDER_OF_MODEL[model] || null,
    models, // 会话内模型分布：[{model, turns}]，多模型会话用
    sessionId,
    contextWindow,
    contextPercent: Math.round(contextPercent * 10) / 10,
    lastWindowTokens,
    compactThreshold,
    remainingToCompact,
    durationMinutes,
    turns: turns.length,
    sessionTokens: sumInput + sumOutput + sumCacheInc + sumReasoning,
    lastTurnTokens: last.input + last.cacheInc + last.output + (last.reasoning || 0),
    lastHitPercent: round(lastHit),
    avgHitPercent: round(avgHit),
    sumInput,
    sumOutput,
    sumCacheRead: sumCacheInc, // 语义改为累计缓存命中
    sumCacheWrite,
    sumReasoning,
    sessionCostCny: sessionCost == null ? null : round(sessionCost, 4),
    lastCostCny: lastCost == null ? null : round(lastCost, 6),
    startTime: sessionStart,
    series: trimmed,
  };
}

export { parseSession, PRICING, PROVIDER_OF_MODEL, CONTEXT_WINDOW, round };
