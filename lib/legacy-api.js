// routes/api.js — 会话统计 / 会话列表 / 多供应商余额
import { readFileSync, statSync, existsSync, appendFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { PROVIDER_OF_MODEL, PRICING, priceFor, calcCost, isPeakHour, SOURCE_NOTE, PRICING_SNAPSHOT_AT, setPricingConfig, missInputOf } from "../lib/usage-parser.js";
import { PROVIDER_DIRECTORY, launchSummary, billingModeOf } from "../lib/provider-directory.js";
import { updateHourlyCache, sumHoursInRange } from "../lib/hourly-cache.js";
import { ingestDays, dailyTotals } from "../lib/daily-store.js";

let debugLogPath = null;
function dbg(msg) {
  try {
    if (!debugLogPath) return;
    appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/** 异常专用日志：只记「出了问题的轮次」和前端上报的失败，不混进调试日志。
 *  界面上的弹窗只留一句短话，具体的哪一家、哪一步、卡了多久全写在这里。 */
let diagLogPath = null;
/** 内存里也留一份最近的诊断，供面板「日志」区直接展示（不用去翻文件）。 */
let diagEvents = [];
function diagLog(msg, short) {
  try {
    if (diagLogPath) appendFileSync(diagLogPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
  try {
    diagEvents.push({ at: Date.now(), text: String(short || msg).slice(0, 200) });
    if (diagEvents.length > 100) diagEvents.splice(0, diagEvents.length - 100);
  } catch {}
}

/** 把一步的定位渲染成人能读的短标记：openai-codex=budget(6000ms) */
function fmtStep(step) {
  const detail = step?.detail ? `(${String(step.detail).slice(0, 80)})` : "";
  return `${step?.step || "?"}=${step?.status || "?"}${detail}(${step?.ms ?? 0}ms)`;
}

// 日界/小时界跟随系统本地时区，与前端显示同源（用户看到的就是本机时间）。
// 此前直接用 startedAt 的 ISO 串前 10/13 个字符切分，等价于 UTC 日，而前端「今日」用的是本地时区，
// 两端不一致会让凌晨的调用归错天；现在两端统一按本地时区。
// 未命中输入统一走 usage-parser 的 missInputOf（口径单一来源）
const missOf = missInputOf;

function fmtDay(ts) {
  const t = typeof ts === "number" ? ts : Date.parse(ts || "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// YYYY-MM-DDTHH（本地时区；键形状与旧的 UTC 小时键保持一致）
function fmtHour(ts) {
  const t = typeof ts === "number" ? ts : Date.parse(ts || "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}`;
}

// 用量总账（总消费数据源）
let ledgerCache = { at: 0, totalCost: 0, perProvider: {}, perModel: {} };

// 单条 ledger entry 的费用。宿主的 usage 口径（已按账本逐字段核对）：
//   totalTokens = input.totalTokens + output.totalTokens + cache.readTokens
// 也就是 input.totalTokens 是「未命中输入」，缓存命中量单列在 cache.readTokens。
// 官方扣费 = token 消耗量 × 单价，缓存命中的那部分每次请求都要按命中价收，
// 所以必须单独把 cache.readTokens 计入；此前用 input.totalTokens 减未命中量，
// 而那个值本身就等于未命中量，命中那一大块（往往占输入 99%）等于一个钱没算。
// 缓存写入（Anthropic 系有溢价，价档里的 cacheWrite）单列；没有该档的按未命中价。
export function calcEntryCost(e) {
  const model = e?.model?.modelId;
  const provider = e?.model?.provider;
  // 订阅额度与免费/本地的用量不进金额：钱花在包月上，或本来就不花钱
  if (billingModeOf(provider, e?.model?.baseUrl) !== "metered") return 0;
  const p = priceFor(model, e?.startedAt, provider);
  if (!p) return null;
  const u = e.usage || {};
  const inp = u.input || {};
  const cache = u.cache || {};
  const out = u.output || {};
  const miss = Number(inp.uncachedTokens ?? inp.totalTokens ?? 0);
  const hit = Number(cache.readTokens ?? 0);
  const write = Number(cache.writeTokens ?? 0);
  const output = Number(out.totalTokens ?? 0) + Number(out.reasoningTokens ?? 0);
  return (
    (miss / 1e6) * p.inputMiss +
    (hit / 1e6) * p.inputHit +
    (write / 1e6) * (p.cacheWrite ?? p.inputMiss) +
    (output / 1e6) * p.output
  );
}


async function computeTotalCost(ctx, minTtlMs) {
  const now = Date.now();
  if (now - ledgerCache.at < (minTtlMs ?? 10000)) return ledgerCache;
  try {
    const { entries: ledgerEntries } = await readLedgerEntries(ctx, minTtlMs);
    if (!ledgerEntries.length) return { at: now, totalCost: null, perProvider: {}, perModel: {}, todayCost: 0, todayProvider: {}, todayModel: {} };
    let totalCost = 0;
    const perProvider = {};
    const perModel = {};
    const todayProvider = {};
    const todayModel = {};
    const todayStr = fmtDay(Date.now());
    let todayCost = 0;
    // 明细是宿主裁剪后的一段，它最早那天往往从当天中途才开始，而汇总是一整天，
    // 两者既重叠又互补：边界天整天地交给汇总，免得漏掉当天前半段。
    let coveredFrom = null;
    for (const e of ledgerEntries) {
      const d = e?.startedAt ? fmtDay(e.startedAt) : null;
      if (d && (coveredFrom === null || d < coveredFrom)) coveredFrom = d;
    }
    const boundaryDay = coveredFrom === todayStr ? null : coveredFrom; // 只有一天数据时不能把「今日」让出去
    for (const e of ledgerEntries) {
      const model = e.model?.modelId;
      const provider = e.model?.provider;
      const cost = calcEntryCost(e);
      if (cost == null) continue;
      const day = e.startedAt ? fmtDay(e.startedAt) : null;
      if (boundaryDay == null || day !== boundaryDay) {
        totalCost += cost;
        if (provider) perProvider[provider] = (perProvider[provider] || 0) + cost;
        if (model) perModel[model] = (perModel[model] || 0) + cost;
      }
      if (day === todayStr) {
        todayCost += cost;
        if (provider) todayProvider[provider] = (todayProvider[provider] || 0) + cost;
        if (model) todayModel[model] = (todayModel[model] || 0) + cost;
      }
    }
    // 更早的历史只能靠宿主的按天汇总补上。
    // 不补的话「总消耗」实际只是最近几天的量，而旁边的总 token 是全量的，两边对不上。
    const share = weekdayPeakShare(ledgerEntries);
    let historyCost = 0;
    try {
      const rollups = await readHostDailyRollups(ctx);
      if (rollups?.length) {
        for (const r of rollups) {
          if (!r.d || (boundaryDay != null && r.d > boundaryDay)) continue;
          const c = rollupRowCost(r, share);
          if (c == null) continue;
          historyCost += c;
          if (r.p) perProvider[r.p] = (perProvider[r.p] || 0) + c;
          if (r.m) perModel[r.m] = (perModel[r.m] || 0) + c;
        }
      }
    } catch (e) { dbg("total-cost history ERROR: " + String(e?.message || e)); }
    totalCost += historyCost;
    ledgerCache = {
      at: now,
      totalCost: Math.round(totalCost * 100) / 100,
      historyCost: Math.round(historyCost * 100) / 100,
      coveredFrom,
      todayCost: Math.round(todayCost * 100) / 100,
      todayProvider: Object.fromEntries(Object.entries(todayProvider).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      todayModel: Object.fromEntries(Object.entries(todayModel).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      perProvider: Object.fromEntries(Object.entries(perProvider).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      perModel: Object.fromEntries(Object.entries(perModel).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    };
  } catch (e) {
    dbg("total-cost ERROR: " + String(e?.message || e));
  }
  return ledgerCache;
}



let ledgerStatsCache = { at: 0, provider: null };

// 全局用量总览：按 agent/来源/日期/模型聚合 + 延迟分布 + 错误数（30s 缓存）
// provider 可选：传入则只统计该供应商的数据
async function computeLedgerStats(ctx, provider, minTtlMs) {
  const now = Date.now();
    if (now - ledgerStatsCache.at < (minTtlMs ?? 10000) && ledgerStatsCache.provider === provider) return ledgerStatsCache;
  try {
    const { entries: ledgerEntries } = await readLedgerEntries(ctx, minTtlMs);
    if (!ledgerEntries.length) return { at: now, empty: true, provider };
    const byAgent = {}, bySubsystem = {}, byDay = {}, byModel = {}, byProvider = {}, rangeProv = { hour: {}, d7: {}, d30: {}, day: {}, week: {} }, rangeModel = { hour: {}, d7: {}, d30: {}, day: {}, week: {} }, latBuckets = { lt1: 0, "1_3": 0, "3_10": 0, gt10: 0 }, byStatus = {}, bySession = {}, byHour = {};
    const latAll = [];
    const timeCosts = [];
    const timeCache = [];
    let callCount = 0, errCount = 0, tokInput = 0, tokOutput = 0, tokCacheHit = 0, tokCacheMiss = 0, tokTotal = 0;
    const billingModes = {}, provWindows = {};
    for (const e of ledgerEntries) {
      if (provider && e.model?.provider !== provider) continue; // 按供应商过滤
      const cost = calcEntryCost(e);
      const cc = cost || 0;
      e.__siCost = cc; // 按小时聚合缓存复用这一遍的结果，避免再算一次
      const tsCost = Date.parse(e.startedAt || "");
      if (Number.isFinite(tsCost)) timeCosts.push({ ts: tsCost, cost: cc, tokens: e.usage?.totalTokens || 0 });
      callCount++;
      // agent 归属
      const agent = e.attribution?.agentId || "未知";
      const agentKey = (e.attribution?.kind || "other") + ":" + agent;
      byAgent[agentKey] = byAgent[agentKey] || { calls: 0, cost: 0, tokens: 0 };
      byAgent[agentKey].calls++;
      byAgent[agentKey].cost += cc;
      byAgent[agentKey].tokens += e.usage?.totalTokens || 0;
      // 来源
      const sub = e.source?.subsystem || "other";
      bySubsystem[sub] = bySubsystem[sub] || { calls: 0, cost: 0, tokens: 0 };
      bySubsystem[sub].calls++;
      bySubsystem[sub].cost += cc;
      bySubsystem[sub].tokens += e.usage?.totalTokens || 0;
      // 日期
      const d = fmtDay(e.startedAt);
      if (d) {
        byDay[d] = byDay[d] || { calls: 0, tokens: 0, cost: 0 };
        byDay[d].calls++;
        byDay[d].tokens += e.usage?.totalTokens || 0;
        byDay[d].cost += cc;
        if ((e.status || "ok") !== "ok") byDay[d].err = (byDay[d].err || 0) + 1;
      }
      // 模型
      const m = e.model?.modelId || "unknown";
      byModel[m] = byModel[m] || { calls: 0, cost: 0, tokens: 0, cacheHit: 0, cacheMiss: 0, provider: e.model?.provider || null };
      byModel[m].calls++;
      byModel[m].cost += cc;
      byModel[m].tokens += e.usage?.totalTokens || 0;
      if (e.model?.provider) byModel[m].provider = e.model.provider;
      // Token 细分（输入 / 输出 / 缓存命中 / 缓存未命中）
      const u = e.usage || {};
      const inTot = u.input?.totalTokens ?? u.input?.uncachedTokens ?? 0;
      // 未命中输入统一走 missOf（见文件头注释）
      const miss = missOf(u) ?? inTot;
      const hitT = u.cache?.readTokens != null ? u.cache.readTokens : Math.max(0, inTot - miss);
      const outT = u.output?.totalTokens ?? 0;
      if (Number.isFinite(tsCost)) timeCache.push({ ts: tsCost, hit: hitT, miss });
      tokInput += inTot; tokOutput += outT; tokCacheHit += hitT; tokCacheMiss += miss; tokTotal += (u.totalTokens || (inTot + outT));
      byModel[m].cacheHit += hitT; byModel[m].cacheMiss += miss;
      if (d) { byDay[d].cacheHit = (byDay[d].cacheHit || 0) + hitT; byDay[d].cacheMiss = (byDay[d].cacheMiss || 0) + miss; }
      // 供应商聚合
      const pv = e.model?.provider || "unknown";
      byProvider[pv] = byProvider[pv] || { calls: 0, cost: 0, tokens: 0, cacheHit: 0, cacheMiss: 0 };
      byProvider[pv].calls++;
      byProvider[pv].cost += cc;
      byProvider[pv].tokens += u.totalTokens || (inTot + outT);
      byProvider[pv].cacheHit += hitT; byProvider[pv].cacheMiss += miss;
      // 计费形态（自动判定）＋订阅/额度类的窗口用量：近 5 小时 / 7 天 / 30 天
      if (!billingModes[pv]) billingModes[pv] = billingModeOf(pv);
      if (Number.isFinite(tsCost)) {
        const w = provWindows[pv] || (provWindows[pv] = { h5: { tokens: 0, calls: 0 }, d7: { tokens: 0, calls: 0 }, d30: { tokens: 0, calls: 0 } });
        const tkAll = u.totalTokens || (inTot + outT);
        for (const [wk, span] of [["h5", 5 * 3600e3], ["d7", 7 * 86400e3], ["d30", 30 * 86400e3]]) {
          if (tsCost >= now - span) { w[wk].tokens += tkAll; w[wk].calls += 1; }
        }
      }
      // 按时间范围聚合供应商/模型（24h / 近7天 / 近30天 / 100天 / 100周）
      if (Number.isFinite(tsCost)) {
        const ranges = [['hour', 24*3600e3], ['d7', 7*86400e3], ['d30', 30*86400e3], ['day', 100*86400e3], ['week', 100*7*86400e3]];
        for (const [rangeUnit, span] of ranges) {
          if (tsCost < now - span) continue;
          rangeProv[rangeUnit][pv] = rangeProv[rangeUnit][pv] || { tokens: 0, cost: 0, calls: 0, cacheHit: 0, cacheMiss: 0 };
          rangeProv[rangeUnit][pv].tokens += u.totalTokens || (hitT + miss + outT);
          rangeProv[rangeUnit][pv].cost += cc;
          rangeProv[rangeUnit][pv].calls++;
          rangeProv[rangeUnit][pv].cacheHit += hitT;
          rangeProv[rangeUnit][pv].cacheMiss += miss;
          rangeModel[rangeUnit][m] = rangeModel[rangeUnit][m] || { tokens: 0, cost: 0, calls: 0, provider: pv, cacheHit: 0, cacheMiss: 0 };
          rangeModel[rangeUnit][m].tokens += u.totalTokens || (hitT + miss + outT);
          rangeModel[rangeUnit][m].cost += cc;
          rangeModel[rangeUnit][m].calls++;
          rangeModel[rangeUnit][m].provider = pv;
          rangeModel[rangeUnit][m].cacheHit += hitT;
          rangeModel[rangeUnit][m].cacheMiss += miss;
        }
      }
      // 状态分类
      const stt = e.status || "ok";
      byStatus[stt] = byStatus[stt] || { calls: 0, cost: 0 };
      byStatus[stt].calls++;
      byStatus[stt].cost += cc;
      // 会话聚合
      const sid = e.attribution?.sessionId || "未知会话";
      bySession[sid] = bySession[sid] || { calls: 0, cost: 0, tokens: 0, model: e.model?.modelId || "–" };
      bySession[sid].calls++;
      bySession[sid].cost += cc;
      bySession[sid].tokens += u.totalTokens || (inTot + outT);
      // 按小时聚合（调用数 / 费用）
      const hk = fmtHour(e.startedAt);
      if (hk) { byHour[hk] = byHour[hk] || { calls: 0, cost: 0 }; byHour[hk].calls++; byHour[hk].cost += cc; }
      // 延迟
      const dur = e.durationMs;
      if (dur != null && dur > 0) {
        latAll.push(dur);
        if (dur < 1000) latBuckets.lt1++;
        else if (dur < 3000) latBuckets["1_3"]++;
        else if (dur < 10000) latBuckets["3_10"]++;
        else latBuckets.gt10++;
      }
      if (e.status && e.status !== "ok") errCount++;
    }
    latAll.sort((a, b) => a - b);
    const pct = (q) => (latAll.length ? latAll[Math.min(latAll.length - 1, Math.floor(q * latAll.length))] : 0);
    const round2 = (v) => Math.round(v * 100) / 100;
    const recentBuckets = (spanMs, count, key) => { const start = now - spanMs, out = Array(count).fill(0); for (const x of timeCosts) { if (x.ts < start || x.ts > now) continue; const idx = Math.max(0, Math.min(count - 1, Math.floor(((x.ts - start) / spanMs) * count))); out[idx] += x[key] || 0; } return key === "tokens" ? out.map(v => Math.round(v)) : out.map(v => Math.round(v * 1e6) / 1e6); };
    // 自然日 / 自然周对齐的分桶（当前四档都用等分，保留以备后续档位使用）
    const DAY_MS = 86400e3;
    const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const startOfWeek = (t) => { const d = new Date(startOfDay(t)); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.getTime(); };
    const segOf = (ts, unitStart, unitMs, seg) => Math.min(seg - 1, Math.floor(((ts - unitStart) / unitMs) * seg));
    const alignedBuckets = (unitMs, units, seg, startOf, key) => {
      const out = Array(units * seg).fill(0);
      const base = startOf(now);
      for (const x of timeCosts) {
        const us = startOf(x.ts);
        const u = Math.floor((us - base) / unitMs) + (units - 1);
        if (u < 0 || u >= units) continue;
        out[u * seg + segOf(x.ts, us, unitMs, seg)] += x[key] || 0;
      }
      return key === "tokens" ? out.map(v => Math.round(v)) : out.map(v => Math.round(v * 1e6) / 1e6);
    };
    const alignedRates = (unitMs, units, seg, startOf) => {
      const hit = Array(units * seg).fill(0), miss = Array(units * seg).fill(0);
      const base = startOf(now);
      for (const x of timeCache) {
        const us = startOf(x.ts);
        const u = Math.floor((us - base) / unitMs) + (units - 1);
        if (u < 0 || u >= units) continue;
        const i = u * seg + segOf(x.ts, us, unitMs, seg);
        hit[i] += x.hit || 0;
        miss[i] += x.miss || 0;
      }
      return hit.map((v, i) => (v + miss[i]) > 0 ? Math.round((v / (v + miss[i])) * 1000) / 10 : 0);
    };
    // 统一 256 格（32 列 × 8 行，格子方正）
    // day 档浮动：一格一天 = 256 天，对齐本地 0 点
    const timeBuckets = { hour: recentBuckets(24 * 3600e3, 256, "cost"), d7: recentBuckets(7 * 86400e3, 256, "cost"), d30: recentBuckets(30 * 86400e3, 256, "cost"), day: alignedBuckets(DAY_MS, 256, 1, startOfDay, "cost") };
    const tokenBuckets = { hour: recentBuckets(24 * 3600e3, 256, "tokens"), d7: recentBuckets(7 * 86400e3, 256, "tokens"), d30: recentBuckets(30 * 86400e3, 256, "tokens"), day: alignedBuckets(DAY_MS, 256, 1, startOfDay, "tokens") };
    const recentCacheRates = (spanMs, count) => { const start = now - spanMs, hit = Array(count).fill(0), miss = Array(count).fill(0); for (const x of timeCache) { if (x.ts < start || x.ts > now) continue; const idx = Math.max(0, Math.min(count - 1, Math.floor(((x.ts - start) / spanMs) * count))); hit[idx] += x.hit || 0; miss[idx] += x.miss || 0; } return hit.map((v, i) => (v + miss[i]) > 0 ? Math.round((v / (v + miss[i])) * 1000) / 10 : 0); };
    const cacheRateBuckets = { hour: recentCacheRates(24 * 3600e3, 256), d7: recentCacheRates(7 * 86400e3, 256), d30: recentCacheRates(30 * 86400e3, 256), day: alignedRates(DAY_MS, 256, 1, startOfDay) };
    // 明细只覆盖最近一段，宿主的按天汇总才是全量；能读到就用它校正「按天」
    // 与总量，让页面数字与宿主自己的统计口径一致。
    // 注意：汇总表是全局口径，按供应商过滤时不能用它覆盖，否则会把全局量当成这一家的。
    const hostRollups = provider ? null : await readHostDailyRollups(ctx);
    if (hostRollups) {
      let ri = 0, ro = 0, rh = 0, rt = 0, rc = 0;
      // 汇总行现在按「天 × 供应商 × 模型」拆开，同一天会有多行，必须累加而不能覆盖。
      const rollDays = new Map();
      const rollRows = new Map();
      for (const r of hostRollups) {
        const d = r.d;
        if (d) {
          let agg = rollDays.get(d);
          if (!agg) rollDays.set(d, agg = { tokens: 0, calls: 0, hit: 0, inn: 0 });
          agg.tokens += Number(r.tokens || 0);
          agg.calls += Number(r.calls || 0);
          agg.hit += Number(r.cacheHit || 0);
          agg.inn += Number(r.input || 0);
          let rows = rollRows.get(d);
          if (!rows) rollRows.set(d, rows = []);
          rows.push(r);
        }
        ri += Number(r.input || 0); ro += Number(r.output || 0);
        rh += Number(r.cacheHit || 0); rt += Number(r.tokens || 0); rc += Number(r.calls || 0);
      }
      // 明细只覆盖最近一段。汇总里更早的天没有明细可算钱，得自己按价格库估，
      // 否则「每日费用」图上那些天有 token 却挂着 0 元。
      const share = weekdayPeakShare(ledgerEntries);
      const detailDays = new Set(Object.keys(byDay));
      const detailEarliestDay = Object.keys(byDay).sort()[0] || null;
      // 明细最早那天的用量是从当天中途开始的，而汇总是一整天，两者对不齐：
      // 钱也一并交给汇总估，否则图上那天只有半天的费用。
      if (detailDays.size > 1) detailDays.delete(Object.keys(byDay).sort()[0]);
      for (const [d, agg] of rollDays) {
        const cur = byDay[d] || (byDay[d] = { calls: 0, tokens: 0, cost: 0 });
        cur.tokens = agg.tokens;
        cur.calls = agg.calls;
        cur.cacheHit = agg.hit;
        cur.cacheMiss = agg.inn < agg.hit ? agg.inn : Math.max(0, agg.inn - agg.hit);
        if (!detailDays.has(d)) {
          let c = 0;
          for (const r of rollRows.get(d) || []) { const x = rollupRowCost(r, share); if (x != null) c += x; }
          cur.cost = Math.round(c * 100) / 100;
        }
      }
      // ri 是输入口径：小于命中量时只可能是「未命中输入」（总量必定 ≥ 命中量）
      if (rt > 0) { tokInput = ri; tokOutput = ro; tokCacheHit = rh; tokCacheMiss = ri < rh ? ri : Math.max(0, ri - rh); tokTotal = rt; callCount = rc; }
      // 永久库：宿主汇总里的每一天都并进去（不受 256 格窗口限制），只增不减。
      // 当天只更新内存，等跨天再定稿落盘。
      const dayRows = new Map();
      for (const [d, agg] of rollDays) {
        let dc = 0;
        for (const r of rollRows.get(d) || []) { const x = rollupRowCost(r, share); if (x != null) dc += x; }
        const h = agg.hit, inn = agg.inn;
        dayRows.set(d, { t: agg.tokens, c: dc, hit: h, miss: inn < h ? inn : Math.max(0, inn - h), n: agg.calls });
      }
      try { ingestDays(ctx, dayRows, fmtDay(now)); } catch { /* 缓存失败不影响本次统计 */ }
      // 按天的 256 格桶（「按天」档的热力图与折线）原来完全由明细算出，而宿主的明细只保留最近一段，
      // 更早的格子于是全是 0。用宿主的按天汇总把明细没能算出来的格子补上：
      // 只填值为 0 的格子，明细已经算出来的格子一律不动，确保现有显示零变化。
      const dayIndex = (d) => {
        const t = Date.parse(d + "T00:00:00+08:00");
        if (!Number.isFinite(t)) return -1;
        const u = Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS) + 255;
        return u >= 0 && u < 256 ? u : -1;
      };
      for (const [d, agg] of rollDays) {
        const i = dayIndex(d);
        if (i < 0) continue;
        if (detailEarliestDay === d || !tokenBuckets.day[i]) tokenBuckets.day[i] = Math.round(agg.tokens);
        let c = 0;
        for (const r of rollRows.get(d) || []) { const x = rollupRowCost(r, share); if (x != null) c += x; }
        if (!timeBuckets.day[i]) timeBuckets.day[i] = Math.round(c * 1e6) / 1e6;
        if (!cacheRateBuckets.day[i]) {
          const hit = agg.hit, inn = agg.inn;
          const miss = inn < hit ? inn : Math.max(0, inn - hit);
          cacheRateBuckets.day[i] = (hit + miss) > 0 ? Math.round((hit / (hit + miss)) * 1000) / 10 : 0;
        }
      }
      // 近 7 天 / 近 30 天两档：一格只有 39 分钟 / 2.8 小时，宿主给不出这个粒度，
      // 用本地按小时聚合缓存（真实的日内分布）填。缓存没覆盖到的时段仍旧是 0：
      // 宁留空，不放推出来的数字。
      const fillFromHourly = (arr, spanMs, map) => {
        const start = now - spanMs, cellMs = spanMs / 256;
        for (let i = 0; i < 256; i++) {
          if (arr[i]) continue;               // 明细已经算出来的格子不动
          const t0 = start + i * cellMs;
          const s = sumHoursInRange(ctx, t0, t0 + cellMs);
          if (s) arr[i] = map(s);
        }
      };
      const rateOf = (s) => { const tot = s.hit + s.miss; return tot > 0 ? Math.round((s.hit / tot) * 1000) / 10 : 0; };
      fillFromHourly(tokenBuckets.d7, 7 * 86400e3, (s) => Math.round(s.tokens));
      fillFromHourly(tokenBuckets.d30, 30 * 86400e3, (s) => Math.round(s.tokens));
      fillFromHourly(timeBuckets.d7, 7 * 86400e3, (s) => Math.round(s.cost * 1e6) / 1e6);
      fillFromHourly(timeBuckets.d30, 30 * 86400e3, (s) => Math.round(s.cost * 1e6) / 1e6);
      fillFromHourly(cacheRateBuckets.d7, 7 * 86400e3, rateOf);
      fillFromHourly(cacheRateBuckets.d30, 30 * 86400e3, rateOf);
    }
    // 把这一批明细按小时聚合进本地缓存（宿主的明细只留最近一段，长期的日内分布靠自己攒）。
    // 只在拿到新的一批明细时才聚合，同一批数据不重复算。
    if (ledgerEntries !== hourlyAggRef) {
      hourlyAggRef = ledgerEntries;
      updateHourlyCache(ctx, ledgerEntries, now, missOf);
    }
    ledgerStatsCache = {
      at: now,
      timeBuckets,
      tokenBuckets,
      cacheRateBuckets,
      provider,
      calls: callCount,
      errors: errCount,
      agents: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, { calls: v.calls, cost: round2(v.cost), tokens: v.tokens }])),
      subsystems: Object.fromEntries(Object.entries(bySubsystem).map(([k, v]) => [k, { calls: v.calls, cost: round2(v.cost), tokens: v.tokens }])),
      days: Object.fromEntries(Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, { calls: v.calls, err: v.err || 0, tokens: v.tokens, cost: round2(v.cost), cacheHit: v.cacheHit || 0, cacheMiss: v.cacheMiss || 0, hitRate: (v.cacheHit + v.cacheMiss) > 0 ? v.cacheHit / (v.cacheHit + v.cacheMiss) : null }])),
      models: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, { provider: v.provider, calls: v.calls, cost: round2(v.cost), tokens: v.tokens, cacheHit: v.cacheHit, cacheMiss: v.cacheMiss, hitRate: (v.cacheHit + v.cacheMiss) > 0 ? v.cacheHit / (v.cacheHit + v.cacheMiss) : 0 }])),
      providers: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, { calls: v.calls, cost: round2(v.cost), tokens: v.tokens, cacheHit: v.cacheHit, cacheMiss: v.cacheMiss, hitRate: (v.cacheHit + v.cacheMiss) > 0 ? v.cacheHit / (v.cacheHit + v.cacheMiss) : 0 }])),
      rangeProviders: Object.fromEntries(Object.entries(rangeProv).map(([rangeUnit, o]) => [rangeUnit, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { tokens: v.tokens, cost: round2(v.cost), calls: v.calls, cacheHit: v.cacheHit, cacheMiss: v.cacheMiss, hitRate: (v.cacheHit + v.cacheMiss) > 0 ? v.cacheHit / (v.cacheHit + v.cacheMiss) : 0 }]))])),
      rangeModels: Object.fromEntries(Object.entries(rangeModel).map(([rangeUnit, o]) => [rangeUnit, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { provider: v.provider, tokens: v.tokens, cost: round2(v.cost), calls: v.calls, cacheHit: v.cacheHit, cacheMiss: v.cacheMiss, hitRate: (v.cacheHit + v.cacheMiss) > 0 ? v.cacheHit / (v.cacheHit + v.cacheMiss) : 0 }]))])),
      statuses: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, { calls: v.calls, cost: round2(v.cost) }])),
      sessions: Object.fromEntries(Object.entries(bySession).sort((a, b) => b[1].cost - a[1].cost).map(([k, v]) => [k, { calls: v.calls, cost: round2(v.cost), tokens: v.tokens, model: v.model }])),
      billingModes,
      providerWindows: provWindows,
      // 账本覆盖范围：明细被裁到最近 N 条，界面要能把「这个数是哪一段的」说出来
      coverage: (() => { const ks = Object.keys(byDay).sort(); return { firstDay: ks[0] || null, lastDay: ks[ks.length - 1] || null, days: ks.length }; })(),
      hours: Object.fromEntries(Object.entries(byHour).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, { calls: v.calls, cost: round2(v.cost) }])),
      tokens: { input: tokInput, output: tokOutput, cacheHit: tokCacheHit, cacheMiss: tokCacheMiss, total: tokTotal, hitRate: tokTotal ? (tokCacheHit + tokCacheMiss) > 0 ? tokCacheHit / (tokCacheHit + tokCacheMiss) : 0 : 0 },
      latency: {
        n: latAll.length,
        avg: latAll.length ? Math.round(latAll.reduce((a, b) => a + b, 0) / latAll.length) : 0,
        p50: pct(0.5),
        p95: pct(0.95),
        max: latAll.length ? latAll[latAll.length - 1] : 0,
        buckets: latBuckets,
      },
    };
    return ledgerStatsCache;
  } catch (e) {
    dbg("ledger-stats ERROR: " + String(e?.message || e));
    return { at: now, empty: true, provider, error: String(e?.message || e) };
  }
}

