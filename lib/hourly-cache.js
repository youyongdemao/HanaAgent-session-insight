// lib/hourly-cache.js —— 本地按小时聚合缓存（滚动保留 31 天）
//
// 为什么要有这个东西：
//   宿主的明细表（usage_entries）只保留最近 20000 条，大约覆盖 3 天；而宿主的按天汇总表
//   只有「天」这一个粒度。页面里「近 7 天 / 近 30 天」两档的桶一格只有 39 分钟 / 2.8 小时，
//   只靠宿主数据填不出来，之前是拿一天的量均摊进那天的每一格，于是同一格里数字一模一样。
//   这里只存「小时级聚合」，不存原始明细，用来把这两档填成真实的日内起伏。
//
// 存储与开销：
//   dataDir/ledger-hourly/YYYY-MM-DD.jsonl，一天最多 24 行、约 2.4KB；
//   已结束的小时只追加一行，当前小时只留在内存（它还在长），所以每小时写入约 100 字节。
//   整天的文件超出保留窗口就整个删掉。读盘只在首次装载（31 天合计约 75KB）。
//
// 正确性要点：
//   已落盘的小时以文件为准，不再被后续的明细重算覆盖。因为宿主的明细窗口是滚动的，
//   一小时后明细里那个小时可能已经缺了部分数据，重算会把完整值改小。

import { readFileSync, appendFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const KEEP_DAYS = 31; // 覆盖「近 30 天」档的窗口，多留一天避开边界
const HOUR_MS = 3600e3;
const DAY_MS = 86400e3;

const mem = { loaded: false, dir: "", days: new Map(), flushed: new Map() };

function fmtDay(ts) {
  const t = typeof ts === "number" ? ts : Date.parse(ts || "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dayStartMs(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  if (!y || !m || !d) return NaN;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
function hourEndsAt(day, hour) {
  const [y, m, d] = String(day).split("-").map(Number);
  if (!y || !m || !d) return NaN;
  return new Date(y, m - 1, d, hour + 1, 0, 0, 0).getTime();
}
function dirOf(ctx) { return join(ctx?.dataDir || "", "ledger-hourly"); }
function fileOf(dir, day) { return join(dir, day + ".jsonl"); }

/** 首次装载：把落盘的 31 天（约 75KB）读进内存，之后只走内存与追加写 */
function ensureLoaded(ctx) {
  const dir = dirOf(ctx);
  if (!ctx?.dataDir) return false;
  if (mem.loaded && mem.dir === dir) return true;
  mem.days = new Map();
  mem.flushed = new Map();
  mem.dir = dir;
  mem.loaded = true;
  try {
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); return true; }
    for (const f of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const day = f.slice(0, 10);
      const arr = new Array(24).fill(null);
      const set = new Set();
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const h = Number(o.h);
        if (!Number.isInteger(h) || h < 0 || h > 23) continue;
        arr[h] = { t: Number(o.t) || 0, c: Number(o.c) || 0, hit: Number(o.hit) || 0, miss: Number(o.miss) || 0, n: Number(o.n) || 0 };
        set.add(h);
      }
      mem.days.set(day, arr);
      mem.flushed.set(day, set);
    }
  } catch { /* 读不到就当空缓存，不影响主流程 */ }
  return true;
}

/** 把明细按「本地小时」聚合成 day -> Array(24)，字段口径与主统计保持一致 */
function aggregate(entries, missOf) {
  const byDay = new Map();
  for (const e of entries) {
    const ts = Date.parse(e?.startedAt || "");
    if (!Number.isFinite(ts)) continue;
    const day = fmtDay(ts);
    if (!day) continue;
    const hour = new Date(ts).getHours();
    let arr = byDay.get(day);
    if (!arr) byDay.set(day, arr = new Array(24).fill(null));
    let b = arr[hour];
    if (!b) arr[hour] = b = { t: 0, c: 0, hit: 0, miss: 0, n: 0 };
    const u = e.usage || {};
    const inTot = u.input?.totalTokens ?? u.input?.uncachedTokens ?? 0;
    const miss = missOf(u) ?? inTot;
    const hit = u.cache?.readTokens != null ? u.cache.readTokens : Math.max(0, inTot - miss);
    b.t += u.totalTokens || (inTot + (u.output?.totalTokens ?? 0));
    b.c += Number(e.__siCost) || 0; // 费用复用主统计那一遍算好的值，不在这里重算
    b.hit += hit;
    b.miss += miss;
    b.n += 1;
  }
  return byDay;
}

