// routes/api.js — 会话统计 / 会话列表 / 多供应商余额
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync } from "node:fs";
import { exec } from "node:child_process";
import { join } from "node:path";
import { parseSession, PROVIDER_OF_MODEL, PRICING } from "../lib/usage-parser.js";

const DEBUG_LOG = "D:\\AI\\Hanako\\OH-WorkSpace\\session-insight-debug.log";
function dbg(msg) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// 用量总账（总消费数据源）
const LEDGER = "D:\\AI\\Hanako\\usage-ledger.json";
let ledgerCache = { at: 0, totalCost: 0, perProvider: {}, perModel: {} };

function calcCostByModel(model, inputMiss, inputHit, output) {
  const p = PRICING[model];
  if (!p) return null;
  return (inputMiss / 1e6) * p.inputMiss + (inputHit / 1e6) * p.inputHit + (output / 1e6) * p.output;
}
// 单条 ledger entry 的费用（输入按未命中/命中拆分，缓存窗口值不重复计费）
function calcEntryCost(e) {
  const model = e?.model?.modelId;
  const p = PRICING[model];
  if (!p) return null;
  const u = e.usage || {};
  const inputTotal = u.input?.totalTokens ?? u.input?.uncachedTokens ?? 0;
  const uncached = u.input?.uncachedTokens ?? u.cache?.missTokens ?? inputTotal;
  const inputMiss = Math.min(inputTotal, uncached ?? inputTotal);
  const inputHit = Math.max(0, inputTotal - inputMiss);
  const output = u.output?.totalTokens ?? 0;
  return (inputMiss / 1e6) * p.inputMiss + (inputHit / 1e6) * p.inputHit + (output / 1e6) * p.output;
}


function computeTotalCost() {
  const now = Date.now();
  if (now - ledgerCache.at < 30000) return ledgerCache;
  try {
    if (!existsSync(LEDGER)) return { at: now, totalCost: null, perProvider: {}, perModel: {} };
    const data = JSON.parse(readFileSync(LEDGER, "utf8"));
    let totalCost = 0;
    const perProvider = {};
    const perModel = {};
    for (const e of data.entries || []) {
      const model = e.model?.modelId;
      const provider = e.model?.provider;
      const cost = calcEntryCost(e);
      if (cost == null) continue;
      totalCost += cost;
      if (provider) perProvider[provider] = (perProvider[provider] || 0) + cost;
      if (model) perModel[model] = (perModel[model] || 0) + cost;
    }
    ledgerCache = {
      at: now,
      totalCost: Math.round(totalCost * 100) / 100,
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
function computeLedgerStats(provider) {
  const now = Date.now();
  if (now - ledgerStatsCache.at < 30000 && ledgerStatsCache.provider === provider) return ledgerStatsCache;
  try {
    if (!existsSync(LEDGER)) return { at: now, empty: true, provider };
    const data = JSON.parse(readFileSync(LEDGER, "utf8"));
    const byAgent = {}, bySubsystem = {}, byDay = {}, byModel = {}, latBuckets = { lt1: 0, "1_3": 0, "3_10": 0, gt10: 0 };
    const latAll = [];
    let callCount = 0, errCount = 0;
    for (const e of data.entries || []) {
      if (provider && e.model?.provider !== provider) continue; // 按供应商过滤
      const cost = calcEntryCost(e);
      const cc = cost || 0;
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
      bySubsystem[sub] = bySubsystem[sub] || { calls: 0, cost: 0 };
      bySubsystem[sub].calls++;
      bySubsystem[sub].cost += cc;
      // 日期
      const d = String(e.startedAt || "").slice(0, 10);
      if (d) {
        byDay[d] = byDay[d] || { calls: 0, tokens: 0, cost: 0 };
        byDay[d].calls++;
        byDay[d].tokens += e.usage?.totalTokens || 0;
        byDay[d].cost += cc;
      }
      // 模型
      const m = e.model?.modelId || "unknown";
      byModel[m] = byModel[m] || { calls: 0, cost: 0 };
      byModel[m].calls++;
      byModel[m].cost += cc;
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
    ledgerStatsCache = {
      at: now,
      provider,
      calls: callCount,
      errors: errCount,
      agents: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, { calls: v.calls, cost: round2(v.cost), tokens: v.tokens }])),
      subsystems: Object.fromEntries(Object.entries(bySubsystem).map(([k, v]) => [k, { calls: v.calls, cost: round2(v.cost) }])),
      days: Object.fromEntries(Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, { calls: v.calls, tokens: v.tokens, cost: round2(v.cost) }])),
      models: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, { calls: v.calls, cost: round2(v.cost) }])),
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