// 自动定位 Hana 数据根：插件安装目录与插件私有 dataDir 都位于 Hana 数据根之下，
// 配置项和 sessionsDir 只作为补充候选。找不到时明确报错，不再回退固定机器路径。
// 常见 HanaAgent 数据根参考目录：从环境变量与常见安装位置推导，
// 覆盖发行版与内测版的不同数据根布局。
function commonDataRootCandidates() {
  const list = [];
  for (const p of [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.USERPROFILE, process.env.HOMEDRIVE]) {
    if (!p) continue;
    for (const sub of ["", "Hanako", "hana", ".hanako", ".hana", "HanaAgent", "hana-agent"]) {
      try { list.push(join(p, sub)); } catch {}
    }
  }
  return list;
}

function computeDataRootUncached(ctx) {
  const candidates = [];
  try {
    const pd = ctx?.pluginDir;
    if (pd) candidates.push(dirname(dirname(pd)));
  } catch {}
  try {
    const dataDir = ctx?.dataDir;
    if (dataDir) candidates.push(dirname(dirname(dataDir)));
  } catch {}
  try {
    const configured = ctx?.config?.get?.("dataDir");
    if (configured) candidates.push(configured);
  } catch {}
  try {
    const sd = ctx?.config?.get?.("sessionsDir");
    if (sd) candidates.push(join(sd, "..", "..", ".."));
  } catch {}
  // 参考目录：常见 Hana 数据根位置
  if (!ctx?.config?.get?.("dataDir")) candidates.push(...commonDataRootCandidates());

  const unique = [...new Set(candidates.filter(Boolean).map((p) => join(p)))];
  const markers = ["provider-catalog.json", "models.json", "auth.json", "usage-ledger.json", "agents"];
  for (const root of unique) {
    try {
      if (existsSync(root) && markers.some((name) => existsSync(join(root, name)))) return root;
    } catch {}
  }
  for (const root of unique) {
    try { if (existsSync(root)) return root; } catch {}
  }
  // 最后：扫参考目录，含 agents 或 models/provider 的才算 Hana 数据根
  for (const root of commonDataRootCandidates()) {
    try {
      if (existsSync(join(root, "agents")) || existsSync(join(root, "provider-catalog.json"))) return root;
    } catch {}
  }
  // v2：App 沙箱里读不到 HANA_HOME，兜底返回 App 自己的 dataDir，
  // 让依赖这个路径的老代码走到"文件不存在"的分支，而不是直接抛错。
  return ctx?.dataDir ?? "";
}

