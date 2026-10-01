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
const usageInflight = new Map();
const contextCache = new Map();
const contextInflight = new Map();

/** 给宿主的 RPC 套一个硬上限：到点就算这轮没拿到（resolve null）。
 *  底层那次调用不会被取消，跑完成功了照样回填缓存，所以下一轮多半能直接命中。
 *  为什么非要有这个：session:context / usage:list 实测单次 6～63 秒（宿主一边跑模型一边排队），
 *  而面板的请求预算只有 4～8 秒，不设上限等于每一次都会撞穿客户端的超时。 */
function withDeadline(promise, ms) {
  if (!(ms > 0)) return promise;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), ms);
    promise.then(finish, () => finish(null));
  });
}

/** 拉一个会话的全部用量条目（按时间正序）。
 *  注意：宿主的 usage:list 过滤器当前不接受 cursor，返回的 nextCursor 也恒为 null，
 *  所以历史只能靠 since / until 时间窗分片。单会话量级（数百条）一次 limit 足够。
 *  timeoutMs > 0 时给这次读一个上限：等不到就把上一次的好值还回去，
 *  避免宿主一停顿就把「本会话 Token / 费用」从真值掉到 0。 */
export async function fetchSessionUsage(sdk, sessionId, { limit = 1000, ttlMs = 5000, timeoutMs = 0 } = {}) {
  const now = Date.now();
  const cached = usageCache.get(sessionId);
  if (cached && now - cached.at < ttlMs) return cached.value;
  let pending = usageInflight.get(sessionId);
  if (!pending) {
    pending = sdk.usage
      .list({ sessionId, limit })
      .then((result) => {
        const value = (result?.entries ?? [])
          .filter(isSessionRequest)
          .sort((a, b) => Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0));
        usageCache.set(sessionId, { at: Date.now(), value });
        if (usageCache.size > 60) {
          for (const key of [...usageCache.keys()].slice(0, 20)) usageCache.delete(key);
        }
        return value;
      })
      .finally(() => usageInflight.delete(sessionId));
    usageInflight.set(sessionId, pending);
  }
  const fresh = await withDeadline(pending.catch(() => null), timeoutMs);
  if (fresh) return fresh;
  return cached?.value ?? [];
}

/** 会话上下文（上下文窗口 / 占用占比 / 是否在流 / 模型元信息）。
 *  这是本机实测最慢的一条宿主 RPC（最长量到 28 秒，慢路径画像里 60 秒那种基本都挂在它身上）。
 *  它变化很慢（只在轮次增长或压缩时动），所以给 TTL 缓存 + 单飞 + 超时兜底：
 *  卡住时把上一次的值还回去。面板宁可显示略旧的上下文，也不要整块归零。 */
export async function fetchSessionContext(sdk, sessionId, { ttlMs = 15000, timeoutMs = 6000 } = {}) {
  const now = Date.now();
  const cached = contextCache.get(sessionId);
  if (cached && now - cached.at < ttlMs) return cached.value;
  let pending = contextInflight.get(sessionId);
  if (!pending) {
    pending = sdk.sessions
      .context({ sessionId, scope: "all" })
      .then((value) => {
        if (value) {
          // 这个 Map 原来没有上限：用户每看一个新会话就多一条，只增不减。
          // 加上限，淘汰方式和 usageCache 保持一致。
          if (contextCache.size >= 60) {
            for (const key of [...contextCache.keys()].slice(0, 20)) contextCache.delete(key);
          }
          contextCache.set(sessionId, { at: Date.now(), value });
        }
        return value;
      })
      .catch(() => null)
      .finally(() => contextInflight.delete(sessionId));
    contextInflight.set(sessionId, pending);
  }
  const fresh = await withDeadline(pending, timeoutMs);
  return fresh ?? cached?.value ?? null;
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

// 按「生命周期 + 范围」分键；新鲜度由每个调用方自己声明（见 listSessionsCached）
const sessionListCache = new Map();
const sessionListInflight = new Map();

/** 回退路径：账本窗口内没有这个会话时，直接解析会话文件（v1 的老做法）。
 *  需要 app/resources.read；拿不到内容时返回 null，由上层退回空壳。
 *
 *  这里按「路径 + 修改时间」缓存解析结果：宿主的明细窗口只覆盖最近一段，窗口外的会话
 *  每个请求都要整份读盘并逐行解析（几 MB，且是同步 CPU），审计日志里同一个文件被读过上百次。
 *  文件刚改过（5 分钟内）就不缓存，避开正在写的会话给出过期统计。 */
const sessionFileStatsCache = new Map();
const SESSION_FILE_CACHE_MAX = 40;
const SESSION_FILE_STABLE_MS = 5 * 60e3;

export async function buildStatsFromSessionFile(sdk, sessionPath, limitTurns = 200, mtimeMs = 0) {
  if (!sessionPath) return null;
  const m = Number(mtimeMs) || 0;
  const cacheKey = m > 0 && Date.now() - m > SESSION_FILE_STABLE_MS ? `${sessionPath}|${m}|${limitTurns}` : "";
  if (cacheKey) {
    const cached = sessionFileStatsCache.get(cacheKey);
    if (cached) return { ...cached }; // 浅拷贝：上层会往上写 file / sessionId / title
  }
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
    const result = { ...parsed, source: "session-file" };
    if (cacheKey) {
      if (sessionFileStatsCache.size >= SESSION_FILE_CACHE_MAX) {
        const oldest = sessionFileStatsCache.keys().next().value;
        if (oldest !== undefined) sessionFileStatsCache.delete(oldest);
      }
      sessionFileStatsCache.set(cacheKey, result);
    }
    return { ...result };
  } catch (error) {
    try {
      await sdk.logger?.warn?.(
        `session-file fallback failed: ${error?.code ?? ""} ${String(error?.message || error)}`
      );
    } catch {}
    return null;
  }
}

