// routes/api.js — 会话统计 / 会话列表 / 多供应商余额
import { readFileSync, statSync, existsSync, appendFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { PROVIDER_OF_MODEL, PRICING, priceFor, SOURCE_NOTE, PRICING_SNAPSHOT_AT, setPricingConfig } from "../lib/usage-parser.js";
import { PROVIDER_DIRECTORY, launchSummary, billingModeOf } from "../lib/provider-directory.js";

let debugLogPath = null;
function dbg(msg) {
  try {
    if (!debugLogPath) return;
    appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// 日界/小时界跟随系统本地时区，与前端显示同源（用户看到的就是本机时间）。
// 此前直接用 startedAt 的 ISO 串前 10/13 个字符切分，等价于 UTC 日，而前端「今日」用的是本地时区，
// 两端不一致会让凌晨的调用归错天；现在两端统一按本地时区。
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


async function computeTotalCost(ctx) {
  const now = Date.now();
  if (now - ledgerCache.at < 10000) return ledgerCache;
  try {
    const { entries: ledgerEntries } = await readLedgerEntries(ctx);
    if (!ledgerEntries.length) return { at: now, totalCost: null, perProvider: {}, perModel: {}, todayCost: 0, todayProvider: {}, todayModel: {} };
    let totalCost = 0;
    const perProvider = {};
    const perModel = {};
    const todayProvider = {};
    const todayModel = {};
    const todayStr = fmtDay(Date.now());
    let todayCost = 0;
    for (const e of ledgerEntries) {
      const model = e.model?.modelId;
      const provider = e.model?.provider;
      const cost = calcEntryCost(e);
      if (cost == null) continue;
      totalCost += cost;
      if (provider) perProvider[provider] = (perProvider[provider] || 0) + cost;
      if (model) perModel[model] = (perModel[model] || 0) + cost;
      let isToday = false;
      if (e.startedAt) isToday = fmtDay(e.startedAt) === todayStr;
      if (isToday) {
        todayCost += cost;
        if (provider) todayProvider[provider] = (todayProvider[provider] || 0) + cost;
        if (model) todayModel[model] = (todayModel[model] || 0) + cost;
      }
    }
    ledgerCache = {
      at: now,
      totalCost: Math.round(totalCost * 100) / 100,
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
async function computeLedgerStats(ctx, provider) {
  const now = Date.now();
    if (now - ledgerStatsCache.at < 10000 && ledgerStatsCache.provider === provider) return ledgerStatsCache;
  try {
    const { entries: ledgerEntries } = await readLedgerEntries(ctx);
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
      const miss = u.cache?.missTokens != null ? u.cache.missTokens : (u.input?.uncachedTokens != null ? u.input.uncachedTokens : inTot);
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
      for (const r of hostRollups) {
        const d = r.d;
        if (d) {
          const cur = byDay[d] || (byDay[d] = { calls: 0, tokens: 0, cost: 0 });
          cur.tokens = Number(r.tokens || 0);
          cur.calls = Number(r.calls || 0);
          cur.cacheHit = Number(r.cacheHit || 0);
          cur.cacheMiss = Math.max(0, Number(r.input || 0) - Number(r.cacheHit || 0));
        }
        ri += Number(r.input || 0); ro += Number(r.output || 0);
        rh += Number(r.cacheHit || 0); rt += Number(r.tokens || 0); rc += Number(r.calls || 0);
      }
      if (rt > 0) { tokInput = ri; tokOutput = ro; tokCacheHit = rh; tokCacheMiss = Math.max(0, ri - rh); tokTotal = rt; callCount = rc; }
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

function getDataRoot(ctx) {
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
// 账本条目：宿主自 2026-09-09 起把账本迁到 SQLite（usage-ledger.sqlite.usage_entries），旧 JSON 文件已停更。
// 优先读 SQLite，读不到再回退 JSON；两边条目结构一致（entry_json 就是原来的 entry 对象）。
let ledgerEntriesCache = { at: 0, entries: [], source: null };
async function readLedgerEntries(ctx) {
  // v2：账本改走宿主 usage:list。原来直读 HANA_HOME 下的 SQLite / JSON，
  // 在 App 的沙箱里拿不到那条路径；旧实现保留在 _legacyReadLedgerEntries 里仅作参考。
  const now = Date.now();
  if (now - ledgerEntriesCache.at < 30000) return ledgerEntriesCache;
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
const ROLLUP_SQL = "SELECT stat_day AS d, SUM(request_count) AS calls, SUM(total_tokens) AS tokens, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheHit FROM usage_daily_rollups GROUP BY stat_day";

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
    const script = join(dir, "_rollups_probe.mjs");
    const body = "import { DatabaseSync } from \"node:sqlite\";\nconst db = new DatabaseSync(process.argv[2], { readOnly: true });\nconst rows = db.prepare(" + JSON.stringify(ROLLUP_SQL) + ").all();\ndb.close();\nprocess.stdout.write(JSON.stringify(rows));\n";
    writeFileSync(script, body, "utf8");
    const out = await new Promise((resolve) => {
      let buf = "";
      let done = false;
      const child = spawn("node", [script, dbPath], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => { try { child.kill(); } catch {} if (!done) { done = true; resolve(""); } }, 8000);
      child.stdout.on("data", (c) => { buf += c; });
      child.on("error", (e) => { clearTimeout(timer); if (!done) { done = true; dbg("rollups child error: " + String(e?.message || e)); resolve(""); } });
      child.on("close", () => { clearTimeout(timer); if (!done) { done = true; resolve(buf); } });
    });
    try { rmSync(script, { force: true }); } catch {}
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

async function readHostDailyRollups(ctx) {
  if (Date.now() - rollupsCache.at < 60000) return rollupsCache.rows;
  rollupsCache = { at: Date.now(), rows: null };
  const dbPath = hostRootGuess(ctx) ? join(hostRootGuess(ctx), "usage-ledger.sqlite") : "";
  let rows = null;
  try {
    if (dbPath && existsSync(dbPath)) {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      rows = db.prepare(ROLLUP_SQL).all();
      db.close();
      if (rows?.length) dbg("rollups direct ok: " + rows.length + " 天");
    }
  } catch (e) {
    dbg("rollups direct failed: " + String(e?.message || e));
  }
  if (!rows?.length) rows = await readRollupsViaChild(ctx, dbPath);
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
const BALANCE_ADAPTERS = {
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
};

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
function hostConfigChanged(ctx) {
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

function cachedExternalStatus(key, ttlMs) {
  const cached = externalStatusCache.get(key);
  return cached && Date.now() - cached.at < ttlMs ? cached.data : null;
}

function storeExternalStatus(key, data) {
  externalStatusCache.set(key, { at: Date.now(), data });
  return data;
}

function flushExternalCaches(){ externalStatusCache.clear(); }

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
        return {
          type: String(item?.type || "quota"),
          usedPercent: Math.max(0, Math.min(100, used)),
          remainingPercent: Math.max(0, Math.min(100, 100 - used)),
          resetAt: item?.nextResetTime || item?.resetAt || null,
        };
      });
      const primary = windows.find((item) => item.type === "TOKENS_LIMIT") || windows[0];
      return {
        provider: providerId,
        name: displayName,
        status: "ok",
        kind: "quota",
        label: "套餐剩余",
        summary: `${primary.remainingPercent.toFixed(0)}%`,
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
    const script = join(dir, "_read_json_probe.mjs");
    const filePath = join(root, fileName);
    const body = "import { readFileSync } from \"node:fs\";\nconst t = readFileSync(process.argv[2], \"utf8\");\nprocess.stdout.write(t);\n";
    writeFileSync(script, body, "utf8");
    const out = await new Promise((resolve) => {
      let buf = ""; let done = false;
      const child = spawn("node", [script, filePath], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => { try { child.kill(); } catch {} if (!done) { done = true; resolve(""); } }, 8000);
      child.stdout.on("data", (c) => { buf += c; });
      child.on("error", () => { clearTimeout(timer); if (!done) { done = true; resolve(""); } });
      child.on("close", () => { clearTimeout(timer); if (!done) { done = true; resolve(buf); } });
    });
    try { rmSync(script, { force: true }); } catch {}
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
    lines.push(`$r = Invoke-WebRequest -Uri '${String(url).replace(/'/g, "''")}' -Headers $h -UseBasicParsing -TimeoutSec 25`);
    lines.push("Write-Output $r.Content");
    const b64 = Buffer.from(lines.join("; "), "utf16le").toString("base64");
    const out = await new Promise((resolve) => {
      let buf = ""; let done = false;
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => { try { child.kill(); } catch {} if (!done) { done = true; resolve(""); } }, 30000);
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
    if (!access) { dbg("codex quota: 没拿到凭据"); return null; }
    const headers = {
      Authorization: `Bearer ${access}`,
      Accept: "application/json",
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
    };
    if (accountId) headers["ChatGPT-Account-ID"] = accountId;
    // 这条接口必须走外网代理，用子进程发
    const data = await fetchJsonViaSystemProxy("https://chatgpt.com/backend-api/wham/usage", headers);
    if (!data) { dbg("codex quota: 未拿到响应"); return null; }
    const result = { ok: true, status: 200, data };
    const rate = result.data.rate_limit || result.data.rateLimit || result.data;
    const normalizeWindow = (win, name) => {
      if (!win || typeof win !== "object") return null;
      const used = Number(win.used_percent ?? win.usedPercent);
      if (!Number.isFinite(used)) return null;
      const secs = Number(win.limit_window_seconds ?? win.window_seconds ?? 0);
      return {
        type: name,
        label: secs >= 86400 ? `${Math.round(secs / 86400)} 天窗口` : secs ? `${Math.round(secs / 3600)} 小时窗口` : name,
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
    return storeExternalStatus("codex-quota", {
      provider: "openai-codex",
      name: "ChatGPT Codex",
      status: "ok",
      kind: "quota",
      label: "订阅额度",
      summary: `${limiting.remainingPercent.toFixed(0)}%`,
      remainingPercent: limiting.remainingPercent,
      resetAt: limiting.resetAt,
      windows,
      credits: Number.isFinite(credits) ? credits : null,
      plan: result.data?.plan_type || result.data?.planType || null,
    });
  } catch (e) {
    dbg("codex quota failed: " + String(e?.message || e));
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
  } catch {
    debugLogPath = null;
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
  try {
    const { entries } = await readLedgerEntries(ctx);
    for (const e of entries) {
      const pid = e?.model?.provider;
      if (!pid || byProvider.has(pid)) continue;
      byProvider.set(pid, { id: pid, models: new Set(e?.model?.modelId ? [e.model.modelId] : []) });
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
      let cred = null;
      try {
        cred = await ctx.sdk.providers.getCredentials({ providerId: provider });
      } catch (error) {
        dbg(`balance ${provider}: credential lookup failed: ${String(error?.message || error)}`);
      }
      if (!cred?.apiKey || !cred?.baseUrl) continue;
      const url = adapter.url(cred.baseUrl);
      tasks.push(
        (async () => {
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
            return { provider, name: adapter.name, status: "error", detail: String(e?.message || e).slice(0, 100) };
          }
        })()
      );
    }
    tasks.push(queryZhipuQuota(ctx, fetchFn, { providers: {} }));
    tasks.push(queryOpenAICosts(ctx, fetchFn));
    tasks.push(queryCodexQuota(ctx, fetchFn));
    tasks.push(queryXaiBalance(ctx, fetchFn));

    const balances = (await Promise.all(tasks)).flat().filter(Boolean);
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
    return c.json(balanceCache.data);
  });

  // 全局用量总览（agent/来源/日期/模型/延迟聚合，30s 缓存，可传 ?provider= 过滤）
  app.get("/api/ledger-stats", async (c) => {
    const provider = c.req.query("provider") || null;
    if(c.req.query("force")==="1"){ ledgerStatsCache = { at: 0, provider: null }; }
    const r = await computeLedgerStats(ctx, provider);
    return c.json(r);
  });

  // 实时调用事件流：最近若干条 ledger entry 摘要（事件时间线真实渲染）
  app.get("/api/events", async (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 40));
    // hours：按时间范围过滤（0 = 不限）
    const hours = Math.min(24 * 30, Math.max(0, Number(c.req.query("hours")) || 0));
    const provider = c.req.query("provider") || null;
    try {
      let rows = (await readLedgerEntries(ctx)).entries;
      if (!rows.length) return c.json({ at: Date.now(), empty: true, entries: [] });
      if (hours > 0) {
        const cut = Date.now() - hours * 3600e3;
        rows = rows.filter(e => { const t = Date.parse(e.startedAt || ""); return Number.isFinite(t) && t >= cut; });
      }
      const filtered = provider ? rows.filter(e => e.model?.provider === provider) : rows;
      if (!filtered.length) return c.json({ at: Date.now(), entries: [], total: 0, hours });
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
          cacheHit: e.usage?.cache?.hitTokens ?? null,
          cacheMiss: e.usage?.cache?.missTokens ?? null,
          hitRatio: e.usage?.cache?.hitRatio != null ? e.usage.cache.hitRatio : null,
        };
      });
      return c.json({ at: Date.now(), entries: out, total: filtered.length, hours });
    } catch (e) {
      return c.json({ at: Date.now(), error: String(e?.message||e), entries: [] });
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