/**
 * 数据根目录缓存。
 * 原实现每次都重建候选目录、逐轮 existsSync（含 markers 探测与参考目录扫描），单个请求可能几十次同步文件系统调用；
 * 而 hostConfigChanged 每个 /api 请求都会调它两次，前端几个轮询叠起来就是每秒上百次。
 * 结果只取决于 ctx 的几个路径输入，所以按这些输入做键 + 10 秒 TTL：既省掉重复扫描，
 * 也不会把“启动时目录还没就绪”这种瞬时状态锁死。
 */
let dataRootCache = { key: null, at: 0, root: "" };
const DATA_ROOT_TTL_MS = 10000;
function getDataRoot(ctx) {
  let key = "";
  try {
    key = [
      ctx?.pluginDir || "",
      ctx?.dataDir || "",
      ctx?.config?.get?.("dataDir") || "",
      ctx?.config?.get?.("sessionsDir") || "",
    ].join("\u0001");
  } catch {}
  const now = Date.now();
  if (dataRootCache.key === key && now - dataRootCache.at < DATA_ROOT_TTL_MS) return dataRootCache.root;
  const root = computeDataRootUncached(ctx);
  dataRootCache = { key, at: now, root };
  return root;
}
// 账本条目：宿主自 2026-09-09 起把账本迁到 SQLite（usage-ledger.sqlite.usage_entries），旧 JSON 文件已停更。
// 优先读 SQLite，读不到再回退 JSON；两边条目结构一致（entry_json 就是原来的 entry 对象）。
let ledgerEntriesCache = { at: 0, entries: [], source: null };
async function readLedgerEntries(ctx, minTtlMs) {
  // v2：账本改走宿主 usage:list。原来直读 HANA_HOME 下的 SQLite / JSON，
  // 在 App 的沙箱里拿不到那条路径；旧实现保留在 _legacyReadLedgerEntries 里仅作参考。
  const now = Date.now();
  if (now - ledgerEntriesCache.at < (minTtlMs ?? 30000)) return ledgerEntriesCache;
  try {
    const entries = await fetchAllLedgerEntries(ctx.sdk);
    ledgerEntriesCache = { at: now, entries, source: "host" };
  } catch (error) {
    dbg("ledger read failed: " + String(error?.message || error));
  }
  return ledgerEntriesCache;
}

/** 宿主的账本明细只保留最近 2 万条，更早的历史只剩在它自己的按天汇总表里。
 *  SDK 只开放了 usage:list（明细），拿不到那张汇总表；App 自己的 fs 又被
 *  Node Permission Model 锁在安装目录与 app-data 内，读不到宿主数据根。
 *  所以先试直读，不行就让子进程去读（子进程不带 App 的权限限制）。 */
let rollupsCache = { at: 0, rows: null };
// 上一次已经聚合进「按小时缓存」的那批明细（同一批不重复算）
let hourlyAggRef = null;
// 汇总表如果是子进程读的，每次都要 spawn，就不能按秒读。
// 记住当前走哪条路，决定缓存时长：直读（廉价）可以秒级，子进程退回 5 秒。
let rollupsViaChild = false;
// 直读是否已经被证不通用（见 readHostDailyRollups）
let rollupsDirectBroken = false;
const ROLLUP_SQL = "SELECT stat_day AS d, provider AS p, model_id AS m, SUM(request_count) AS calls, SUM(total_tokens) AS tokens, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheHit, SUM(cache_write_tokens) AS cacheWrite FROM usage_daily_rollups GROUP BY stat_day, provider, model_id";