/** 会话列表的短缓存：resolveSessionId 与 /api/stats 都要用，避免每次请求都扫全量会话。
 *
 *  除了 TTL，这里还做两件事，针对的是同一个坑：宿主的 session:list 是整目录全量枚举，
 *  本机实测 2.2～5 秒；而面板一次加载会并发七八条请求。缓存一过期的瞬间，七八条请求同时
 *  miss、各自打一遍枚举，宿主主进程被压住，排在后面的请求一起撞客户端的 8 秒超时。
 *  ① 单飞：同一个 key 的并发 miss 合并成一次枚举，谁先到谁发起，其余等同一个 promise。
 *  ② 过期宽限（staleMs）：TTL 过了但还在宽限期内，先把旧列表还回去，后台默默刷一次。
 *     会话列表的用途是「文件名 ↔ sessionId」映射和下拉列表，晚几十秒无害；
 *     真需要最新列表的调用方（新建会话那几秒）传 force:true 绕开缓存，但仍与单飞共享。
 *  新鲜度由调用方声明，不再由先到的那次写入定格：/api/sessions 要 30 秒档，
 *  resolveSessionId 要 2 分钟档，互不牵扯。 */
export async function listSessionsCached(
  sdk,
  { lifecycle = "all", scope = "all", ttlMs = 15000, staleMs = 0, force = false } = {}
) {
  const now = Date.now();
  const key = `${scope}`;
  const hit = sessionListCache.get(key);
  if (!force && hit) {
    const age = now - hit.at;
    if (age < ttlMs) return pickLifecycle(hit.value, lifecycle);
    if (staleMs > 0 && age < staleMs) {
      // 后台刷新：不 await，异常在这里吃掉；调用方拿的是上一次的好值
      refreshSessionList(sdk, key, scope).catch(() => {});
      return pickLifecycle(hit.value, lifecycle);
    }
  }
  return pickLifecycle(await refreshSessionList(sdk, key, scope), lifecycle);
}

/** 缓存里存的永远是未过滤的全量列表，lifecycle 在返回时再筛；
 *  否则先到的那次调用会把一个子集写进共享缓存。 */
function pickLifecycle(list, lifecycle) {
  const arr = Array.isArray(list) ? list : [];
  if (lifecycle === "active") return arr.filter((s) => !s.archived);
  if (lifecycle === "archived") return arr.filter((s) => s.archived);
  return arr;
}

/** 真正发一次全量枚举。同一个 key 的并发调用共享同一个 promise（单飞）。 */
function refreshSessionList(sdk, key, scope) {
  let pending = sessionListInflight.get(key);
  if (!pending) {
    pending = listSessions(sdk, { scope, lifecycle: "all" })
      .then((value) => {
        if (sessionListCache.size >= 8) sessionListCache.clear();
        sessionListCache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => sessionListInflight.delete(key));
    sessionListInflight.set(key, pending);
  }
  return pending;
}

/** 把前端传来的会话引用（sessionId 或文件名）解成稳定的 sessionId。
 *  fresh = true 时不走列表缓存：新建会话刚建好那几秒，缓存里还是旧列表，
 *  照缓存查会一直回「没这个会话」，面板就会把这个正常的空档报成请求失败。 */
export async function resolveSessionId(sdk, ref, { fresh = false, timeoutMs = 2500 } = {}) {
  if (!ref) return null;
  if (String(ref).startsWith("sess_")) return ref;
  // 列会话是宿主的全量枚举，实测偶发要 4~5 秒。这里给它一个上限，超时就算“没解析出来”
  // （调用方都有兜底），别把整条请求拖到前端超时 —— widget 的 ?fast=1 预算只有 4 秒。
  // 解析这条路径容忍更旧的会话列表缓存（2 分钟）：新会话的识别由 fresh 那条路负责。
  // fresh 那条路也走同一个单飞：新建会话时前端会连着几条请求一起问，
  // 分开发就是同一份全量枚举跑几遍。宽限期给 10 分钟：命不中会退到 fresh 再查一次，
  // 而那一次会把共享缓存一起刷新，所以不会反复重来。
  const load = fresh
    ? listSessionsCached(sdk, { force: true }).catch(() => [])
    : listSessionsCached(sdk, { ttlMs: 120000, staleMs: 600000 });
  const sessions = await Promise.race([
    load,
    new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs)),
  ]);
  const hit = sessions.find((s) => s.name === ref || s.file === ref);
  return hit?.sessionId ?? null;
}

/** 会话列表（字段名与 v1 /api/sessions 对齐）。
 *  向宿主要永远只要 all，再在本地按 lifecycle 过滤：宿主的枚举是全目录扫描，
 *  按 lifecycle 各要一次等于把同一份扫描做两遍（面板冷加载时 /api/stats 与 /api/sessions
 *  就是这么撞在一起的，各拿一个缓存键、各打一次枚举）。
 *  过滤依据是宿主返回的 lifecycle，它只有 active / archived 两种值。 */
export async function listSessions(sdk, { lifecycle = "all", scope = "all" } = {}) {
  const result = await sdk.sessions.list({ scope, lifecycle: "all" });
  const all = (result?.sessions ?? []).map((s) => ({
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
  if (lifecycle === "active") return all.filter((s) => !s.archived);
  if (lifecycle === "archived") return all.filter((s) => s.archived);
  return all;
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
