// lib/host-data.js — 把宿主 v2 公开 API 组合成面板需要的形状
// 数据源：session:list / session:context / usage:list / provider:credentials
// 与 v1 的 lib/usage-parser.js 保持同一套口径，但逐轮缓存不再做差分：
// v2 账本里的 cache.readTokens 就是单次请求值（jsonl 里的 cacheRead 是累计值）。
import {
  priceFor,
  PROVIDER_OF_MODEL,
  CONTEXT_WINDOW,
  round,
  canonProvider,
  parseSession,
  missInputOf,
} from "./usage-parser.js";

const SESSION_ATTR = "session";

export function isSessionRequest(entry) {
  return entry?.attribution?.kind === SESSION_ATTR;
}

function num(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 估算系统提示词占用的 token 数。
 * 宿主只给 systemPrompt 的文本，不给它的 token 数，所以这里按字符类别折算：
 * ASCII 约 4 字符/token，CJK 等宽字符约 1.5 字符/token。
 * 结果只用于「上下文构成」的占比展示，界面上必须带 ~ 前缀标为估算值。
 */
export function estPromptTokens(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.round(ascii / 4 + wide / 1.5);
}

function calcTurnCost(turn) {
  const p = priceFor(turn.m, turn.ts, turn.p);
  if (!p) return null;
  const inputMiss = num(turn.input);
  const inputHit = num(turn.cacheRead);
  const output = num(turn.output) + num(turn.reasoning);
  return (
    (inputMiss / 1e6) * p.inputMiss +
    (inputHit / 1e6) * p.inputHit +
    (output / 1e6) * p.output
  );
}

/** 把一条 usage 账本条目转成逐轮记录（与 v1 parseSession 的 turn 同义） */
export function entryToTurn(entry) {
  const usage = entry?.usage ?? {};
  const cache = usage.cache ?? {};
  const input = usage.input ?? {};
  const output = usage.output ?? {};
  const cacheRead = num(cache.readTokens);
  // 未命中输入：优先宿主显式字段；缺失时用「输入总量 − 命中」兜底；
  // 两者都拿不到就标记为未知，绝不当作 0（否则命中率会假性 100%、费用还会漏算）
  const inputTotal = num(input.totalTokens);
  const missRaw = missInputOf(usage);
  const missKnown = missRaw != null;
  const missInput = missRaw != null ? missRaw : 0;
  return {
    ts: entry?.startedAt ?? null,
    input: missInput,
    missKnown,
    output: num(output.totalTokens),
    cacheRead,
    cacheWrite: num(cache.writeTokens),
    reasoning: num(output.reasoningTokens),
    total: num(usage.totalTokens),
    hitRatio: typeof cache.hitRatio === "number" ? cache.hitRatio : null,
    m: entry?.model?.modelId ?? null,
    p: entry?.model?.provider ?? null,
    requestId: entry?.requestId ?? null,
  };
}

const usageCache = new Map();

/** 拉一个会话的全部用量条目（按时间正序）。
 *  注意：宿主的 usage:list 过滤器当前不接受 cursor，返回的 nextCursor 也恒为 null，
 *  所以历史只能靠 since / until 时间窗分片。单会话量级（数百条）一次 limit 足够。 */
export async function fetchSessionUsage(sdk, sessionId, { limit = 1000, ttlMs = 5000 } = {}) {
  const now = Date.now();
  const cached = usageCache.get(sessionId);
  if (cached && now - cached.at < ttlMs) return cached.value;
  const result = await sdk.usage.list({ sessionId, limit });
  const value = (result?.entries ?? [])
    .filter(isSessionRequest)
    .sort((a, b) => Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0));
  usageCache.set(sessionId, { at: now, value });
  if (usageCache.size > 60) {
    for (const key of [...usageCache.keys()].slice(0, 20)) usageCache.delete(key);
  }
  return value;
}