const DEFAULT_SESSIONS_DIR = "D:\\AI\\Hanako\\agents\\hanako\\sessions";
const PROVIDER_CATALOG = "D:\\AI\\Hanako\\provider-catalog.json";

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

// 无公开余额接口的供应商说明
const NO_BALANCE_API = {
  mimo: "余额接口未开放",
  zhipu: "余额接口未开放",
  agnes: "余额接口未开放",
  openai: "官方无余额查询",
  gemini: "按计费账户计费",
};

function getSessionsDir(ctx) {
  try {
    const dir = ctx.config?.get?.("sessionsDir");
    if (dir && existsSync(dir)) return dir;
  } catch {}
  return DEFAULT_SESSIONS_DIR;
}

function listSessionFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const full = join(dir, name);
      const st = statSync(full);
      return { name, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// 会话标题：取首条真实用户消息的文本摘要
function detectSessionTitle(dir, name) {
  try {
    // 读全文件（提前终止：找到第一条真实 user 消息即返回）
    const fd = readFileSync(join(dir, name), { encoding: "utf8" });
    const lines = fd.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "message" && obj.message && obj.message.role === "user") {
          const c = obj.message.content;
          let t = "";
          if (Array.isArray(c)) {
            const text = c.find((x) => x && x.type === "text");
            if (text && text.text) t = text.text;
          } else if (typeof c === "string") {
            t = c;
          }
          const s = (t || "").trim();
          if (!s) continue;
          // 跳过系统注入的 user 消息（工具列表/提醒/文件附件），取用户真实的第一句话
          if (/^\[hana_(reference|reminder|skill|file)/i.test(s)) continue;
          if (/^\[sessionfile\]/i.test(s)) continue;
          if (/^<file name=/i.test(s)) continue;
          if (/^\[(image|attachment|file|audio|video|media)/i.test(s)) continue;
          return s.replace(/\s+/g, " ").slice(0, 30);
        }
      } catch {}
    }
  } catch {}
  return "";
}

// 读文件头部识别会话使用的模型
function detectSessionModel(dir, name) {  try {
    const fd = openFileHead(join(dir, name), 4096);
    return fd;
  } catch {
    return null;
  }
}

function openFileHead(full, bytes) {
  const fd = readFileSync(full, { encoding: "utf8" });
  const head = fd.slice(0, bytes);
  const lines = head.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "model_change" && obj.modelId) return obj.modelId;
      if (obj.type === "message" && obj.message && obj.message.model) return obj.message.model;
    } catch {}
  }
  return null;
}

function readSession(dir, name, limitTurns) {
  const full = join(dir, name);
  if (!existsSync(full)) return null;
  const content = readFileSync(full, "utf8");
  const parsed = parseSession(content, limitTurns);
  if (!parsed) return null;
  return { file: name, ...parsed };
}

// 读 provider-catalog 拿 key（脱敏使用）
function readProviderCatalog() {
  try {
    if (existsSync(PROVIDER_CATALOG)) {
      return JSON.parse(readFileSync(PROVIDER_CATALOG, "utf8"));
    }
  } catch {}
  return null;
}

