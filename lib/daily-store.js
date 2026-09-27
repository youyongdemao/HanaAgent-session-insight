// lib/daily-store.js —— 本地「每日永久库」：一天一行，永不删除
//
// 为什么要有它：
//   hero 上的总值（总 token / 总费用 / 总调用数）原来直接取宿主账本的汇总表，
//   宿主一旦清理旧数据，这个数就跟着缩水。这里把宿主能提供的历史灌进来当基线，
//   之后只增不减，总值不再受宿主窗口影响。
//
// 与「按小时缓存」的分工：
//   按小时缓存滚动保留 31 天，用来填「近 7 天 / 近 30 天」两档的格子；
//   这份是永久保留，只用来算总值。
//
// 存储与开销：
//   dataDir/ledger-daily/YYYY-MM.jsonl，一天一行、约 100 字节，一年约 36KB。
//   只有「已经结束的天」才落盘（追加一行）；当天只留在内存，跨天时定稿。
//   历史天写完就不再改动，所以正常运行时每天的写入量就是一行。

import { readFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const mem = { loaded: false, dir: "", days: new Map(), flushed: new Set() };

function fmtDay(ts) {
  const t = typeof ts === "number" ? ts : Date.parse(ts || "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dirOf(ctx) { return join(ctx?.dataDir || "", "ledger-daily"); }
function fileOf(dir, day) { return join(dir, day.slice(0, 7) + ".jsonl"); }

function ensureLoaded(ctx) {
  const dir = dirOf(ctx);
  if (!ctx?.dataDir) return false;
  if (mem.loaded && mem.dir === dir) return true;
  mem.days = new Map();
  mem.flushed = new Set();
  mem.dir = dir;
  mem.loaded = true;
  try {
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); return true; }
    for (const f of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}\.jsonl$/.test(f)) continue;
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const d = String(o.d || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        mem.days.set(d, { t: Number(o.t) || 0, c: Number(o.c) || 0, hit: Number(o.hit) || 0, miss: Number(o.miss) || 0, n: Number(o.n) || 0 });
        mem.flushed.add(d);
      }
    }
  } catch { /* 读不到就当空库，不影响主流程 */ }
  return true;
}

/**
 * 把宿主汇总里的按天数据并进永久库。
 * dayRows: Map<YYYY-MM-DD, {t,c,hit,miss,n}>
 * todayKey: 今天的日期键，当天只更新内存、不落盘（它还在涨，等跨天再定稿）。
 */
export function ingestDays(ctx, dayRows, todayKey) {
  if (!ensureLoaded(ctx) || !dayRows || !dayRows.size) return 0;
  let wrote = 0;
  try {
    let touched = false;
    for (const [day, row] of dayRows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (day > todayKey) continue;
      const cur = mem.days.get(day);
      if (day === todayKey) {
        // 当天：只留内存，值允许随汇总变化
        mem.days.set(day, row);
        touched = true;
        continue;
      }
      if (cur) continue; // 历史天一旦写入就不再改动，保证只增不减
      mem.days.set(day, row);
      touched = true;
      if (!mem.flushed.has(day)) {
        try {
          appendFileSync(fileOf(mem.dir, day), JSON.stringify({ d: day, t: Math.round(row.t), c: Math.round(row.c * 1e6) / 1e6, hit: Math.round(row.hit), miss: Math.round(row.miss), n: Math.round(row.n) }) + "\n");
          mem.flushed.add(day);
          wrote++;
        } catch { /* 写不进去也不影响本次统计 */ }
      }
    }
    // 跨天定稿：内存里出现过的、已经过去的、还没落盘的天，补写一次
    for (const [day, row] of mem.days) {
      if (day >= todayKey || mem.flushed.has(day)) continue;
      try {
        appendFileSync(fileOf(mem.dir, day), JSON.stringify({ d: day, t: Math.round(row.t), c: Math.round(row.c * 1e6) / 1e6, hit: Math.round(row.hit), miss: Math.round(row.miss), n: Math.round(row.n) }) + "\n");
        mem.flushed.add(day);
        wrote++;
      } catch { /* 同上 */ }
    }
    return touched ? wrote : wrote;
  } catch {
    return wrote;
  }
}

/** 永久累计：所有天的和。days 是有多少天，供界面说明覆盖范围。 */
export function dailyTotals(ctx) {
  if (!ensureLoaded(ctx) || !mem.days.size) return null;
  let tokens = 0, cost = 0, hit = 0, miss = 0, calls = 0;
  let first = null, last = null, lastRow = null;
  for (const [day, row] of mem.days) {
    tokens += row.t; cost += row.c; hit += row.hit; miss += row.miss; calls += row.n;
    if (!first || day < first) first = day;
    if (!last || day > last) { last = day; lastRow = row; }
  }
  if (calls <= 0 && tokens <= 0) return null;
  // today 单独给出：hero 要用「历史（不含今天）+ 今天的实时值」拼总数
  return { tokens, cost, hit, miss, calls, days: mem.days.size, firstDay: first, lastDay: last, today: lastRow, todayKey: last };
}

/** 库里的天（供诊断） */
export function dailyDays(ctx) {
  ensureLoaded(ctx);
  return [...mem.days.keys()].sort();
}