// 汇总行是按天 × 供应商 × 模型分组的，没有时刻信息。峰谷价模型（DeepSeek）
// 只能靠「当天高峰时段的用量占比」把两档价加权出来；这个占比用明细实测，
// 比一律按 7/24 小时算准得多（实测工作日的用量大部分落在夜间）。
let dayPeakShareCache = { ref: null, weekday: null };
function weekdayPeakShare(entries) {
  if (dayPeakShareCache.ref === entries) return dayPeakShareCache.weekday;
  let peak = 0, all = 0;
  for (const e of entries) {
    const ts = e?.startedAt;
    if (!ts) continue;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const u = e.usage || {};
    const t = Number(u.input?.totalTokens || 0) + Number(u.cache?.readTokens || 0) + Number(u.output?.totalTokens || 0) + Number(u.cache?.writeTokens || 0);
    if (t <= 0) continue;
    const cn = new Date(d.getTime() + (8 * 60) * 60e3);
    const wd = cn.getUTCDay();
    if (wd === 0 || wd === 6) continue; // 周末全天空闲，不参与估计
    all += t;
    if (isPeakHour(ts)) peak += t;
  }
  const share = all > 0 ? peak / all : null;
  dayPeakShareCache = { ref: entries, weekday: share };
  return share;
}

// 单行汇总的费用：同一行用量分别按高峰价、空闲价各算一遍，再按占比加权。
// 固定价模型两档相同，加权等价于直接算；周末 / 节假日两档也相同（isPeakHour 判为全天空闲）。
function rollupRowCost(r, share) {
  const model = r.m;
  if (!model) return null;
  // 和逐条计费同一套规矩：订阅额度、免费额度、本地部署的用量不进金额
  if (billingModeOf(r.p, null) !== "metered") return 0;
  const inp = Number(r.input || 0), hit = Number(r.cacheHit || 0), out = Number(r.output || 0), cw = Number(r.cacheWrite || 0);
  if (inp + hit + out + cw <= 0) return null;
  const w = share == null ? 7 / 24 : Math.max(0, Math.min(1, share));
  const pk = calcCost(inp, hit, out, 0, model, r.d + "T10:00:00+08:00", r.p, cw);
  const op = calcCost(inp, hit, out, 0, model, r.d + "T20:00:00+08:00", r.p, cw);
  if (pk == null && op == null) return null;
  const a = pk == null ? op : pk, b = op == null ? pk : op;
  return a * w + b * (1 - w);
}

/** App 自己的 dataDir 一定可写，它上两级就是宿主数据根 */
function hostRootGuess(ctx) {
  for (const v of [ctx?.dataDir, ctx?.pluginDir]) {
    try { if (v) return dirname(dirname(v)); } catch {}
  }
  return "";
}

/** 让子进程去读：它不受 App 进程那套 Permission Model 的限制 */
async function readRollupsViaChild(ctx, dbPath) {
  try {
    const dir = ctx?.dataDir;
    if (!dir || !dbPath) return null;
    // 用 node -e 直接把代码带过去，不落临时脚本：这条路是常态而非兜底（App 进程读不了宿主目录，
    // 只能让子进程去读），每次写一个脚本再删掉纯属白花磁盘往返。
    // node -e 模式下 argv[0] 是 node 自己，所以取 [1]。
    const body = "import { DatabaseSync } from \"node:sqlite\";\nconst db = new DatabaseSync(process.argv[1], { readOnly: true });\nconst rows = db.prepare(" + JSON.stringify(ROLLUP_SQL) + ").all();\ndb.close();\nprocess.stdout.write(JSON.stringify(rows));\n";
    const out = await new Promise((resolve) => {
      let buf = "";
      let done = false;
      const child = spawn("node", ["--input-type=module", "-e", body, dbPath], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => { try { child.kill(); } catch {} if (!done) { done = true; resolve(""); } }, 8000);
      child.stdout.on("data", (c) => { buf += c; });
      child.on("error", (e) => { clearTimeout(timer); if (!done) { done = true; dbg("rollups child error: " + String(e?.message || e)); resolve(""); } });
      child.on("close", () => { clearTimeout(timer); if (!done) { done = true; resolve(buf); } });
    });
    if (!out) return null;
    const rows = JSON.parse(out);
    if (!Array.isArray(rows) || !rows.length) return null;
    dbg("rollups via child ok: " + rows.length + " 天");
    return rows;
  } catch (e) {
    dbg("rollups via child failed: " + String(e?.message || e));
    return null;
  }
}

async function readHostDailyRollups(ctx, minTtlMs) {
  const ttl = minTtlMs ?? 60000;
  // 子进程路径的缓存：宿主那张按天汇总表本身就是每 30~45 秒才更新一批（实测），
  // 所以缓存略短于这个节奏就够了 —— 设 10 秒既不会比数据源更滞后，
  // 也不会让子进程被反复拉起（每秒的请求绝大多数都命中缓存）。
  if (Date.now() - rollupsCache.at < (rollupsViaChild ? Math.max(ttl, 10000) : ttl)) return rollupsCache.rows;
  rollupsCache = { at: Date.now(), rows: null };
  const dbPath = hostRootGuess(ctx) ? join(hostRootGuess(ctx), "usage-ledger.sqlite") : "";
  let rows = null;
  // 直读受宿主进程的文件权限限制：连 existsSync 都会抛 ERR_ACCESS_DENIED，
  // 所以整个探测必须包在 try 里。之前把它放在 if 条件里，异常会冒泡出去，
  // 让整个账本统计接口失败（总消耗、调用数回落到只剩明细窗口）。
  // 一次不通就记住不再重试；标记只活在本次进程里，宿主将来放开权限、重启之后仍会重新尝试。
  if (!rollupsDirectBroken) {
    try {
      if (dbPath && existsSync(dbPath)) {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(dbPath, { readOnly: true });
        rows = db.prepare(ROLLUP_SQL).all();
        db.close();
        if (rows?.length) dbg("rollups direct ok: " + rows.length + " 天");
      } else {
        rollupsDirectBroken = true;
      }
    } catch (e) {
      rollupsDirectBroken = true;
      dbg("rollups direct unavailable（改用子进程）: " + String(e?.message || e));
    }
  }
  if (!rows?.length) { rows = await readRollupsViaChild(ctx, dbPath); if (rows?.length) rollupsViaChild = true; }
  if (rows?.length) { rollupsCache.rows = rows; return rows; }
  return null;
}

/** 宿主单次最多 1 万条，按时间往前切片直到取完或达到页数上限。 */
async function fetchAllLedgerEntries(sdk, { pageLimit = 10000, maxPages = 12 } = {}) {
  const all = [];
  let until = null;
  for (let page = 0; page < maxPages; page += 1) {
    const filter = { limit: pageLimit };
    if (until) filter.until = until;
    const result = await sdk.usage.list(filter);
    const entries = result?.entries ?? [];
    all.push(...entries);
    dbg(`ledger page ${page}: count=${entries.length} until=${until || "-"} first=${entries[0]?.startedAt || "-"}`);
    if (entries.length < pageLimit) break;
    let earliest = Infinity;
    for (const e of entries) {
      const t = Date.parse(e.startedAt ?? "");
      if (Number.isFinite(t) && t < earliest) earliest = t;
    }
    if (!Number.isFinite(earliest)) break;
    until = new Date(earliest - 1).toISOString();
  }
  return all;
}

// 动态定位 provider-catalog.json：优先 config 配置，其次从 sessionsDir 推断数据根（sessions → agent → agents → 根），最后用动态数据根推导
function getProviderCatalogPath(ctx) {
  try {
    const p = ctx.config?.get?.("providerCatalogPath") || ctx.config?.get?.("dataDir");
    if (p && existsSync(p)) return existsSync(p) && p.endsWith(".json") ? p : join(p, "provider-catalog.json");
  } catch {}
  try {
    const sd = ctx.config?.get?.("sessionsDir");
    if (sd) {
      const cand = join(sd, "..", "..", "..", "provider-catalog.json");
      if (existsSync(cand)) return cand;
    }
  } catch {}
  return join(getDataRoot(ctx), "provider-catalog.json");
}

// 供应商余额适配器：url 拼接 + 响应解析
// 导出出来只为了能被探针直接喂 mock 数据单测，不改变运行时行为。
export const BALANCE_ADAPTERS = {
  deepseek: {
    name: "DeepSeek",
    url: (base) => base.replace(/\/+$/, "") + "/user/balance",
    parse: (data) => {
      const cny = (data.balance_infos || []).find((b) => b.currency === "CNY");
      return cny ? { total: Math.round(Number(cny.total_balance) * 100) / 100, currency: "CNY" } : null;
    },
  },
  moonshot: {
    name: "Moonshot",
    url: (base) => base.replace(/\/+$/, "") + "/users/me/balance",
    parse: (data) => {
      const d = data && data.data;
      if (d && d.available_balance != null) {
        return { total: Math.round(Number(d.available_balance) * 100) / 100, currency: "CNY" };
      }
      return null;
    },
  },
  // 下面三家的 baseUrl 在宿主里可能带 /v1 也可能不带，拼接时统一补上。
  stepfun: {
    name: "阶跃星辰",
    url: (base) => withV1(base) + "/accounts",
    parse: (data) => {
      const d = data?.data ?? data;
      const v = Number(d?.balance ?? d?.available_balance);
      return Number.isFinite(v) ? { total: Math.round(v * 100) / 100, currency: "CNY" } : null;
    },
  },
  siliconflow: {
    name: "硅基流动",
    url: (base) => withV1(base) + "/user/info",
    // 端点长期在用但官方文档未收录，字段名以社区可见的 data.totalBalance 为主，
    // 另外两个作为兼容备选；三个都拿不到就当解析失败，不猜数字。
    parse: (data) => {
      const d = data?.data ?? data;
      const v = Number(d?.totalBalance ?? d?.balance ?? d?.chargeBalance);
      return Number.isFinite(v) ? { total: Math.round(v * 100) / 100, currency: "CNY" } : null;
    },
  },
  openrouter: {
    name: "OpenRouter",
    url: (base) => withV1(base) + "/credits",
    // /credits 返回的是购买额度与已用额度，可用余额是两者之差；需管理密钥，普通推理密钥会 403
    parse: (data) => {
      const d = data?.data ?? data;
      const credits = Number(d?.total_credits);
      if (!Number.isFinite(credits)) return null;
      const used = Number(d?.total_usage);
      const left = credits - (Number.isFinite(used) ? used : 0);
      return { total: Math.round(left * 100) / 100, currency: "USD" };
    },
  },
};

/** 把 baseUrl 规整到带 /v1 的形式：有的宿主配置带、有的不带，两种都要拼得对。 */
function withV1(base) {
  const b = String(base || "").replace(/\/+$/, "");
  return /\/v1$/.test(b) ? b : b + "/v1";
}

// 未查到的供应商说明统一由 lib/provider-directory.js 生成（reachable 判据也在那里），
// 这里只保留需要按插件配置动态改写的几条 note，避免两处定义漂移。

// 从数据根的 agents/ 下枚举所有子代理的 sessions 目录（不硬编码具体 agent 名）
// 参考目录：HanaAgent 实际可能使用的会话目录（含用户配置与常见数据根推导）
// 会话标题：优先使用 HanaAgent 的正式标题（session-titles.json），首条用户消息仅作兜底
let sessionTitlesCache = { path: "", mtime: 0, data: {} };
// 读文件头部识别会话使用的模型（不解析全文，快）
// 探测“用户当前正在对话”的会话：所有会话里，最后一条 role:user 消息时间戳最新的那个。
// 后台子代理 / 自动刷新会写 assistant/toolResult，但不会写 user 消息，因此能排掉后台干扰。
const ACTIVE_TAIL_BYTES = 262144; // 读每个文件末尾 256KB 找最后一条 user 消息（够容纳长回复）
const USER_TS_RE = /"role"\s*:\s*"user"[\s\S]{0,2000}?"timestamp"\s*:\s*(\d{13})/g;
// 将宿主焦点消息的 entryId 精确映射回本地 JSONL。
// /api/sessions/messages 返回的 entryId 来自 JSONL 原始 message.id，且最后一条消息
// 必然靠近文件尾部；只读尾部 2MB，避免轮询时反复读取完整大文件。
const ENTRY_TAIL_BYTES = 2 * 1024 * 1024;
const entryFileCache = new Map();