/** 按会话聚合出面板用的 stats（字段名与 v1 /api/stats 对齐） */
export function buildSessionStats(entries, context = null, limitTurns = 200) {
  const turns = entries.map(entryToTurn);
  if (turns.length === 0) {
    // 宿主用量账本是一个滚动窗口（本机目前只覆盖最近二十多天），更早的会话查不到记录。
    // 这种情况返回一个可渲染的空壳而不是 null，否则前端只能把整块渲染成失败。
    return {
      model: context?.model?.id ?? null,
      provider: context?.model?.provider ?? null,
      models: [],
      providers: [],
      sessionId: context?.sessionId ?? null,
      contextWindow: num(context?.model?.contextWindow) || 0,
      contextPercent: num(context?.contextUsage?.percent) || 0,
      lastWindowTokens: num(context?.contextUsage?.tokens),
      systemPromptTokens: estPromptTokens(context?.systemPrompt),
      compactThreshold: 0.8,
      remainingToCompact: 0,
      durationMinutes: null,
      turns: 0,
      sessionTokens: 0,
      lastTurnTokens: 0,
      lastHitPercent: 0,
      avgHitPercent: 0,
      sumInput: 0,
      sumOutput: 0,
      sumCacheRead: 0,
      sumCacheInc: 0,
      sumCacheWrite: 0,
      sumReasoning: 0,
      sessionCostCny: null,
      lastCostCny: null,
      startTime: null,
      isStreaming: context?.isStreaming ?? null,
      thinkingLevel: context?.thinkingLevel ?? null,
      noUsage: true,
      series: [],
    };
  }

  let sumInput = 0;
  let sumKnownInput = 0;
  let sumKnownHit = 0;
  let sumOutput = 0;
  let sumCacheRead = 0;
  let sumCacheWrite = 0;
  let sumReasoning = 0;
  for (const t of turns) {
    sumInput += t.input;
    if (t.missKnown) {
      sumKnownInput += t.input;
      sumKnownHit += t.cacheRead;
    }
    sumOutput += t.output;
    sumCacheRead += t.cacheRead;
    sumCacheWrite += t.cacheWrite;
    sumReasoning += t.reasoning;
  }

  const last = turns[turns.length - 1];
  const avgHit =
    sumKnownInput + sumKnownHit > 0
      ? (sumKnownHit / (sumKnownHit + sumKnownInput)) * 100
      : null;
  const lastHit =
    last.cacheRead + last.input > 0
      ? (last.cacheRead / (last.cacheRead + last.input)) * 100
      : 0;

  const series = [];
  let cumInput = 0;
  let cumOutput = 0;
  let cumCache = 0;
  let cumReason = 0;
  let cumCost = 0;
  const modelCounts = {};
  const providerUsage = {};

  for (const t of turns) {
    const modelId = t.m ?? null;
    if (modelId) modelCounts[modelId] = (modelCounts[modelId] || 0) + 1;
    cumInput += t.input;
    cumOutput += t.output;
    cumCache += t.cacheRead;
    cumReason += t.reasoning;
    const rawCost = calcTurnCost(t);
    const cost = rawCost ?? 0;
    cumCost += cost;
    const turnTotal = t.input + t.cacheRead + t.output + t.reasoning;
    const provider =
      t.p ?? PROVIDER_OF_MODEL[modelId] ?? "unknown";
    const bucket =
      providerUsage[provider] ||
      (providerUsage[provider] = {
        provider,
        turns: 0,
        tokens: 0,
        cost: 0,
        pricedTurns: 0,
        models: {},
        modelTokens: {},
      });
    bucket.turns += 1;
    bucket.tokens += turnTotal;
    bucket.cost += cost;
    if (rawCost != null) bucket.pricedTurns += 1;
    bucket.models[modelId] = (bucket.models[modelId] || 0) + 1;
    bucket.modelTokens[modelId] = (bucket.modelTokens[modelId] || 0) + turnTotal;

    series.push({
      i: series.length + 1,
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead,
      cacheInc: t.cacheRead,
      total: turnTotal,
      hit:
        t.hitRatio != null
          ? round(t.hitRatio * 100, 1)
          : t.missKnown && t.cacheRead + t.input > 0
            ? round((t.cacheRead / (t.cacheRead + t.input)) * 100, 1)
            : null,
      cost: round(cost, 6),
      cumTokens: cumInput + cumOutput + cumCache + cumReason,
      cumCost: round(cumCost, 4),
      ts: t.ts,
      m: modelId,
      p: provider,
    });
  }

  const dominant = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0];
  const dominantModel = dominant ? dominant[0] : last.m;
  const models = Object.entries(modelCounts).map(([m, cnt]) => ({
    model: m,
    turns: cnt,
    provider: PROVIDER_OF_MODEL[m] ?? null,
  }));
  const providers = Object.values(providerUsage).map((p) => ({
    provider: p.provider,
    turns: p.turns,
    tokens: p.tokens,
    cost: p.pricedTurns > 0 ? round(p.cost, 4) : null,
    costComplete: p.pricedTurns === p.turns,
    models: Object.entries(p.models).map(([model, turnsCount]) => ({
      model,
      turns: turnsCount,
      tokens: p.modelTokens[model] || 0,
    })),
  }));

  const modelMeta = context?.model ?? null;
  const contextWindow =
    num(modelMeta?.contextWindow) || CONTEXT_WINDOW[dominantModel] || 0;
  const contextTokens = num(context?.contextUsage?.tokens, last.input + last.cacheRead);
  const contextPercent = num(context?.contextUsage?.percent) ||
    (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);
  const compactThreshold = 0.8;

  let durationMinutes = null;
  const startMs = Date.parse(turns[0].ts ?? "");
  const endMs = Date.parse(last.ts ?? "");
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    durationMinutes = Math.max(0, Math.round((endMs - startMs) / 60000));
  }

  return {
    model: dominantModel,
    provider: providers[0]?.provider ?? PROVIDER_OF_MODEL[dominantModel] ?? null,
    models,
    providers,
    sessionId: context?.sessionId ?? null,
    contextWindow,
    contextPercent: Math.round(contextPercent * 10) / 10,
    lastWindowTokens: contextTokens,
    systemPromptTokens: estPromptTokens(context?.systemPrompt),
    compactThreshold,
    remainingToCompact: Math.max(0, contextWindow * compactThreshold - contextTokens),
    durationMinutes,
    turns: turns.length,
    sessionTokens: sumInput + sumOutput + sumCacheRead + sumReasoning,
    lastTurnTokens: last.input + last.cacheRead + last.output + last.reasoning,
    lastHitPercent: round(lastHit),
    avgHitPercent: round(avgHit),
    sumInput,
    sumOutput,
    sumCacheRead,
    sumCacheInc: sumCacheRead,
    sumCacheWrite,
    sumReasoning,
    sessionCostCny: cumCost == null ? null : round(cumCost, 4),
    lastCostCny: round(cumCost - (series[series.length - 2]?.cumCost ?? 0), 6),
    startTime: turns[0].ts,
    isStreaming: context?.isStreaming ?? null,
    thinkingLevel: context?.thinkingLevel ?? null,
    series: series.slice(-limitTurns),
  };
}