/**
 * 有新的明细就更新缓存。
 * 返回是否有新的完整小时落盘。
 */
export function updateHourlyCache(ctx, entries, nowMs, missOf) {
  if (!ensureLoaded(ctx) || !Array.isArray(entries) || !entries.length) return false;
  const dir = mem.dir;
  let wrote = false;
  try {
    const agg = aggregate(entries, missOf);
    for (const [day, buckets] of agg) {
      let arr = mem.days.get(day);
      if (!arr) mem.days.set(day, arr = new Array(24).fill(null));
      let set = mem.flushed.get(day);
      if (!set) mem.flushed.set(day, set = new Set());
      for (let h = 0; h < 24; h++) {
        const b = buckets[h];
        if (!b) continue;
        if (set.has(h)) continue;             // 已落盘，以文件为准
        arr[h] = b;
        if (hourEndsAt(day, h) + 120e3 <= nowMs) {    // 这一小时结束且过了 2 分钟确认期，可以落盘了
          try {
            appendFileSync(fileOf(dir, day), JSON.stringify({ h, t: Math.round(b.t), c: Math.round(b.c * 1e6) / 1e6, hit: Math.round(b.hit), miss: Math.round(b.miss), n: b.n }) + "\n");
            set.add(h);
            wrote = true;
          } catch { /* 写不进去也不影响本次统计 */ }
        }
      }
    }
    prune(nowMs);
  } catch { /* 缓存失败不能影响统计主流程 */ }
  return wrote;
}

/** 滚动保留：整天文件过期就整个删掉 */
function prune(nowMs) {
  const cutoff = fmtDay(nowMs - (KEEP_DAYS - 1) * DAY_MS);
  for (const day of [...mem.days.keys()]) {
    if (day >= cutoff) continue;
    mem.days.delete(day);
    mem.flushed.delete(day);
    try { rmSync(fileOf(mem.dir, day), { force: true }); } catch { /* 删不掉下次再来 */ }
  }
}

/** 汇总 [t0, t1) 区间内的小时桶（按重叠比例），供填「近 7 天 / 近 30 天」的格子 */
export function sumHoursInRange(ctx, t0, t1) {
  if (!ensureLoaded(ctx)) return null;
  let tokens = 0, cost = 0, hit = 0, miss = 0, calls = 0, hitAny = false;
  for (const [day, arr] of mem.days) {
    if (!arr) continue;
    const ds = dayStartMs(day);
    if (!Number.isFinite(ds) || ds + DAY_MS <= t0 || ds >= t1) continue;
    for (let h = 0; h < 24; h++) {
      const b = arr[h];
      if (!b) continue;
      const hs = ds + h * HOUR_MS;
      const ov = Math.min(t1, hs + HOUR_MS) - Math.max(t0, hs);
      if (ov <= 0) continue;
      const w = ov / HOUR_MS;
      tokens += b.t * w;
      cost += b.c * w;
      hit += b.hit * w;
      miss += b.miss * w;
      calls += b.n * w;
      hitAny = true;
    }
  }
  return hitAny ? { tokens, cost, hit, miss, calls } : null;
}

/** 当前缓存覆盖的日期（供诊断） */
export function hourlyCacheDays(ctx) {
  ensureLoaded(ctx);
  return [...mem.days.keys()].sort();
}