export default function registerPluginApiRoutes(app, ctx) {
  // 会话列表（含模型识别）
  app.get("/api/sessions", (c) => {
    const dir = getSessionsDir(ctx);
    const files = listSessionFiles(dir).slice(0, 60).map((f) => ({
      name: f.name,
      size: f.size,
      mtime: f.mtime,
      model: detectSessionModel(dir, f.name),
      title: detectSessionTitle(dir, f.name),
    }));
    return c.json({ dir, sessions: files });
  });

  // 指定会话统计（默认最新）；?file=xxx.jsonl&limit=200
  app.get("/api/stats", (c) => {
    const dir = getSessionsDir(ctx);
    const query = c.req.query();
    const limit = Number(query.limit) || 200;
    const files = listSessionFiles(dir);
    if (files.length === 0) {
      return c.json({ error: "no sessions found", dir });
    }
    const name = query.file && files.some((f) => f.name === query.file) ? query.file : files[0].name;
    const result = readSession(dir, name, limit);
    if (!result) {
      return c.json({ error: "no usage data in session", file: name });
    }
    result.title = detectSessionTitle(dir, name); // 对话第一句话作为标题
    return c.json(result);
  });

  // 多供应商余额（并行查询 + 60s 缓存，避免每次进入都全量查询）
  let balanceCache = { at: 0, data: null };
  app.get("/api/balance", async (c) => {
    const now = Date.now();
    if (now - balanceCache.at < 60000 && balanceCache.data) {
      return c.json(balanceCache.data);
    }
    const catalog = readProviderCatalog();
    if (!catalog?.providers) {
      dbg("balance: provider catalog unavailable");
      return c.json({ error: "provider catalog unavailable" });
    }
    dbg("balance: catalog loaded, has network.fetch: " + (typeof ctx.network?.fetch === "function"));
    // ctx.network.fetch 不可用时回退全局 fetch（Node 18+）
    const fetchFn =
      typeof ctx.network?.fetch === "function"
        ? (url, opts) => ctx.network.fetch(url, opts)
        : (url, opts) => fetch(url, opts);
    // 并行查询所有供应商（避免顺序累加导致最慢的一家拖垮整体）
    const tasks = [];
    for (const [provider, adapter] of Object.entries(BALANCE_ADAPTERS)) {
      const p = catalog.providers[provider];
      if (!p?.api_key || !p?.base_url) {
        tasks.push(Promise.resolve({ provider, name: adapter.name, status: "no_key" }));
        continue;
      }
      const url = adapter.url(p.base_url);
      tasks.push(
        (async () => {
          dbg(`balance ${provider}: fetching ${url}`);
          try {
            const resp = await fetchFn(url, {
              headers: { Authorization: `Bearer ${p.api_key}` },
              signal: AbortSignal.timeout(8000),
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
              return { provider, name: adapter.name, status: "ok", ...parsed };
            }
            return { provider, name: adapter.name, status: "parse_failed", detail: text.slice(0, 100) };
          } catch (e) {
            dbg(`balance ${provider}: ERROR ${String(e?.message || e)}`);
            return { provider, name: adapter.name, status: "error", detail: String(e?.message || e).slice(0, 100) };
          }
        })()
      );
    }
    const balances = await Promise.all(tasks);
    // 未接入的供应商
    const unsupported = [];
    for (const [provider, note] of Object.entries(NO_BALANCE_API)) {
      if (catalog.providers[provider]?.api_key) {
        unsupported.push({ provider, note });
      }
    }
    balanceCache = { at: now, data: { balances, unsupported } };
    return c.json(balanceCache.data);
  });

  // 总消费金额（按用量总账计算，30s 缓存）
  app.get("/api/total-cost", (c) => {
    const r = computeTotalCost();
    return c.json(r);
  });

  // 全局用量总览（agent/来源/日期/模型/延迟聚合，30s 缓存，可传 ?provider= 过滤）
  app.get("/api/ledger-stats", (c) => {
    const provider = c.req.query("provider") || null;
    const r = computeLedgerStats(provider);
    return c.json(r);
  });

  // 用系统默认程序打开链接（绕过 Electron 内置窗口）
  app.get("/api/open", (c) => {
    const url = String(c.req.query().url || "").trim();
    const allowedHosts = [
      "platform.deepseek.com",
      "platform.kimi.com",
      "platform.xiaomimimo.com",
      "bigmodel.cn",
      "open.bigmodel.cn",
      "apihub.agnes-ai.com",
      "platform.openai.com",
      "aistudio.google.com",
    ];
    try {
      const u = new URL(url);
      if (!allowedHosts.includes(u.hostname)) {
        return c.json({ error: "host not allowed", host: u.hostname });
      }
    } catch {
      return c.json({ error: "invalid url" });
    }
    dbg("open: " + url);
    const cmd =
      process.platform === "win32"
        ? `start "" "${url}"`
        : process.platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd, { windowsHide: true }, (err) => {
      if (err) dbg("open exec error: " + String(err));
    });
    return c.json({ ok: true });
  });
}