/** 会话文件基名：前端一直用「文件名」当会话标识，这里保持一致 */
export function baseName(value) {
  return String(value ?? "").split(/[\\/]/).pop() ?? "";
}

let sessionListCache = { at: 0, value: null };

/** 回退路径：账本窗口内没有这个会话时，直接解析会话文件（v1 的老做法）。
 *  需要 app/resources.read；拿不到内容时返回 null，由上层退回空壳。 */
export async function buildStatsFromSessionFile(sdk, sessionPath, limitTurns = 200) {
  if (!sessionPath) return null;
  try {
    const raw = await sdk.resources.read({ kind: "local-file", path: sessionPath });
    const c = raw?.content;
    // 宿主把文件内容回成字节（Uint8Array / 数字数组 / Buffer 的 JSON 形式），也可能直接给字符串
    const bytes =
      c instanceof Uint8Array
        ? c
        : Array.isArray(c)
          ? new Uint8Array(c)
          : c && c.type === "Buffer" && Array.isArray(c.data)
            ? new Uint8Array(c.data)
            : null;
    const content =
      typeof raw === "string"
        ? raw
        : raw instanceof Uint8Array
          ? new TextDecoder().decode(raw)
          : bytes
            ? new TextDecoder().decode(bytes)
            : typeof c === "string"
              ? c
              : typeof c?.text === "string"
                ? c.text
                : typeof c?.value === "string"
                  ? c.value
                  : typeof raw?.text === "string"
                    ? raw.text
                    : typeof raw?.data === "string"
                      ? raw.data
                      : "";
    if (!content) {
      const shape =
        raw == null
          ? "null"
          : typeof raw === "object"
            ? `keys=[${Object.keys(raw).join(",")}] content=${typeof raw.content}/${raw.content == null ? "null" : typeof raw.content === "string" ? raw.content.length : Array.isArray(raw.content) ? raw.content.length : Object.keys(raw.content).join("|")}`
            : typeof raw;
      try { await sdk.logger?.warn?.(`session-file fallback: empty content, raw ${shape}`); } catch {}
      return null;
    }
    const parsed = parseSession(content, limitTurns);
    if (!parsed) {
      try { await sdk.logger?.warn?.("session-file fallback: parseSession returned null"); } catch {}
      return null;
    }
    return { ...parsed, source: "session-file" };
  } catch (error) {
    try {
      await sdk.logger?.warn?.(
        `session-file fallback failed: ${error?.code ?? ""} ${String(error?.message || error)}`
      );
    } catch {}
    return null;
  }
}

