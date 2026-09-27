// lib/today-live.js —— 「今天」的实时累计
//
// 为什么需要它：
//   宿主那张按天汇总表（usage_daily_rollups）实测是每 30~45 秒才批量写一批，
//   所以「总消耗」这类数字想每秒都在涨，就只能改用逐条实时写入的明细。
//
// 怎么保证算准（这是关键）：
//   基准：每轮全量明细（复用已有的 30 秒缓存）算出「今天的准确值」和「覆盖到的时间戳」。
//   增量：每秒拉最近一小批明细，只累加时间戳在基准之后的新条目。
//   对齐：每次基准刷新都会把增量清零重来，所以偶发的漏算/多算最多存在 30 秒，
//        不会累积。
//
// 去重：时间戳单调 + 最近若干条 request id 的集合（防同一毫秒的边界重复）。

const RECENT_LIMIT = 30;   // 每次只拉最近这么多条
// 目标频率：既要看起来实时，又不能把宿主查询打得太密（每次只是取最近 30 条，但毕竟是个 RPC）
const THROTTLE_MS = 1500;
const SEEN_MAX = 300;

const state = {
  day: "",
  base: null,        // 基准：今天的准确值
  baseTs: 0,         // 基准覆盖到的时间戳
  acc: null,         // 基准之后累加出来的增量
  seen: new Set(),
  at: 0,
  busy: false,
};

function fmtDay(ts) {
  const t = typeof ts === "number" ? ts : Date.parse(ts || "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function zero() { return { t: 0, c: 0, hit: 0, miss: 0, n: 0 }; }
function reset(day) {
  state.day = day;
  state.base = null;
  state.baseTs = 0;
  state.acc = zero();
  state.seen.clear();
}
function add(acc, e, costOf, missOf) {
  const u = e?.usage || {};
  const inTot = u.input?.totalTokens ?? u.input?.uncachedTokens ?? 0;
  const miss = missOf(u) ?? inTot;
  const hit = u.cache?.readTokens != null ? u.cache.readTokens : Math.max(0, inTot - miss);
  acc.t += u.totalTokens || (inTot + (u.output?.totalTokens ?? 0));
  acc.c += (typeof costOf === "function" ? Number(costOf(e)) || 0 : 0);
  acc.hit += hit;
  acc.miss += miss;
  acc.n += 1;
}

/**
 * 用一轮全量明细重设基准。由 computeLedgerStats 每轮调用，
 * 它会从这一整批里挑出今天的条目累加，并记下覆盖到的时间戳。
 */
export function acceptBase(entries, todayKey, costOf, missOf) {
  if (!Array.isArray(entries) || !entries.length || !todayKey) return;
  if (state.day !== todayKey) reset(todayKey);
  const base = zero();
  let maxTs = 0;
  for (const e of entries) {
    const ts = Date.parse(e?.startedAt || "");
    if (!Number.isFinite(ts) || fmtDay(ts) !== todayKey) continue;
    add(base, e, costOf, missOf);
    if (ts > maxTs) maxTs = ts;
  }
  state.base = base;
  state.baseTs = maxTs;
  state.acc = zero();     // 基准刷新，增量从零重来（这是防误差累积的关键）
  state.seen.clear();
}

/**
 * 拉最近一小批明细，把基准之后的新条目累加进来。内部约每秒一次。
 */
export async function pollToday(sdk, todayKey, costOf, missOf) {
  if (!todayKey) return null;
  if (state.day !== todayKey) reset(todayKey);
  const now = Date.now();
  if (state.busy || now - state.at < THROTTLE_MS) return todayTotals();
  state.at = now;
  state.busy = true;
  try {
    const r = await sdk.usage.list({ limit: RECENT_LIMIT });
    const list = r?.entries ?? [];
    let maxTs = state.baseTs;
    for (const e of list) {
      const ts = Date.parse(e?.startedAt || "");
      if (!Number.isFinite(ts)) continue;
      if (ts > maxTs) maxTs = ts;
      if (ts <= state.baseTs) continue;               // 基准已覆盖，跳过
      if (fmtDay(ts) !== todayKey) continue;
      const id = String(e?.requestId || e?.id || "");
      if (id && state.seen.has(id)) continue;
      if (id) {
        state.seen.add(id);
        if (state.seen.size > SEEN_MAX) {
          const first = state.seen.values().next().value;
          state.seen.delete(first);
        }
      }
      add(state.acc || (state.acc = zero()), e, costOf, missOf);
    }
    if (maxTs > state.baseTs) state.baseTs = maxTs;
  } catch { /* 拉不到就先用已有值，不打扰主流程 */ } finally {
    state.busy = false;
  }
  return todayTotals();
}

/** 今天的实时合计（基准 + 增量）。基准还没建立时返回 null。 */
export function todayTotals() {
  if (!state.base) return null;
  const a = state.acc || zero();
  const b = state.base;
  return {
    t: b.t + a.t,
    c: b.c + a.c,
    hit: b.hit + a.hit,
    miss: b.miss + a.miss,
    n: b.n + a.n,
    baseTs: state.baseTs,
  };
}

/** 诊断用 */
export function todayLiveDays() { return state.day; }