// ── 计费配置：远程全量数据库 + 本地缓存 + 内置兜底 ──
// 数据库放在仓库根目录 pricing.json，全量收录所有已知供应商；
// 插件每天拉一次，失败或超时就继续用内置那份。
const PRICING_DB_URLS = [
  "https://cdn.jsdelivr.net/gh/youyongdemao/HanaAgent-session-insight@main/pricing.json",
  "https://raw.githubusercontent.com/youyongdemao/HanaAgent-session-insight/main/pricing.json",
];
const PRICING_DB_TTL = 24 * 60 * 60 * 1000;
let pricingDbState = { at: 0, ok: false, source: "builtin", snapshotAt: PRICING_SNAPSHOT_AT, error: null };

async function loadPricingDb(ctx, force = false) {
  const now = Date.now();
  if (!force && pricingDbState.at && now - pricingDbState.at < PRICING_DB_TTL) return pricingDbState;
  // 多源并行竞速：谁先拿到有效配置用谁，最坏耗时 = 单源超时，而不是各源相加
  const attempt = async (url) => {
    const fetchFn = ctx?.network?.fetch ? (u, o) => ctx.network.fetch(u, o) : fetch;
    const res = await fetchFn(url, { headers: { "User-Agent": "Session-Insight-Pricing" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!setPricingConfig(json)) throw new Error("配置校验失败");
    return { url, json };
  };
  try {
    const hit = await Promise.any(PRICING_DB_URLS.map(attempt));
    pricingDbState = { at: now, ok: true, source: hit.url, snapshotAt: hit.json.snapshotAt || PRICING_SNAPSHOT_AT, error: null };
    dbg("pricing-db: loaded from " + hit.url);
    return pricingDbState;
  } catch (e) {
    const lastError = String(e?.errors?.[0]?.message || e?.message || e);
    pricingDbState = { at: now, ok: false, source: "builtin", snapshotAt: PRICING_SNAPSHOT_AT, error: lastError };
    dbg("pricing-db: fallback to builtin, " + lastError);
    return pricingDbState;
  }
}

// 宿主供应商/模型配置变化感知：只比 mtime + size，不做全文 hash
let hostConfigStamp = null;
let hostConfigCheckedAt = 0;
const HOST_CONFIG_CHECK_MS = 1500;
function hostConfigChanged(ctx) {
  // 节流：这个函数挂在 /api/* 中间件上，每个请求都跑。原来每个请求都要 3 次 statSync
  // 加两次 getDataRoot（那里面是成串的 existsSync）。前端有 1s/4s/5s/6s/10s 几个轮询源，
  // 叠起来就是持续不断的同步文件系统调用。配置变化晚 1.5 秒被感知没有任何影响。
  const now = Date.now();
  if (now - hostConfigCheckedAt < HOST_CONFIG_CHECK_MS) return false;
  hostConfigCheckedAt = now;
  const paths = [];
  try { paths.push(getProviderCatalogPath(ctx)); } catch {}
  try { paths.push(join(getDataRoot(ctx), "models.json")); } catch {}
  // OAuth 登录/退出也属于供应商配置变化（auth.json 不在 provider-catalog 里）
  try { paths.push(join(getDataRoot(ctx), "auth.json")); } catch {}
  const sig = paths.filter(Boolean).map((p) => {
    try { const s = statSync(p); return `${p}:${s.mtimeMs}:${s.size}`; } catch { return `${p}:none`; }
  }).join("|");
  if (hostConfigStamp === null) { hostConfigStamp = sig; return false; }
  if (sig !== hostConfigStamp) { hostConfigStamp = sig; dbg("host-config changed"); return true; }
  return false;
}

// 可失效缓存必须放在模块作用域：invalidateConfigCaches 是模块级函数，
// 假如这两个 let 写在路由注册函数内部，它会够不到（ReferenceError 被 catch 吞掉），
// 结果就是配置改了也清不掉缓存，只能干等 TTL 过期。
let balanceCache = { at: 0, data: null };
let providersCache = { at: 0, data: null };

// 配置变化时清掉依赖它的缓存，下一次取数重新计算
function invalidateConfigCaches() {
  try { ledgerCache = { at: 0, totalCost: 0, perProvider: {}, perModel: {} }; } catch {}
  try { ledgerStatsCache = { at: 0, provider: null }; } catch {}
  try { balanceCache = { at: 0, data: null }; } catch {}
  try { providersCache = { at: 0, data: null }; } catch {}
  try { externalStatusCache.clear(); } catch {}
}

function currentPluginVersion(ctx) {
  try {
    return JSON.parse(readFileSync(join(ctx.pluginDir, "manifest.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const externalStatusCache = new Map();

/** 最近一次余额查询的定位快照：哪一步耗时多久、谁超预算、谁报错。
 *  前端在 /api/balance 超时后拉 /api/balance-diag 拿它，直接说出是哪一家卡住的。 */
let balanceDiag = null;

function cachedExternalStatus(key, ttlMs) {
  const cached = externalStatusCache.get(key);
  return cached && Date.now() - cached.at < ttlMs ? cached.data : null;
}

function storeExternalStatus(key, data) {
  externalStatusCache.set(key, { at: Date.now(), data });
  return data;
}

function flushExternalCaches(){ externalStatusCache.clear(); }

/** 余额类外部查询的总预算。前端 8s 就会 abort，后端必须更早收口，
 *  否则最慢的那一家会把整张卡片拖成 "signal timed out"。 */
const BALANCE_BUDGET_MS = 6000;

/** 给一个 Promise 套截止时间：超时先返回 fallback。原任务不取消，会在后台跑完（可能写缓存）。 */
function withBudget(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** 带定位的预算包装：结果里带上谁（tag）、耗时多久（ms）、为什么没结果。
 *  超预算时原任务继续跑（拿到结果就写缓存），但本次请求已经不等它了。 */
function budgeted(tag, factory, budgetMs = BALANCE_BUDGET_MS) {
  const t0 = Date.now();
  let settled = false;
  const timer = new Promise((resolve) =>
    setTimeout(() => {
      if (settled) return;
      resolve({ tag, ok: false, reason: "budget", ms: budgetMs });
    }, budgetMs)
  );
  const run = Promise.resolve()
    .then(factory)
    .then(
      (value) => { settled = true; return { tag, ok: true, value, ms: Date.now() - t0 }; },
      (err) => { settled = true; return { tag, ok: false, reason: "error", detail: String(err?.message || err).slice(0, 120), ms: Date.now() - t0 }; }
    );
  return Promise.race([run, timer]);
}

/** 外部查询的失败记忆。失败结果不能进 externalStatusCache（那会被当成"查到了"），
 *  单独记一条短 TTL 的负缓存，免得每轮都花几秒重试同一个不可达来源。 */
function markExternalFailure(key, ttlMs = 120000) {
  externalStatusCache.set("fail:" + key, { at: Date.now(), data: true, ttl: ttlMs });
}

function cachedExternalFailure(key) {
  const hit = externalStatusCache.get("fail:" + key);
  return !!(hit && Date.now() - hit.at < (hit.ttl ?? 120000));
}

function configValue(ctx, key) {
  try {
    const value = ctx.config?.get?.(key);
    return typeof value === "string" ? value.trim() : value;
  } catch {
    return null;
  }
}

async function requestJson(fetchFn, url, init = {}, timeoutMs = 10000) {
  const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { ok: response.ok, status: response.status, data };
}

// 智谱系配额单家查询：zhipu（bigmodel）与 zhipu-coding（z.ai）走同一套 monitor 接口，key 各自独立
async function queryZhipuQuotaOne(fetchFn, apiKey, providerId, displayName, endpoints) {
  for (const url of endpoints) {
    try {
      const result = await requestJson(fetchFn, url, {
        headers: { Authorization: apiKey, Accept: "application/json" },
      });
      dbg(`${providerId} quota raw: ` + JSON.stringify(result.data).slice(0, 2000));
      const payload = result.data?.data;
      const limits = Array.isArray(payload?.limits) ? payload.limits : [];
      if (!result.ok || result.data?.success === false || !limits.length) continue;
      const windows = limits.map((item) => {
        // 自适应语义：优先用原始数值 usage/limit 计算比例（最准）；
        // 只有 percentage 可用时，通过 usage/limit 一致性自动判断它是已用还是剩余
        const usageN = Number(item?.usage ?? item?.used ?? item?.usedTokens ?? NaN);
        const limitN = Number(item?.limit ?? item?.total ?? item?.totalTokens ?? NaN);
        let used = NaN;
        if (Number.isFinite(usageN) && Number.isFinite(limitN) && limitN > 0) {
          used = (usageN / limitN) * 100;
        } else {
          const raw = Number(item?.percentage ?? item?.usedPercent ?? NaN);
          if (Number.isFinite(raw)) {
            if (Number.isFinite(usageN) && usageN > 0 && usageN <= 100 && Math.abs(raw - usageN) < 1) used = raw;
            else if (raw <= 100) used = raw <= 50 ? raw : raw;
          }
        }
        if (!Number.isFinite(used)) used = 0;
        const rawType = String(item?.type || "quota");
        const typeLabel = { TOKENS_LIMIT: "Token", REQUEST_LIMIT: "请求数", TIME_LIMIT: "时长", MCP_LIMIT: "MCP" }[rawType] || rawType;
        const secs = Number(item?.windowSeconds ?? item?.window_seconds ?? 0);
        const spanLabel = secs >= 86400 ? `${Math.round(secs / 86400)} 天` : secs >= 3600 ? `${Math.round(secs / 3600)} 小时` : secs ? `${Math.round(secs / 60)} 分钟` : "";
        const spanShort = secs >= 86400 ? `${Math.round(secs / 86400)}d` : secs >= 3600 ? `${Math.round(secs / 3600)}h` : secs ? `${Math.round(secs / 60)}m` : "";
        return {
          type: rawType,
          label: (spanLabel ? spanLabel + " " : "") + typeLabel,
          short: (spanShort || spanLabel || "额度") + (rawType === "TOKENS_LIMIT" ? "" : " " + typeLabel),
          usedPercent: Math.max(0, Math.min(100, used)),
          remainingPercent: Math.max(0, Math.min(100, 100 - used)),
          resetAt: item?.nextResetTime || item?.resetAt || null,
          windowSeconds: secs || null,
        };
      });
      const primary = windows.find((item) => item.type === "TOKENS_LIMIT") || windows[0];
      // 把所有窗口都写出来：只说一个百分比，使用者看不出那是哪个额度的
      const windowText = windows.map((w) => `${w.short || w.label} ${w.remainingPercent.toFixed(0)}%`).join(" · ");
      return {
        provider: providerId,
        name: displayName,
        status: "ok",
        kind: "quota",
        label: "套餐剩余",
        summary: windowText || `${primary.remainingPercent.toFixed(0)}%`,
        remainingPercent: primary.remainingPercent,
        resetAt: primary.resetAt,
        windows,
        plan: payload?.level || null,
      };
    } catch {}
  }
  return null;
}

// 返回数组：智谱两家各自可能命中，所以调用处要 flat 一次
async function queryZhipuQuota(ctx, fetchFn, catalog) {
  const endpoints = [
    "https://api.z.ai/api/monitor/usage/quota/limit",
    "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  ];
  const targets = [
    { id: "zhipu", name: "智谱 Coding Plan", key: catalog?.providers?.zhipu?.api_key },
    { id: "zhipu-coding", name: PROVIDER_DIRECTORY["zhipu-coding"]?.name || "智谱 Coding", key: catalog?.providers?.["zhipu-coding"]?.api_key },
  ].filter((t) => t.key);
  const hits = await Promise.all(targets.map((t) => queryZhipuQuotaOne(fetchFn, t.key, t.id, t.name, endpoints)));
  return hits.filter(Boolean);
}

async function queryOpenAICosts(ctx, fetchFn) {
  const key = configValue(ctx, "openaiAdminKey");
  if (!key) return null;
  const cached = cachedExternalStatus("openai-costs", 300000);
  if (cached) return cached;
  const start = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000);
  try {
    const result = await requestJson(fetchFn, `https://api.openai.com/v1/organization/costs?start_time=${start}&bucket_width=1d&limit=31`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    }, 15000);
    if (!result.ok || !Array.isArray(result.data?.data)) return null;
    let total = 0;
    let currency = "USD";
    for (const bucket of result.data.data) {
      for (const item of bucket?.results || []) {
        const amount = item?.amount;
        if (amount?.value != null) total += Number(amount.value) || 0;
        if (amount?.currency) currency = String(amount.currency).toUpperCase();
      }
    }
    return storeExternalStatus("openai-costs", {
      provider: "openai",
      name: "OpenAI API",
      status: "ok",
      kind: "cost",
      label: "本月官方成本",
      summary: `${currency === "USD" ? "$" : ""}${total.toFixed(2)}`,
      total,
      currency,
    });
  } catch {
    return null;
  }
}

/** 子进程读宿主目录下的一个 JSON（App 自己的 fs 被 Permission Model 锁住，读不到宿主数据根）。
 *  只在需要宿主侧凭据时用，读不到就返回 null。 */
async function readHostJsonViaChild(ctx, fileName) {
  try {
    const dir = ctx?.dataDir;
    const root = dir ? dirname(dirname(dir)) : "";
    if (!root) return null;
    const filePath = join(root, fileName);
    const body = "import { readFileSync } from \"node:fs\";\nconst t = readFileSync(process.argv[1], \"utf8\");\nprocess.stdout.write(t);\n";
    const out = await new Promise((resolve) => {
      let buf = ""; let done = false;
      const child = spawn("node", ["--input-type=module", "-e", body, filePath], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => { try { child.kill(); } catch {} if (!done) { done = true; resolve(""); } }, 8000);
      child.stdout.on("data", (c) => { buf += c; });
      child.on("error", () => { clearTimeout(timer); if (!done) { done = true; resolve(""); } });
      child.on("close", () => { clearTimeout(timer); if (!done) { done = true; resolve(buf); } });
    });
    return out ? JSON.parse(out) : null;
  } catch (e) {
    dbg("host json via child failed (" + fileName + "): " + String(e?.message || e));
    return null;
  }
}

/** 走系统代理的 HTTP GET。
 *  背景：App 进程里的 fetch（undici）不读系统代理，本机实测直连 chatgpt.com 一律 fetch failed；
 *  而 PowerShell 的 Invoke-WebRequest 默认读系统代理。需要外网可达的查询（如 Codex 订阅配额）
 *  就从子进程出去。脚本以 UTF-16LE base64 传入，避免凭据出现在明文命令行里。 */
async function fetchJsonViaSystemProxy(url, headers) {
  try {
    const lines = ["$ErrorActionPreference='Stop'", "$h=@{}"];
    for (const [k, v] of Object.entries(headers || {})) {
      lines.push(`$h['${String(k).replace(/'/g, "''")}'] = '${String(v).replace(/'/g, "''")}'`);
    }
    lines.push(`$r = Invoke-WebRequest -Uri '${String(url).replace(/'/g, "''")}' -Headers $h -UseBasicParsing -TimeoutSec 4`);
    lines.push("Write-Output $r.Content");
    const b64 = Buffer.from(lines.join("; "), "utf16le").toString("base64");
    const out = await new Promise((resolve) => {
      let buf = ""; let done = false;
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      // 这条通道只是「顺带查一下订阅额度」，不该比整张卡片的刷新周期还长：
      // 外层等待压到 6s，让它在 /api/balance 的总预算内也能自己收口。
      const timer = setTimeout(() => { try { child.kill(); } catch {} if (!done) { done = true; resolve(""); } }, 6000);
      child.stdout.on("data", (c) => { buf += c; });
      child.on("error", () => { clearTimeout(timer); if (!done) { done = true; resolve(""); } });
      child.on("close", () => { clearTimeout(timer); if (!done) { done = true; resolve(buf); } });
    });
    const text = String(out || "").replace(/^\uFEFF/, "").trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    dbg("system-proxy fetch failed: " + String(e?.message || e));
    return null;
  }
}

/** Codex（ChatGPT Plus/Pro）订阅配额：5 小时窗口 + 周窗口。
 *  凭据先试宿主的 provider:credentials，拿不到再让子进程读 auth.json；
 *  接口是 chatgpt.com 的私有端点，已经实测可用（2026-09-23）。 */
async function queryCodexQuota(ctx, fetchFn) {
  // 失败过的短期内不再重试：这条链要起 PowerShell 子进程走系统代理，
  // 失败一次的成本接近 10s，而卡片每 8s 刷一轮。不记失败就会变成长期红条。
  if (cachedExternalFailure("codex-quota")) return null;
  const cached = cachedExternalStatus("codex-quota", 300000);
  if (cached) return cached;
  try {
    let access = null, accountId = null;
    // ① 宿主凭据接口
    try {
      const r = await ctx?.sdk?.bus?.request?.("provider:credentials", { providerId: "openai-codex" });
      access = r?.access ?? r?.accessToken ?? r?.credentials?.access ?? r?.apiKey ?? null;
      accountId = r?.accountId ?? r?.credentials?.accountId ?? null;
    } catch (e) { dbg("codex creds via sdk: " + String(e?.message || e)); }
    // ② 子进程读宿主 auth.json
    if (!access) {
      const auth = await readHostJsonViaChild(ctx, "auth.json");
      const node = auth?.["openai-codex"] || auth?.openaiCodex || null;
      if (node?.access) { access = node.access; accountId = node.accountId || null; }
    }
    if (!access) { dbg("codex quota: 没拿到凭据"); markExternalFailure("codex-quota", 600000); diagLog("codex quota：没拿到凭据（10 分钟内不再重试）", "Codex 配额：没拿到凭据"); return null; }
    const headers = {
      Authorization: `Bearer ${access}`,
      Accept: "application/json",
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
    };
    if (accountId) headers["ChatGPT-Account-ID"] = accountId;
    // 这条接口必须走外网代理，用子进程发
    const data = await fetchJsonViaSystemProxy("https://chatgpt.com/backend-api/wham/usage", headers);
    if (!data) { dbg("codex quota: 未拿到响应"); markExternalFailure("codex-quota"); diagLog("codex quota：chatgpt.com 私有端点无响应（120 秒内不再重试）", "Codex 配额查询无响应"); return null; }
    const result = { ok: true, status: 200, data };
    const rate = result.data.rate_limit || result.data.rateLimit || result.data;
    const normalizeWindow = (win, name) => {
      if (!win || typeof win !== "object") return null;
      const used = Number(win.used_percent ?? win.usedPercent);
      if (!Number.isFinite(used)) return null;
      const secs = Number(win.limit_window_seconds ?? win.window_seconds ?? 0);
      const spanLabel = secs >= 86400 ? `${Math.round(secs / 86400)} 天` : secs ? `${Math.round(secs / 3600)} 小时` : "";
      return {
        type: name,
        label: spanLabel ? spanLabel + "窗口" : name,
        short: secs >= 86400 ? `${Math.round(secs / 86400)}d` : secs ? `${Math.round(secs / 3600)}h` : name,
        usedPercent: Math.max(0, Math.min(100, used)),
        remainingPercent: Math.max(0, Math.min(100, 100 - used)),
        resetAt: win.reset_at ?? win.resets_at ?? null,
        resetAfterSeconds: win.reset_after_seconds ?? null,
        windowSeconds: secs || null,
      };
    };
    const windows = [
      normalizeWindow(rate.primary_window || rate.primaryWindow || rate.five_hour, "5 小时窗口"),
      normalizeWindow(rate.secondary_window || rate.secondaryWindow || rate.weekly, "周窗口"),
    ].filter(Boolean);
    if (!windows.length) return null;
    const limiting = windows.reduce((min, item) => (item.remainingPercent < min.remainingPercent ? item : min), windows[0]);
    const credits = Number(result.data?.credits?.balance ?? result.data?.credit_balance);
    dbg("codex quota ok: " + windows.map((w) => `${w.label} ${w.usedPercent}%`).join(" / ") + " plan=" + (result.data?.plan_type || "-"));
    // 每个窗口都写出来，不要只给一个百分比：使用者得知道那是 5 小时额度还是周额度
    const windowText = windows.map((w) => `${w.short || w.label} ${w.remainingPercent.toFixed(0)}%`).join(" · ");
    return storeExternalStatus("codex-quota", {
      provider: "openai-codex",
      name: "ChatGPT Codex",
      status: "ok",
      kind: "quota",
      label: "订阅额度",
      summary: windowText || `${limiting.remainingPercent.toFixed(0)}%`,
      remainingPercent: limiting.remainingPercent,
      resetAt: limiting.resetAt,
      windows,
      credits: Number.isFinite(credits) ? credits : null,
      plan: result.data?.plan_type || result.data?.planType || null,
    });
  } catch (e) {
    dbg("codex quota failed: " + String(e?.message || e));
    markExternalFailure("codex-quota");
    diagLog("codex quota 异常：" + String(e?.message || e), "Codex 配额查询异常：" + String(e?.message || e).slice(0, 60));
    return null;
  }
}

async function queryXaiBalance(ctx, fetchFn) {
  const key = configValue(ctx, "xaiManagementKey");
  const teamId = configValue(ctx, "xaiTeamId");
  if (!key || !teamId) return null;
  const cacheKey = `xai-balance:${teamId}`;
  const cached = cachedExternalStatus(cacheKey, 300000);
  if (cached) return cached;
  try {
    const url = `https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(teamId)}/prepaid/balance`;
    const result = await requestJson(fetchFn, url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    }, 15000);
    if (!result.ok) return null;
    const raw = result.data?.total?.val ?? result.data?.total?.value ?? result.data?.total;
    const cents = Number(raw);
    if (!Number.isFinite(cents)) return null;
    const total = Math.abs(cents) / 100;
    return storeExternalStatus(cacheKey, {
      provider: "xai",
      name: "xAI API",
      status: "ok",
      kind: "balance",
      label: "预付余额",
      summary: `$${total.toFixed(2)}`,
      total,
      currency: "USD",
    });
  } catch {
    return null;
  }
}

export default function registerPluginApiRoutes(app, ctx) {
  // 宿主供应商/模型配置变化时，清掉依赖它的缓存，让本次请求就用新配置重算。
  // Hono 的中间件只对它之后注册的 handler 生效，所以这一段必须放在所有 /api 路由之前，
  // 否则 /api/providers、/api/balance 这些先注册的端点永远收不到失效通知，只能干等缓存过期。
  app.use("/api/*", async (c, next) => {
    if (hostConfigChanged(ctx)) invalidateConfigCaches();
    await next();
  });

  try {
    const logDir = ctx?.dataDir || join(getDataRoot(ctx), "plugin-data", "session-insight");
    mkdirSync(logDir, { recursive: true });
    debugLogPath = join(logDir, "session-insight-debug.log");
    diagLogPath = join(logDir, "session-insight-diag.log");
  } catch {
    debugLogPath = null;
    diagLogPath = null;
  }

  // 会话上下文探测：验证新版 surfaceSession 链路能否拿到当前会话 sessionId
  app.get("/api/probe-session", (c) => {
    const pr = c.env?.pluginRouteRequest || null;
    const principal = pr?.principal || null;
    const result = {
      hasRouteRequest: !!pr,
      principalKind: principal?.kind || null,
      credentialId: principal?.credentialId || null,
      agentId: (typeof c.get === "function" && c.get("agentId")) || null,
      ctxSessionId: ctx.sessionId || null,
      ctxSessionPath: ctx.sessionPath || null,
    };
    dbg("probe-session: " + JSON.stringify(result));
    return c.json(result);
  });

  // 纯插件主题源：读取 HanaAgent 持久化外观偏好，不依赖 renderer 补丁
  // v2：外观偏好文件在 App 沙箱里读不到，失败时明确降级，不抛 500。
  // v2：主题由宿主 SDK（hana.theme）下发，这里直接回报不可用；
  // 不再去读 App 沙箱外的外观偏好文件，否则每次调用都会卡到超时。
  app.get("/api/appearance", (c) => c.json({ ok: false, theme: null, source: "unavailable" }));

  // 版本号：v2 App 的更新走「设置 → 扩展」，面板内不做自更新。
  // 这里只把当前版本报给设置页显示；此前那条 GitHub Release 自更新链已移除（在 v2 里无法生效）。
  app.get("/api/version", (c) => c.json({ version: currentPluginVersion(ctx) }));

  // /api/sessions 已由 v2 原生实现接管（见 index.js），这里不再注册。

  // 当前活跃会话（v2 版）：宿主会话列表里最近修改的那个
  app.get("/api/active", async (c) => {
    try {
      const result = await ctx.sdk.sessions.list({ scope: "all", lifecycle: "active" });
      const sessions = result?.sessions ?? [];
      const latest = [...sessions].sort(
        (a, b) => Date.parse(b.modified ?? 0) - Date.parse(a.modified ?? 0)
      )[0];
      const file = latest?.path ? String(latest.path).split(/[\\/]/).pop() : null;
      return c.json({ file, sessionId: latest?.sessionId ?? null });
    } catch (error) {
      return c.json({ file: null, error: String(error?.message ?? error) });
    }
  });

  // entryId → 会话文件：v2 没有这个映射入口，交给前端的 sessions.getActive() 主路径，这里返回空。
  app.get("/api/resolve-entry", (c) => c.json({ file: null }));

  // /api/stats 已由 v2 原生实现接管（见 index.js），这里不再注册。

  // 多供应商余额与供应商列表缓存见模块作用域（invalidateConfigCaches 要能清到它们）
/** v2 版活跃供应商：从宿主的模型目录扫描已配置的供应商（配置过就算活跃，不再靠账本推断），
 *  账本里出现过的也并进来作为兜底。 */
async function computeActiveProvidersV2(ctx) {
  const now = Date.now();
  if (now - providersCache.at < 30000 && providersCache.data) return providersCache.data;
  const byProvider = new Map();
  try {
    const result = await ctx.sdk.models.listAvailable();
    const models = Array.isArray(result) ? result : (result?.models ?? []);
    for (const m of models) {
      const pid = m?.provider;
      if (!pid) continue;
      const item = byProvider.get(pid) || { id: pid, models: new Set() };
      if (m?.id) item.models.add(m.id);
      byProvider.set(pid, item);
    }
  } catch (error) {
    dbg("models.listAvailable failed: " + String(error?.message || error));
  }
  const hostCount = byProvider.size;
  try {
    const { entries } = await readLedgerEntries(ctx);
    // 账本只用作兜底：宿主那边一个都没拿到时才用。
    // 否则已经删掉的供应商会被历史记录拖回卡片列表（凭据清了、配置删了，卡片却还在），
    // 还会把 "unknown" 这类脏值带进来。
    if (byProvider.size === 0) {
      for (const e of entries) {
        const pid = e?.model?.provider;
        if (!pid || pid === "unknown" || byProvider.has(pid)) continue;
        byProvider.set(pid, { id: pid, models: new Set(e?.model?.modelId ? [e.model.modelId] : []) });
      }
    }
  } catch {}
  const list = [...byProvider.values()].map((item) => {
    const dir = PROVIDER_DIRECTORY[item.id] || {};
    return {
      id: item.id,
      name: dir.name || item.id,
      baseUrl: null,
      local: dir.local === true,
      links: dir.links || [],
      launch: launchSummary(item.id),
      view:
        item.id in BALANCE_ADAPTERS || (dir.query && dir.query.kind && dir.query.kind !== "none")
          ? "money"
          : "token",
      models: [...item.models],
    };
  });
  providersCache = { at: now, data: { providers: list } };
  dbg(`providers: host=${hostCount} fallback=${byProvider.size - hostCount} list=[${list.map((p) => p.id + ":" + p.view).join(",")}]`);
  return providersCache.data;
}

app.get("/api/providers", async (c) => c.json(await computeActiveProvidersV2(ctx)));

app.get("/api/balance", async (c) => {
    const now = Date.now();
    const forceBal = c.req.query("force") === "1";
    if (forceBal) { balanceCache = { at: 0, data: null }; flushExternalCaches(); }
    if (!forceBal && now - balanceCache.at < 30000 && balanceCache.data) {
      return c.json(balanceCache.data);
    }
    // v2：provider-catalog.json 在 App 沙箱外读不到，凭据改为逐个走 provider:credentials
    const startedAt = Date.now();
    dbg("balance: catalog loaded, has network.fetch: " + (typeof ctx.network?.fetch === "function"));
    // ctx.network.fetch 不可用时回退全局 fetch（Node 18+）
    const fetchFn =
      typeof ctx.network?.fetch === "function"
        ? (url, opts) => ctx.network.fetch(url, opts)
        : (url, opts) => fetch(url, opts);
    // 配置即唯一真相源：只有宿主里真正启用的供应商才会产生卡片。
    // 有适配器但没启用的（models.json 里已删或没填 key）一律不出卡，避免幽灵供应商。
    const activeIds = new Set((await computeActiveProvidersV2(ctx)).providers.map((p) => p.id));
    if (configValue(ctx, "xaiManagementKey") && configValue(ctx, "xaiTeamId")) activeIds.add("xai");
    // 并行查询所有供应商（避免顺序累加导致最慢的一家拖垮整体）
    const tasks = [];
    for (const [provider, adapter] of Object.entries(BALANCE_ADAPTERS)) {
      if (!activeIds.has(provider)) continue;
      // 刚失败过的那家先歇一会：网络层不通时每次都要吃满 6 秒预算，
      // 会把整张卡片一起拖到前端超时（8s 就 abort）。冷却期内直接给上次的结论。
      if (cachedExternalFailure("balance:" + provider)) {
        tasks.push({
          tag: provider,
          result: Promise.resolve({
            tag: provider, ok: true, ms: 0,
            value: { provider, name: adapter.name, status: "error", detail: "上次查询失败，冷却中" },
          }),
        });
        continue;
      }
      let cred = null;
      try {
        cred = await ctx.sdk.providers.getCredentials({ providerId: provider });
      } catch (error) {
        dbg(`balance ${provider}: credential lookup failed: ${String(error?.message || error)}`);
      }
      if (!cred?.apiKey || !cred?.baseUrl) continue;
      const url = adapter.url(cred.baseUrl);
      tasks.push({
        tag: provider,
        result: budgeted(provider, async () => {
          dbg(`balance ${provider}: fetching ${url}`);
          try {
            const resp = await fetchFn(url, {
              headers: { Authorization: `Bearer ${cred.apiKey}` },
              signal: AbortSignal.timeout(5000),
            });
            const text = await resp.text();
            dbg(`balance ${provider}: http ${resp.status}, body=${text.slice(0, 120)}`);
            let data = null;
            try {
              data = JSON.parse(text);
            } catch {}
            if (!resp.ok) {
              markExternalFailure("balance:" + provider, 300000);
              return { provider, name: adapter.name, status: "http_" + resp.status, detail: text.slice(0, 100) };
            }
            const parsed = adapter.parse(data);
            if (parsed) {
              const symbol = parsed.currency === "USD" ? "$" : "¥";
              return {
                provider,
                name: adapter.name,
                status: "ok",
                kind: "balance",
                label: "可用余额",
                summary: `${symbol}${Number(parsed.total).toFixed(2)}`,
                ...parsed,
              };
            }
            return { provider, name: adapter.name, status: "parse_failed", detail: text.slice(0, 100) };
          } catch (e) {
            dbg(`balance ${provider}: ERROR ${String(e?.message || e)}`);
            markExternalFailure("balance:" + provider, 300000);
            return { provider, name: adapter.name, status: "error", detail: String(e?.message || e).slice(0, 100) };
          }
        }),
      });
    }
    tasks.push({ tag: "zhipu-quota", result: budgeted("zhipu-quota", () => queryZhipuQuota(ctx, fetchFn, { providers: {} })) });
    tasks.push({ tag: "openai-costs", result: budgeted("openai-costs", () => queryOpenAICosts(ctx, fetchFn)) });
    tasks.push({ tag: "openai-codex", result: budgeted("openai-codex", () => queryCodexQuota(ctx, fetchFn)) });
    tasks.push({ tag: "xai-balance", result: budgeted("xai-balance", () => queryXaiBalance(ctx, fetchFn)) });

    // 总预算收口：任何一家慢到超预算都只丢它自己，不拖累已拿到的结果。
    const entries = await Promise.all(tasks.map((task) => task.result));
    const balances = [];
    const steps = [];
    for (const entry of entries) {
      if (!entry.ok) {
        steps.push({ step: entry.tag, status: entry.reason, ms: entry.ms, detail: entry.detail || null });
        continue;
      }
      const values = Array.isArray(entry.value) ? entry.value.filter(Boolean) : entry.value ? [entry.value] : [];
      steps.push({ step: entry.tag, status: values.length ? "ok" : "empty", ms: entry.ms });
      balances.push(...values);
    }
    // 定位快照：前端超时后靠这份数据说清楚是哪一步卡住的，不用重新发请求。
    const slow = steps.filter((s) => s.status === "budget");
    balanceDiag = {
      at: Date.now(),
      tookMs: Date.now() - startedAt,
      budgetMs: BALANCE_BUDGET_MS,
      slow: slow.map((s) => s.step),
      failed: steps.filter((s) => s.status === "error").map((s) => s.step),
      empty: steps.filter((s) => s.status === "empty").map((s) => s.step),
      steps,
    };
    if (slow.length) dbg(`balance 超预算 ${BALANCE_BUDGET_MS}ms，未返回: ${slow.map((s) => s.step).join(", ")}`);
    // 只有真的出问题的轮次才写定位日志，全部正常时不产生噪音。
    if (slow.length || balanceDiag.failed.length) {
      const bad = steps.filter((s) => s.status !== "ok" && s.status !== "empty");
      diagLog(
        `balance 异常｜总耗时 ${balanceDiag.tookMs}ms（预算 ${BALANCE_BUDGET_MS}ms）｜` + bad.map(fmtStep).join("｜"),
        `余额查询异常（${balanceDiag.tookMs}ms）：` + bad.map((s) => `${s.step}=${s.status}`).join(", ")
      );
    }
    const okProviders = new Set(balances.filter((item) => item.status === "ok").map((item) => item.provider));
    const unsupported = [];
    // 未查到的供应商按目录分两类（判据是 query.reachable，不靠文案猜）：
    //   true  官方有余额/配额/用量接口，只是这次没走到 → 亮红
    //   false 官方没有可查接口，或本来就是免费/本地 → 灰灯（本地另按 local 标粉）
    for (const [provider, dir] of Object.entries(PROVIDER_DIRECTORY)) {
      if (!activeIds.has(provider) || okProviders.has(provider)) continue;
      if (provider in BALANCE_ADAPTERS) continue; // 有适配器的供应商由余额查询结果决定状态
      const q = dir.query || {};
      let note = q.note || "暂无余额接口";
      if (provider === "openai" && configValue(ctx, "openaiAdminKey")) note = "Admin Costs 查询失败";
      unsupported.push({ provider, note, reachable: q.reachable === true });
    }
    balanceCache = { at: now, data: { balances, unsupported } };
    dbg(`balance: active=${activeIds.size} ok=[${[...okProviders].join(",")}] unsupported=[${unsupported.map((u) => u.provider + (u.reachable ? "*" : "")).join(",")}]`);
    return c.json(balanceCache.data);
  });

  // 余额查询定位：只读最近一次的快照，不触发任何外部请求。
  app.get("/api/balance-diag", (c) =>
    c.json(balanceDiag ? { ...balanceDiag, ago: Date.now() - balanceDiag.at } : { at: null, hint: "还没有跑过余额查询" })
  );

  // 前端上报请求失败：界面弹窗只显示一句短话，详细定位落在这份日志里。
  app.post("/api/diag-report", async (c) => {
    try {
      const body = await c.req.json();
      const path = String(body?.path || "").slice(0, 120);
      const err = String(body?.error || "").slice(0, 160);
      const ms = Math.max(0, Number(body?.ms) || 0);
      const attempt = Math.max(0, Number(body?.attempt) || 0);
      // 余额类请求失败时，把后端上一轮的定位快照一并写下，前端超时也能看到卡在哪一步。
      const steps = path.startsWith("/api/balance") && balanceDiag && Array.isArray(balanceDiag.steps) ? balanceDiag.steps : [];
      const bad = steps.filter((s) => s.status === "budget" || s.status === "error");
      const slowest = steps.slice().sort((a, b) => (b.ms || 0) - (a.ms || 0))[0];
      const extra =
        steps.length
          ? `｜后端上一轮 ${balanceDiag.tookMs}ms（预算 ${balanceDiag.budgetMs}ms）` +
            (bad.length ? `｜异常: ${bad.map(fmtStep).join(", ")}` : "") +
            (slowest && slowest.ms >= 800 ? `｜最慢一步 ${fmtStep(slowest)}` : "")
          : "";
      diagLog(
        `前端请求失败 ${path}｜${err}｜耗时 ${ms}ms${attempt ? `｜第 ${attempt} 次` : ""}${extra}`,
        `${path} 请求失败：${err}${bad.length ? "（" + bad.map((s) => s.step + "=" + s.status).join(", ") + "）" : ""}`
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: String(e?.message || e) });
    }
  });

  // 全局用量总览（agent/来源/日期/模型/延迟聚合，30s 缓存，可传 ?provider= 过滤）
  app.get("/api/ledger-stats", async (c) => {
    const provider = c.req.query("provider") || null;
    if(c.req.query("force")==="1"){ ledgerStatsCache = { at: 0, provider: null }; }
    const r = await computeLedgerStats(ctx, provider);
    return c.json(r);
  });

  // KPI 每秒通道：只回总览页顶部那六个数字（总量/起算日/命中率/总费用/调用数/异常）。
  // 快通道优先读宿主的按天汇总表（一条聚合查询，代价极小），做到 1～2 秒级新鲜度；
  // 读不到汇总就退回完整账本聚合（10 秒缓存），那时新鲜度回到 10 秒级。
  // 总费用要按模型价格算，保持 10 秒档。
  app.get("/api/hero-stats", async (c) => {
    try {
      // TTL 从 1 秒提到 10 秒：数据本来就是按天汇总的，秒级新鲜度没有意义，
      // 而这里是同步 open 数据库 + 跑全表聚合（DatabaseSync），跑在宿主主进程上。
      const rolls = await readHostDailyRollups(ctx, 10000);
      let fast = false, tokens = null, calls = null, hitRate = null, firstDay = null;
      // 总值优先取本地永久库：它把宿主历史灌进来做基线、之后只增不减，
      // 所以宿主以后清理旧数据也不会让这几个数缩水。还没建起来才退回下面两条路。
      const saved = dailyTotals(ctx);
      if (saved) {
        fast = true;
        tokens = saved.tokens;
        calls = saved.calls;
        hitRate = saved.hit + saved.miss > 0 ? saved.hit / (saved.hit + saved.miss) : null;
        firstDay = saved.firstDay;
      } else if (Array.isArray(rolls) && rolls.length) {
        fast = true;
        let ri = 0, rh = 0, rt = 0, rc = 0;
        const days = [];
        for (const r of rolls) {
          if (r.d) days.push(String(r.d));
          ri += Number(r.input || 0); rh += Number(r.cacheHit || 0);
          rt += Number(r.tokens || 0); rc += Number(r.calls || 0);
        }
        const miss = ri < rh ? ri : Math.max(0, ri - rh);
        tokens = rt; calls = rc;
        hitRate = rh + miss > 0 ? rh / (rh + miss) : null;
        firstDay = days.length ? days.sort()[0].slice(0, 10) : null;
      } else {
        const lg = await computeLedgerStats(ctx, null, 10000);
        const days = lg?.days || {};
        tokens = Object.values(days).reduce((n, d) => n + (Number(d?.tokens) || 0), 0);
        calls = lg?.calls ?? 0;
        hitRate = lg?.tokens?.hitRate ?? null;
        firstDay = lg?.coverage?.firstDay ?? null;
      }
      // 金额同样优先用永久库，它不在才去算一次宿主侧总额（那个每次都要跑，能省则省）
      let totalCost = saved ? saved.cost : null;
      if (totalCost == null) {
        const tc = await computeTotalCost(ctx, 10000);
        totalCost = tc?.totalCost ?? null;
      }
      return c.json({
        at: Date.now(),
        fast,
        tokens,
        firstDay,
        calls,
        errors: 0,
        hitRate,
        totalCost,
      });
    } catch (e) {
      return c.json({ error: String(e?.message || e) }, 500);
    }
  });

  // 实时调用事件流：最近若干条 ledger entry 摘要（事件时间线真实渲染）
  app.get("/api/events", async (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 40));
    // hours：按时间范围过滤（0 = 不限）
    const hours = Math.min(24 * 30, Math.max(0, Number(c.req.query("hours")) || 0));
    const provider = c.req.query("provider") || null;
    // 诊断条目也随同返回：面板「日志」区里直接能看见插件自己出过的错，不用去翻日志文件。
    const diagOut = () => {
      const cut = hours > 0 ? Date.now() - hours * 3600e3 : 0;
      return diagEvents.filter((d) => d.at >= cut).slice(-30).map((d) => ({ ts: new Date(d.at).toISOString(), text: d.text, kind: "diag" }));
    };
    try {
      let rows = (await readLedgerEntries(ctx)).entries;
      if (!rows.length) return c.json({ at: Date.now(), empty: true, entries: [], diags: diagOut() });
      if (hours > 0) {
        const cut = Date.now() - hours * 3600e3;
        rows = rows.filter(e => { const t = Date.parse(e.startedAt || ""); return Number.isFinite(t) && t >= cut; });
      }
      const filtered = provider ? rows.filter(e => e.model?.provider === provider) : rows;
      if (!filtered.length) return c.json({ at: Date.now(), entries: [], total: 0, hours, diags: diagOut() });
      filtered.sort((a,b)=>Date.parse(b.startedAt||"0")-Date.parse(a.startedAt||"0"));
      const out = filtered.slice(0, limit).map(e => {
        const cost = calcEntryCost(e);
        const u = e.usage || {};
        const inp = u.input?.totalTokens ?? u.input?.uncachedTokens ?? 0;
        const outTok = u.output?.totalTokens ?? 0;
        return {
          ts: e.startedAt || null,
          model: e.model?.modelId || "unknown",
          provider: e.model?.provider || null,
          subsystem: e.source?.subsystem || "other",
          agentId: e.attribution?.agentId || "unknown",
          agentKind: e.attribution?.kind || "other",
          durationMs: e.durationMs ?? null,
          status: e.status || "ok",
          cost: cost == null ? null : Math.round(cost*1000000)/1000000,
          input: inp,
          output: outTok,
          cacheHit: e.usage?.cache?.hitTokens ?? e.usage?.cache?.readTokens ?? null,
          cacheMiss: missOf(e.usage ?? {}),
          hitRatio: e.usage?.cache?.hitRatio != null ? e.usage.cache.hitRatio : null,
        };
      });
      return c.json({ at: Date.now(), entries: out, total: filtered.length, hours, diags: diagOut() });
    } catch (e) {
      return c.json({ at: Date.now(), error: String(e?.message||e), entries: [], diags: diagOut() });
    }
  });

  // 阈值提醒规则：按供应商持久化
  function rulesFilePath(){
    const dir = ctx?.dataDir || join(getDataRoot(ctx), "plugin-data", "session-insight");
    mkdirSync(dir, { recursive: true });
    return join(dir, "rules.json");
  }
  app.get("/api/rules", (c) => {
    try {
      const fp = rulesFilePath();
      return c.json(existsSync(fp) ? JSON.parse(readFileSync(fp, "utf8")) : {});
    } catch { return c.json({}); }
  });
  app.post("/api/rules", async (c) => {
    try {
      const body = await c.req.json();
      const key = String(body?.provider || "").slice(0, 40);
      if (!key) return c.json({ error: "no provider" });
      const fp = rulesFilePath();
      const cur = existsSync(fp) ? JSON.parse(readFileSync(fp, "utf8")) : {};
      cur[key] = { enabled: !!body.enabled, pct: Math.max(5, Math.min(95, Number(body.pct) || 20)), amount: body.amount != null && Number.isFinite(Number(body.amount)) ? Math.max(1, Math.min(100000, Math.round(Number(body.amount)))) : (cur[key]?.amount ?? null), fail: Math.max(1, Math.min(10, Number(body.fail) || 3)) };
      writeFileSync(fp, JSON.stringify(cur, null, 2));
      return c.json({ ok: true, provider: key, saved: cur[key] });
    } catch (e) { return c.json({ error: String(e?.message || e) }); }
  });

  // 总消费金额（按用量总账计算，30s 缓存）
  app.get("/api/total-cost", async (c) => {
    const r = await computeTotalCost(ctx);
    return c.json(r);
  });

  // 每百万 Token 价格表：来自远程计费数据库（缓存 24h）或内置快照，标注更新时间与来源
  app.get("/api/pricing", async (c) => {
    await loadPricingDb(ctx);
    const rows = [];
    // 价格键可能是「<provider>::<model>」限定键，也可能是裸模型名。
    // 有裸键的模型只呈现一次（走裸键那行）；只有跨厂商同名的才单独按限定键列出。
    const bareModels = new Set();
    for (const k of Object.keys(PRICING)) if (!k.includes("::")) bareModels.add(k);
    // 只展示宿主里真正配置/登录过的供应商与模型（价格库是全量收录，界面要按配置过滤）
    const configured = (await computeActiveProvidersV2(ctx)).providers || [];
    const cfgByProvider = new Map();
    const cfgModelSet = new Set();
    for (const p of configured) {
      const set = new Set(p.models || []);
      cfgByProvider.set(p.id, set);
      for (const m of set) cfgModelSet.add(m);
    }
    // 供应商 id 存在变体（xai-oauth / zhipu-coding 等），匹配不上时退回按模型名判断
    const keepByConfig = (provider, model) => {
      if (!provider) return false;
      const set = cfgByProvider.get(provider);
      if (set) return set.size === 0 || set.has(model);
      return cfgModelSet.has(model);
    };
    for (const [key, cfg] of Object.entries(PRICING)) {
      const sep = key.indexOf("::");
      const scopedProvider = sep > 0 ? key.slice(0, sep) : null;
      const model = sep > 0 ? key.slice(sep + 2) : key;
      if (scopedProvider && bareModels.has(model)) continue;
      const provider = scopedProvider || PROVIDER_OF_MODEL[key] || null;
      if (!keepByConfig(provider, model)) continue;
      const srcNote = SOURCE_NOTE[key] || SOURCE_NOTE[model] || "";
      if (cfg && cfg.peak) {
        rows.push({ model, provider, tier: "peak", miss: cfg.peak.inputMiss, hit: cfg.peak.inputHit, out: cfg.peak.output, note: srcNote, status: "listed" });
        rows.push({ model, provider, tier: "offPeak", miss: cfg.offPeak.inputMiss, hit: cfg.offPeak.inputHit, out: cfg.offPeak.output, note: srcNote, status: "listed" });
      } else if (cfg) {
        rows.push({ model, provider, tier: "flat", miss: cfg.inputMiss, hit: cfg.inputHit, out: cfg.output, note: srcNote, status: "listed" });
      }
    }
    // 以当前已配置供应商的模型全集为骨架；没有可靠价格时也必须列出并明确标记。
    const listedModels = new Set(rows.map((r) => r.model));
    for (const p of configured) {
      for (const model of p.models || []) {
        if (listedModels.has(model)) continue;
        rows.push({ model, provider: p.id, tier: "unknown", miss: null, hit: null, out: null, note: "官方价格未收录", status: "unlisted" });
        listedModels.add(model);
      }
    }
    return c.json({ snapshotAt: PRICING_SNAPSHOT_AT, currency: "CNY", rows, completeForConfiguredModels: true, db: { source: pricingDbState.source, ok: pricingDbState.ok, error: pricingDbState.error, fetchedAt: pricingDbState.at || null } });
  });

  // 手动重新加载：重拉计费数据库 + 重读宿主供应商配置 + 清缓存
  // GET 与 POST 都接受，方便排查与手动触发
  const reloadConfigHandler = async (c) => {
    hostConfigStamp = null;
    invalidateConfigCaches();
    const db = await loadPricingDb(ctx, true);
    // 供应商集合必须用 v2 那条路径（宿主的模型目录）重算：
    // 旧的文件式读法在 v2 沙箱里读不到东西，会把空列表写进共享缓存，
    // 价格表按配置过滤后就成了「暂无计费规则」。
    let configuredCount = 0;
    try { configuredCount = (await computeActiveProvidersV2(ctx)).providers.length; } catch {}
    return c.json({
      ok: true,
      pricing: { source: db.source, ok: db.ok, error: db.error, snapshotAt: db.snapshotAt, fetchedAt: db.at || null },
      models: Object.keys(PRICING).filter((k) => !k.includes("::")).length,
      scopedModels: Object.keys(PRICING).filter((k) => k.includes("::")).length,
      configuredProviders: configuredCount,
    });
  };
  app.post("/api/reload-config", reloadConfigHandler);
  app.get("/api/reload-config", reloadConfigHandler);

  // 打开外链与拉起本地程序的路由已移除：v2 App 的沙箱不允许拉起外部进程，
  // /api/open 只能回一句空话、/api/open-app 固定报 not_supported_in_app，
  // 两者都无法真正生效。打开外链改由页面直接走宿主能力 hana.external.open。
}