/** 会话列表的短缓存：resolveSessionId 与 /api/stats 都要用，避免每次请求都扫全量会话。 */
export async function listSessionsCached(sdk, { lifecycle = "all", scope = "all", ttlMs = 15000 } = {}) {
  const now = Date.now();
  if (sessionListCache.value && now - sessionListCache.at < ttlMs) return sessionListCache.value;
  const value = await listSessions(sdk, { lifecycle, scope });
  sessionListCache = { at: now, value };
  return value;
}

/** 把前端传来的会话引用（sessionId 或文件名）解成稳定的 sessionId。
 *  fresh = true 时不走列表缓存：新建会话刚建好那几秒，缓存里还是旧列表，
 *  照缓存查会一直回「没这个会话」，面板就会把这个正常的空档报成请求失败。 */
export async function resolveSessionId(sdk, ref, { fresh = false } = {}) {
  if (!ref) return null;
  if (String(ref).startsWith("sess_")) return ref;
  const sessions = fresh ? await listSessions(sdk).catch(() => []) : await listSessionsCached(sdk);
  const hit = sessions.find((s) => s.name === ref || s.file === ref);
  return hit?.sessionId ?? null;
}

/** 会话列表（字段名与 v1 /api/sessions 对齐） */
export async function listSessions(sdk, { lifecycle = "all", scope = "all" } = {}) {
  const result = await sdk.sessions.list({ scope, lifecycle });
  return (result?.sessions ?? []).map((s) => ({
    id: s.sessionId,
    sessionId: s.sessionId,
    name: baseName(s.path),
    file: baseName(s.path),
    path: s.path ?? null,
    title: s.title ?? null,
    firstMessage: s.firstMessage ?? null,
    agentId: s.agentId ?? null,
    agentName: s.agentName ?? null,
    model: s.modelId ?? null,
    count: s.messageCount ?? null,
    messageCount: s.messageCount ?? null,
    cwd: s.cwd ?? null,
    modified: s.modified ?? null,
    mtime: s.modified ?? null,
    lifecycle: s.lifecycle ?? null,
    archived: s.lifecycle === "archived",
  }));
}

/** 全局账本（跨会话），按时间正序。历史用 since / until 时间窗分片拉取。 */
export async function fetchLedger(sdk, { since = null, until = null, limit = 1000 } = {}) {
  const filter = { limit };
  if (since) filter.since = since;
  if (until) filter.until = until;
  const result = await sdk.usage.list(filter);
  return (result?.entries ?? []).sort(
    (a, b) => Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0)
  );
}

export { canonProvider };
