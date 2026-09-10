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

// ── 计费配置（内置兜底）──
// 这份内置数据与仓库根目录 pricing.json 保持一致（最近一次更新）。
// 运行期若成功拉到外部 pricing.json，会由 setPricingConfig() 覆盖以下导出值。
let PRICING_SNAPSHOT_AT = "2026-09-10";

// 每条价格模型的来源标注（官方 / 估算 / 免费），用于透明呈现
let SOURCE_NOTE = {
  "deepseek-v4-flash": "官方峰谷计价",
  "deepseek-v4-flash-vision-exp": "官方峰谷计价（与 flash 同档）",
  "deepseek-v4-pro": "官方峰谷计价",
  "mimo-v2.5": "官方 2026-05-27 降价价",
  "mimo-v2.5-pro": "官方 2026-05-27 降价价",
  "kimi-k2.6": "官方定价",
  "kimi-k2.7-code": "官方定价",
  "glm-5.3": "官方标准价",
  "glm-5.3-flash": "官方标准价",
  "glm-5.2": "官方标准价",
  "glm-5-turbo": "官方标准价（分段计价，按输入 <32K 主档）",
  "glm-4.7": "官方标准价（分段计价，按常规主档）",
  "glm-4.6": "Z.ai 官方美元价换算（国内计价页未收录）",
  "agnes-2.5-flash": "免费",
  "agnes-2.5-pro-alpha": "官方付费价（该托管 API 已废弃）",
  "agnes-image-2.1-flash": "免费",
  "agnes-video-v2.0": "免费",
  "qwen3:8b": "本地推理，无 API 费用",
  "gpt-5.6-sol": "OpenAI 官方促销价（2026-08-21 起）",
  "gpt-5.6-terra": "OpenAI 官方定价",
  "gpt-5.6-luna": "OpenAI 官方定价",
  "gpt-5.5": "OpenAI 官方定价",
  "gpt-5.4": "OpenAI 官方定价",
  "gpt-5.4-mini": "OpenAI 官方定价",
  "gpt-5.2": "OpenAI 官方定价",
  "gpt-4o": "OpenAI 官方定价（缓存读取为输入价 50%）",
  "gemini-2.5-pro": "Google 官方定价（≤200K 短上下文档）",
  "gemini-2.5-flash": "Google 官方定价",
  "grok-4.5": "xAI 官方定价",
  "grok-4.3": "xAI 官方定价（$1.25/$0.20/$2.50，按 1 美元≈6.8 元折算）",
};

let PRICING = {
  // DeepSeek V4 官方峰谷计价（元/百万 tokens）
  // 高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00，空闲价为高峰价一半
  "deepseek-v4-flash": {
    peak: { inputMiss: 3.0, inputHit: 0.1, output: 9.0 },
    offPeak: { inputMiss: 1.5, inputHit: 0.05, output: 4.5 },
  },
  "deepseek-v4-flash-vision-exp": {
    peak: { inputMiss: 3.0, inputHit: 0.1, output: 9.0 },
    offPeak: { inputMiss: 1.5, inputHit: 0.05, output: 4.5 },
  },
  "deepseek-v4-pro": {
    peak: { inputMiss: 9.0, inputHit: 0.3, output: 27.0 },
    offPeak: { inputMiss: 4.5, inputHit: 0.15, output: 13.5 },
  },
  // MiMo-V2.5 官方 2026-05-27 永久降价后（元/百万 tokens，固定价）
  "mimo-v2.5": { inputMiss: 1.0, inputHit: 0.02, output: 2.0 },
  "mimo-v2.5-pro": { inputMiss: 3.0, inputHit: 0.025, output: 6.0 },
  // Moonshot Kimi（元/百万 tokens）
  "kimi-k2.6": { inputMiss: 6.5, inputHit: 1.1, output: 27.0 },
  "kimi-k2.7-code": { inputMiss: 6.5, inputHit: 1.3, output: 27.0 },
  // 智谱 GLM 官方标准价（元/百万 tokens）
  "glm-5.3": { inputMiss: 8.0, inputHit: 2.0, output: 28.0 },
  "glm-5.3-flash": { inputMiss: 0.8, inputHit: 0.23, output: 2.8 },
  "glm-5.2": { inputMiss: 8.0, inputHit: 2.0, output: 28.0 },
  "glm-5-turbo": { inputMiss: 5.0, inputHit: 1.2, output: 22.0 },
  "glm-4.7": { inputMiss: 3.0, inputHit: 0.6, output: 14.0 },
  "glm-4.6": { inputMiss: 4.0, inputHit: 0.74, output: 14.8 },
  // Agnes：2.5-flash 免费；2.5-pro-alpha 付费
  "agnes-2.5-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "agnes-2.5-pro-alpha": { inputMiss: 3.0, inputHit: 0.025, output: 6.0 },
  "agnes-image-2.1-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "agnes-video-v2.0": { inputMiss: 0, inputHit: 0, output: 0 },
  // 本地推理：无 API 费用
  "qwen3:8b": { inputMiss: 0, inputHit: 0, output: 0 },
  // OpenAI（元/百万，按 1 美元 ≈ 6.8 元换算；sol 为 2026-08-21 起促销价）
  "gpt-5.6-sol": { inputMiss: 27.2, inputHit: 2.72, output: 136.0 },
  "gpt-5.6-terra": { inputMiss: 13.6, inputHit: 1.36, output: 81.6 },
  "gpt-5.6-luna": { inputMiss: 1.36, inputHit: 0.14, output: 8.16 },
  "gpt-5.5": { inputMiss: 34.0, inputHit: 3.4, output: 204.0 },
  "gpt-5.4": { inputMiss: 17.0, inputHit: 1.7, output: 102.0 },
  "gpt-5.4-mini": { inputMiss: 5.1, inputHit: 0.51, output: 30.6 },
  "gpt-5.2": { inputMiss: 11.9, inputHit: 1.19, output: 95.2 },
  "gpt-4o": { inputMiss: 17.0, inputHit: 8.5, output: 68.0 },
  // Google Gemini（元/百万，汇率同上）
  "gemini-2.5-pro": { inputMiss: 8.5, inputHit: 0.85, output: 68.0 },
  "gemini-2.5-flash": { inputMiss: 2.04, inputHit: 0.2, output: 17.0 },
  // xAI Grok（元/百万；grok-4.3 输出价为估值）
  "grok-4.5": { inputMiss: 13.6, inputHit: 2.04, output: 40.8 },
  "grok-4.3": { inputMiss: 8.5, inputHit: 1.36, output: 17.0 },
};

let PROVIDER_OF_MODEL = {
  "deepseek-v4-flash": "deepseek",
  "deepseek-v4-pro": "deepseek",
  "deepseek-v4-flash-vision-exp": "deepseek",
  "mimo-v2.5": "mimo",
  "mimo-v2.5-pro": "mimo",
  "mimo-v2.5-tts-voicedesign": "mimo",
  "mimo-v2-omni": "mimo",
  "kimi-k2.6": "moonshot",
  "kimi-k2.7-code": "moonshot",
  "glm-5.3": "zhipu",
  "glm-5.3-flash": "zhipu",
  "glm-5.2": "zhipu",
  "glm-5-turbo": "zhipu",
  "glm-5.1": "zhipu",
  "glm-5": "zhipu",
  "glm-4.7": "zhipu",
  "glm-4.6": "zhipu",
  "glm-4-plus": "zhipu",
  "glm-4-flash": "zhipu",
  "glm-4-air": "zhipu",
  "gpt-4o": "openai",
  "gpt-5.5": "openai",
  "gpt-5.4-pro": "openai",
  "gemini-2.5-pro": "gemini",
  "gemini-2.5-flash": "gemini",
  "gemini-2.0-flash": "gemini",
  "agnes-2.5-flash": "agnes",
  "agnes-2.5-pro-alpha": "agnes",
  "agnes-image-2.1-flash": "agnes",
  "agnes-video-v2.0": "agnes",
  "qwen3:8b": "ollama",
  "moonshot-v1": "moonshot",
};

// 各供应商上下文窗口（默认 1M）
let CONTEXT_WINDOW = {
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash-vision-exp": 1_000_000,
  "mimo-v2.5": 1_000_000,
  "mimo-v2.5-pro": 1_000_000,
  "kimi-k2.6": 256_000,
  "kimi-k2.7-code": 256_000,
  "glm-5.3": 1_000_000,
  "glm-5.3-flash": 1_000_000,
  "glm-5.2": 1_000_000,
  "glm-5-turbo": 1_000_000,
  "glm-4.7": 200_000,
  "glm-4.6": 200_000,
  "qwen3:8b": 32_768,
  "gpt-5.6-sol": 400_000,
  "gpt-5.6-terra": 400_000,
  "gpt-5.6-luna": 400_000,
  "gpt-5.5": 400_000,
  "gpt-5.4": 400_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.2": 400_000,
  "gpt-4o": 128_000,
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "grok-4.5": 256_000,
  "grok-4.3": 1_000_000,
};

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ── 外部计费配置注入 ──
// api.js 拉到远程 pricing.json 后调用。逐字段校验，非法条目直接丢弃，
// 全部条目都非法时返回 false 并保持内置配置不变（避免一份坏配置把费用算成 0）。
function isValidPrice(p) {
  return !!p && ["inputMiss", "inputHit", "output"].every(
    (k) => typeof p[k] === "number" && Number.isFinite(p[k]) && p[k] >= 0,
  );
}

function setPricingConfig(raw) {
  if (!raw || typeof raw !== "object" || !raw.models || typeof raw.models !== "object") return false;
  const nextPricing = {}, nextProvider = {}, nextNote = {}, nextWindow = {};
  let accepted = 0;
  for (const [model, cfg] of Object.entries(raw.models)) {
    if (!model || !cfg || typeof cfg !== "object") continue;
    if (isValidPrice(cfg.flat)) {
      nextPricing[model] = { inputMiss: cfg.flat.inputMiss, inputHit: cfg.flat.inputHit, output: cfg.flat.output };
    } else if (isValidPrice(cfg.peak) && isValidPrice(cfg.offPeak)) {
      nextPricing[model] = {
        peak: { inputMiss: cfg.peak.inputMiss, inputHit: cfg.peak.inputHit, output: cfg.peak.output },
        offPeak: { inputMiss: cfg.offPeak.inputMiss, inputHit: cfg.offPeak.inputHit, output: cfg.offPeak.output },
      };
    } else {
      continue;
    }
    if (typeof cfg.provider === "string" && cfg.provider) nextProvider[model] = cfg.provider;
    if (typeof cfg.source === "string" && cfg.source) nextNote[model] = cfg.source;
    if (typeof cfg.contextWindow === "number" && cfg.contextWindow > 0) nextWindow[model] = cfg.contextWindow;
    accepted += 1;
  }
  if (!accepted) return false;
  PRICING = nextPricing;
  PROVIDER_OF_MODEL = { ...PROVIDER_OF_MODEL, ...nextProvider };
  SOURCE_NOTE = { ...SOURCE_NOTE, ...nextNote };
  CONTEXT_WINDOW = { ...CONTEXT_WINDOW, ...nextWindow };
  if (typeof raw.snapshotAt === "string" && raw.snapshotAt) PRICING_SNAPSHOT_AT = raw.snapshotAt;
  return true;
}

// 高峰时段：北京时间 9:00-12:00、14:00-18:00，其余空闲（空闲价 = 高峰价一半）
function isPeakHour(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return true; // 时间戳缺失/异常时按高峰价（保守）
  const beijingHour = (d.getUTCHours() + 8) % 24;
  return (beijingHour >= 9 && beijingHour < 12) || (beijingHour >= 14 && beijingHour < 18);
}

// 取某模型在指定时刻的单价：峰谷模型按时间选档，固定价模型直接返回
function priceFor(model, ts) {
  const entry = PRICING[model];
  if (!entry) return null;
  if (entry.peak) return isPeakHour(ts) ? entry.peak : entry.offPeak;
  return entry;
}

// 费用：input(未命中) + cacheInc(命中) + (output + reasoning) × 输出价
function calcCost(input, cacheInc, output, reasoning, model, ts) {
  const p = priceFor(model, ts);
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
  let currentModel = null;
  let currentProvider = null;
  const modelProviders = {};
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
    if (obj.type === "model_change") {
      currentModel = obj.modelId || currentModel;
      currentProvider = obj.provider || currentProvider;
      if (!model) model = currentModel;
      if (currentModel && currentProvider) modelProviders[currentModel] = currentProvider;
    }
    if (obj.type === "message" && obj.message && obj.message.role === "assistant" && obj.message.usage) {
      const u = obj.message.usage;
      const turnModel = obj.message.model || currentModel || null;
      const turnProvider = obj.message.provider || currentProvider || PROVIDER_OF_MODEL[turnModel] || null;
      if (turnModel && turnProvider) modelProviders[turnModel] = turnProvider;
      turns.push({
        ts: obj.timestamp,
        input: u.input || 0,
        output: u.output || 0,
        cacheRead: u.cacheRead || 0,
        cacheWrite: u.cacheWrite || 0,
        reasoning: u.reasoning || 0,
        total: u.totalTokens || 0,
        m: turnModel, // 该轮实际模型（多模型会话计费用）
        p: turnProvider, // 该轮实际供应商（支持 OAuth / 动态供应商）
      });
      if (!model) model = turnModel;
    }
  }

  if (turns.length === 0) return null;

  // 逐轮补充缓存增量，并做累计统计
  let sumInput = 0, sumOutput = 0, sumCacheInc = 0, sumCacheRead = 0, sumCacheWrite = 0, sumReasoning = 0;
  let prevCache = 0;
  for (const t of turns) {
    t.cacheInc = Math.max(0, (t.cacheRead || 0) - prevCache);
    prevCache = t.cacheRead;
    sumInput += t.input;
    sumOutput += t.output;
    sumCacheInc += t.cacheInc;
    sumCacheRead += t.cacheRead || 0;
    sumCacheWrite += t.cacheWrite || 0;
    sumReasoning += t.reasoning || 0;
  }

  // 命中率的正确口径：一次请求的输入 = 命中(cacheRead) + 未命中(input)。
  // 不能用 cacheInc(=cacheRead 差分)，因为 cacheRead 是累计值，会在重启/上下文压缩时
  // 归零重涨，差分在那里会被 clamp 成 0，把几十万命中量误判为未读，命中率被系统压低。
  const last = turns[turns.length - 1];
  const avgHit = sumCacheRead + sumInput > 0 ? (sumCacheRead / (sumCacheRead + sumInput)) * 100 : 0;
  const lastHit = last.cacheRead + last.input > 0 ? (last.cacheRead / (last.cacheRead + last.input)) * 100 : 0;

  // 逐轮序列（图表用）：只保留最近 limitTurns 轮；同时累计逐轮实际费用
  const series = [];
  let cumInput = 0, cumOutput = 0, cumCache = 0, cumReason = 0, cumCost = 0;
  const modelCounts = {}; // 每轮实际模型出现次数（多模型会话归属判定）
  const providerUsage = {}; // 本会话按实际供应商聚合：tokens / 费用 / 轮数
  for (const t of turns) {
    const m = t.m || model;
    modelCounts[m] = (modelCounts[m] || 0) + 1;
    cumInput += t.input;
    cumOutput += t.output;
    cumCache += t.cacheInc;
    cumReason += t.reasoning || 0;
    const rawCost = calcCost(t.input, t.cacheInc, t.output, t.reasoning, m, t.ts);
    const c = rawCost || 0;
    cumCost += c;
    const turnTotal = t.input + t.cacheInc + t.output + (t.reasoning || 0);
    const provider = t.p || modelProviders[m] || PROVIDER_OF_MODEL[m] || "unknown";
    const pu = providerUsage[provider] || (providerUsage[provider] = { provider, turns: 0, tokens: 0, cost: 0, pricedTurns: 0, models: {}, modelTokens: {} });
    pu.turns++;
    pu.tokens += turnTotal;
    pu.cost += c;
    if (rawCost != null) pu.pricedTurns++;
    pu.models[m] = (pu.models[m] || 0) + 1;
    pu.modelTokens[m] = (pu.modelTokens[m] || 0) + turnTotal;
    series.push({
      i: series.length + 1,
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead, // 本轮实际缓存命中量（非增量，命中率用）
      cacheInc: t.cacheInc, // 本轮缓存增量（费用口径）
      total: turnTotal, // 单轮处理量
      hit: t.cacheRead + t.input > 0 ? round((t.cacheRead / (t.cacheRead + t.input)) * 100, 1) : 0,
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
  const lastCost = calcCost(last.input, last.cacheInc, last.output, last.reasoning, last.m || model, last.ts);
  const models = Object.entries(modelCounts).map(([m, cnt]) => ({ model: m, turns: cnt, provider: modelProviders[m] || PROVIDER_OF_MODEL[m] || null }));
  const providers = Object.values(providerUsage).map((p) => ({
    provider: p.provider,
    turns: p.turns,
    tokens: p.tokens,
    cost: p.pricedTurns > 0 ? round(p.cost, 4) : null,
    costComplete: p.pricedTurns === p.turns,
    models: Object.entries(p.models).map(([model, turns]) => ({ model, turns, tokens: p.modelTokens[model] || 0 })),
  }));
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
    provider: modelProviders[model] || PROVIDER_OF_MODEL[model] || null,
    models, // 会话内模型分布：[{model, turns, provider}]
    providers, // 本会话实际使用的供应商明细：tokens / cost / turns / models
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
    sumCacheRead: sumCacheRead, // 本轮实际缓存命中累计（命中率口径）
    sumCacheInc, // 单轮缓存增量累计（费用口径）
    sumCacheWrite,
    sumReasoning,
    sessionCostCny: sessionCost == null ? null : round(sessionCost, 4),
    lastCostCny: lastCost == null ? null : round(lastCost, 6),
    startTime: sessionStart,
    series: trimmed,
  };
}

export { parseSession, PRICING, PROVIDER_OF_MODEL, CONTEXT_WINDOW, round, priceFor, isPeakHour, SOURCE_NOTE, PRICING_SNAPSHOT_AT, setPricingConfig };
