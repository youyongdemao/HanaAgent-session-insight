// routes/api.js — 会话统计 / 会话列表 / 多供应商余额
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, writeFileSync, mkdirSync, cpSync, rmSync, renameSync } from "node:fs";
import { exec, execFile } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { parseSession, PROVIDER_OF_MODEL, PRICING, priceFor } from "../lib/usage-parser.js";

function dbg(msg) {
  try {
    appendFileSync(join(getDataRoot(null), "OH-WorkSpace", "session-insight-debug.log"), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// 用量总账（总消费数据源）
let ledgerCache = { at: 0, totalCost: 0, perProvider: {}, perModel: {} };

// 单条 ledger entry 的费用（输入按未命中/命中拆分，缓存窗口值不重复计费；峰谷模型按 startedAt 选档）
function calcEntryCost(e) {
  const model = e?.model?.modelId;
  const p = priceFor(model, e?.startedAt);
  if (!p) return null;
  const u = e.usage || {};
  const inputTotal = u.input?.totalTokens ?? u.input?.uncachedTokens ?? 0;
  const uncached = u.input?.uncachedTokens ?? u.cache?.missTokens ?? inputTotal;
  const inputMiss = Math.min(inputTotal, uncached ?? inputTotal);
  const inputHit = Math.max(0, inputTotal - inputMiss);
  const output = u.output?.totalTokens ?? 0;
  return (inputMiss / 1e6) * p.inputMiss + (inputHit / 1e6) * p.inputHit + (output / 1e6) * p.output;
}


function computeTotalCost(ctx) {
  const now = Date.now();
  if (now - ledgerCache.at < 30000) return ledgerCache;
  try {
    const ledger = getLedgerPath(ctx);
    if (!existsSync(ledger)) return { at: now, totalCost: null, perProvider: {}, perModel: {} };
    const data = JSON.parse(readFileSync(ledger, "utf8"));
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
function computeLedgerStats(ctx, provider) {
  const now = Date.now();
  if (now - ledgerStatsCache.at < 30000 && ledgerStatsCache.provider === provider) return ledgerStatsCache;
  try {
    const ledger = getLedgerPath(ctx);
    if (!existsSync(ledger)) return { at: now, empty: true, provider };
    const data = JSON.parse(readFileSync(ledger, "utf8"));
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

const PROVIDER_CATALOG = "D:\\AI\\Hanako\\provider-catalog.json";
const MODELS_FILE = "D:\\AI\\Hanako\\models.json";
const AUTH_FILE = "D:\\AI\\Hanako\\auth.json";

// 动态定位数据根：优先取 config.dataDir，其次由 sessionsDir 推导（sessions -> .. -> agents -> .. -> 根），兜底写死路径
function getDataRoot(ctx) {
  try {
    const p = ctx.config?.get?.("dataDir");
    if (p && existsSync(p)) return p;
  } catch {}
  try {
    const sd = ctx.config?.get?.("sessionsDir");
    if (sd) {
      const root = join(sd, "..", "..", "..");
      if (existsSync(join(root, "usage-ledger.json")) || existsSync(join(root, "provider-catalog.json"))) return root;
    }
  } catch {}
  return "D:\\AI\\Hanako";
}
function getLedgerPath(ctx) {
  return join(getDataRoot(ctx), "usage-ledger.json");
}

// 动态定位 provider-catalog.json：优先 config 配置，其次从 sessionsDir 推断数据根（sessions → agent → agents → 根），兜底写死路径
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
  return PROVIDER_CATALOG;
}

function readAppearancePreference(ctx) {
  const catalogPath = getProviderCatalogPath(ctx);
  const candidates = [
    catalogPath ? join(dirname(catalogPath), "user", "preferences.json") : null,
    ctx.pluginDir ? join(dirname(dirname(ctx.pluginDir)), "user", "preferences.json") : null,
    "D:\\AI\\Hanako\\user\\preferences.json",
  ].filter(Boolean);
  for (const file of [...new Set(candidates)]) {
    try {
      if (!existsSync(file)) continue;
      const data = JSON.parse(readFileSync(file, "utf8"));
      const theme = data?.appearance?.theme;
      if (typeof theme === "string" && theme.trim()) {
        return { theme: theme.trim(), source: "preferences" };
      }
    } catch {}
  }
  return { theme: null, source: "unavailable" };
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

// 无公开余额接口的供应商说明
const NO_BALANCE_API = {
  mimo: "暂无余额接口",
  zhipu: "暂无余额接口",
  agnes: "全模态免费",
  openai: "需配置 OpenAI Admin Key",
  gemini: "暂无余额接口",
  "openai-codex": "实验性配额未启用",
  "xai-oauth": "Grok 订阅无公开接口",
};

function getSessionsDir(ctx) {
  try {
    const dir = ctx.config?.get?.("sessionsDir");
    if (dir && existsSync(dir)) return dir;
  } catch {}
  return join(getDataRoot(ctx), "agents", "hanako", "sessions");
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

// 会话标题：优先使用 HanaAgent 的正式标题（session-titles.json），首条用户消息仅作兜底
let sessionTitlesCache = { path: "", mtime: 0, data: {} };
function readSessionTitles(dir) {
  try {
    const full = join(dir, "session-titles.json");
    if (!existsSync(full)) return {};
    const mtime = statSync(full).mtimeMs;
    if (sessionTitlesCache.path === full && sessionTitlesCache.mtime === mtime) return sessionTitlesCache.data;
    const data = JSON.parse(readFileSync(full, "utf8"));
    sessionTitlesCache = { path: full, mtime, data: data && typeof data === "object" ? data : {} };
    return sessionTitlesCache.data;
  } catch {
    return {};
  }
}

function detectSessionTitle(dir, name) {
  try {
    const titles = readSessionTitles(dir);
    let sessionId = "";
    // HanaAgent 为有附件/SessionFile 的会话写入同名侧车文件，里面有稳定 sessionId
    const sidecar = join(dir, name + ".files.json");
    if (existsSync(sidecar)) {
      try {
        sessionId = JSON.parse(readFileSync(sidecar, "utf8"))?.sessionId || "";
      } catch {}
    }

    // 侧车不存在时，从 JSONL 中的 SessionFile 引用提取 sessionId；同时保留首句标题兜底
    const fd = readFileSync(join(dir, name), { encoding: "utf8" });
    if (!sessionId) {
      const idMatch = fd.match(/"sessionId"\s*:\s*"(sess_[^"]+)"/);
      if (idMatch) sessionId = idMatch[1];
    }
    // 与 HanaAgent 左侧会话列表同源：session-titles.json 的 key 随版本演进，
    // 新条目是 sessionId，旧条目可能是完整路径或文件名，三种都兼容
    if (sessionId && titles[sessionId]) return String(titles[sessionId]).trim();
    if (titles[join(dir, name)]) return String(titles[join(dir, name)]).trim();
    if (titles[name]) return String(titles[name]).trim();

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

// 读文件头部识别会话使用的模型（不解析全文，快）
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
function readProviderCatalog(ctx) {
  try {
    const p = getProviderCatalogPath(ctx);
    if (p && existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf8"));
    }
  } catch {}
  return null;
}

function readModelsConfig(ctx) {
  try {
    const catalogPath = getProviderCatalogPath(ctx);
    const inferred = catalogPath ? join(catalogPath, "..", "models.json") : MODELS_FILE;
    const p = existsSync(inferred) ? inferred : MODELS_FILE;
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch {}
  return null;
}

function readAuthConfig(ctx) {
  try {
    const catalogPath = getProviderCatalogPath(ctx);
    const inferred = catalogPath ? join(catalogPath, "..", "auth.json") : AUTH_FILE;
    const p = existsSync(inferred) ? inferred : AUTH_FILE;
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch {}
  return {};
}

const UPDATE_REPO_API = "https://api.github.com/repos/youyongdemao/HanaAgent-session-insight/releases/latest";

function normalizeVersion(value) {
  return String(value || "0.0.0").trim().replace(/^v/i, "").split("-")[0];
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const right = normalizeVersion(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function currentPluginVersion(ctx) {
  try {
    return JSON.parse(readFileSync(join(ctx.pluginDir, "manifest.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readGitHubToken(ctx) {
  const catalogPath = getProviderCatalogPath(ctx);
  const base = catalogPath ? dirname(catalogPath) : "D:\\AI\\Hanako";
  const mcpConfig = join(base, "plugin-data", "mcp", "config.json");
  try {
    if (!existsSync(mcpConfig)) return null;
    const cfg = JSON.parse(readFileSync(mcpConfig, "utf8"));
    const connector = (cfg.global?.mcp?.connectors || []).find((item) => (item.id || "").toLowerCase() === "github");
    return connector?.env?.GITHUB_PERSONAL_ACCESS_TOKEN || null;
  } catch {
    return null;
  }
}

async function latestRelease(ctx) {
  const token = readGitHubToken(ctx);
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Session-Insight-Updater",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(UPDATE_REPO_API, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  const release = await response.json();
  const version = normalizeVersion(release.tag_name || release.name);
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => /session-insight.*\.zip$/i.test(item?.name || ""))
    : null;
  return { version, tag: release.tag_name || `v${version}`, asset };
}

function findWinRAR() {
  const candidates = [
    "D:\\Tools\\System Tools\\Winrar\\WinRAR.exe",
    process.env.ProgramFiles && join(process.env.ProgramFiles, "WinRAR", "WinRAR.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "WinRAR", "WinRAR.exe"),
  ].filter(Boolean);
  return candidates.find((file) => existsSync(file)) || null;
}

function runWinRAR(executable, args) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function installRelease(ctx, release) {
  if (!release.asset?.browser_download_url) throw new Error("新版 Release 中没有找到 ZIP 安装包");
  if ((release.asset.size || 0) > 30 * 1024 * 1024) throw new Error("安装包超过 30MB 安全上限");
  const winrar = findWinRAR();
  if (!winrar) throw new Error("未找到 WinRAR，无法解压更新包");

  const pluginDir = ctx.pluginDir;
  const parentDir = dirname(pluginDir);
  const hanaHome = dirname(parentDir);
  const dataDir = join(hanaHome, "plugin-data", "session-insight");
  const stamp = Date.now().toString(36);
  const workDir = join(dataDir, "updates", stamp);
  const extractDir = join(workDir, "extract");
  const zipPath = join(workDir, "update.zip");
  const oldVersion = currentPluginVersion(ctx);
  const backupDir = join(dataDir, "backups", `${basename(pluginDir)}-v${oldVersion}-${stamp}`);
  let movedToBackup = false;

  mkdirSync(extractDir, { recursive: true });
  mkdirSync(dirname(backupDir), { recursive: true });
  try {
    const downloadHeaders = { "User-Agent": "Session-Insight-Updater" };
    const token = readGitHubToken(ctx);
    if (token) downloadHeaders.Authorization = `Bearer ${token}`;
    const response = await fetch(release.asset.browser_download_url, {
      headers: downloadHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`下载更新包失败：HTTP ${response.status}`);
    const payload = Buffer.from(await response.arrayBuffer());
    if (payload.length < 1000 || payload.length > 30 * 1024 * 1024) throw new Error("更新包大小异常");
    const declaredDigest = String(release.asset.digest || "");
    if (/^sha256:/i.test(declaredDigest)) {
      const actualDigest = createHash("sha256").update(payload).digest("hex");
      if (actualDigest.toLowerCase() !== declaredDigest.slice(7).toLowerCase()) throw new Error("更新包 SHA256 校验失败");
    }
    writeFileSync(zipPath, payload);

    await runWinRAR(winrar, ["x", "-ibck", "-y", zipPath, `${extractDir}\\`]);
    const manifestPath = join(extractDir, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("更新包缺少 manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.id !== "session-insight") throw new Error("更新包插件 ID 不匹配");
    if (normalizeVersion(manifest.version) !== normalizeVersion(release.version)) {
      throw new Error(`更新包版本不匹配：${manifest.version || "未知"}`);
    }

    renameSync(pluginDir, backupDir);
    movedToBackup = true;
    cpSync(extractDir, pluginDir, { recursive: true, force: true });
    return { ok: true, version: manifest.version, previousVersion: oldVersion, backupDir };
  } catch (error) {
    if (movedToBackup) {
      try {
        rmSync(pluginDir, { recursive: true, force: true });
        renameSync(backupDir, pluginDir);
      } catch (rollbackError) {
        throw new Error(`${error.message}；自动回滚失败：${rollbackError.message}`);
      }
    }
    throw error;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
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

async function queryZhipuQuota(ctx, fetchFn, catalog) {
  const provider = catalog?.providers?.zhipu;
  if (!provider?.api_key) return null;
  const endpoints = [
    "https://api.z.ai/api/monitor/usage/quota/limit",
    "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  ];
  for (const url of endpoints) {
    try {
      const result = await requestJson(fetchFn, url, {
        headers: { Authorization: provider.api_key, Accept: "application/json" },
      });
      const payload = result.data?.data;
      const limits = Array.isArray(payload?.limits) ? payload.limits : [];
      if (!result.ok || result.data?.success === false || !limits.length) continue;
      const windows = limits.map((item) => {
        const used = Number(item?.percentage ?? item?.usedPercent ?? 0);
        return {
          type: String(item?.type || "quota"),
          usedPercent: Math.max(0, Math.min(100, used)),
          remainingPercent: Math.max(0, Math.min(100, 100 - used)),
          resetAt: item?.nextResetTime || item?.resetAt || null,
        };
      });
      const primary = windows.find((item) => item.type === "TOKENS_LIMIT") || windows[0];
      return {
        provider: "zhipu",
        name: "智谱 Coding Plan",
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

async function queryCodexQuota(ctx, fetchFn) {
  if (configValue(ctx, "enableCodexQuota") !== true) return null;
  const auth = readAuthConfig(ctx)?.["openai-codex"];
  if (!auth?.access) return null;
  const cacheKey = `codex-quota:${auth.accountId || "default"}`;
  const cached = cachedExternalStatus(cacheKey, 300000);
  if (cached) return cached;
  try {
    const headers = {
      Authorization: `Bearer ${auth.access}`,
      Accept: "application/json",
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
    };
    if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;
    const result = await requestJson(fetchFn, "https://chatgpt.com/backend-api/wham/usage", { headers }, 12000);
    if (!result.ok || !result.data) return null;
    const rate = result.data.rate_limit || result.data.rateLimit || result.data;
    const normalizeWindow = (window, name) => {
      if (!window || typeof window !== "object") return null;
      const used = Number(window.used_percent ?? window.usedPercent);
      if (!Number.isFinite(used)) return null;
      return {
        name,
        usedPercent: Math.max(0, Math.min(100, used)),
        remainingPercent: Math.max(0, Math.min(100, 100 - used)),
        resetAt: window.reset_at ?? window.resets_at ?? window.resetsAt ?? null,
        windowSeconds: window.limit_window_seconds ?? window.window_seconds ?? null,
      };
    };
    const windows = [
      normalizeWindow(rate.primary_window || rate.primaryWindow || rate.five_hour, "主窗口"),
      normalizeWindow(rate.secondary_window || rate.secondaryWindow || rate.weekly, "周窗口"),
    ].filter(Boolean);
    if (!windows.length) return null;
    const limiting = windows.reduce((min, item) => item.remainingPercent < min.remainingPercent ? item : min, windows[0]);
    const credits = Number(result.data?.credits?.balance ?? result.data?.credit_balance);
    return storeExternalStatus(cacheKey, {
      provider: "openai-codex",
      name: "ChatGPT Codex",
      status: "ok",
      kind: "quota",
      label: "订阅配额",
      summary: `${limiting.remainingPercent.toFixed(0)}%`,
      remainingPercent: limiting.remainingPercent,
      resetAt: limiting.resetAt,
      windows,
      credits: Number.isFinite(credits) ? credits : null,
      plan: result.data?.plan_type || result.data?.planType || null,
      experimental: true,
    });
  } catch {
    return null;
  }
}

export default function registerPluginApiRoutes(app, ctx) {
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
  app.get("/api/appearance", (c) => {
    return c.json({ ok: true, ...readAppearancePreference(ctx) });
  });

  // GitHub Release 更新检查
  app.get("/api/check-update", async (c) => {
    try {
      const currentVersion = currentPluginVersion(ctx);
      const release = await latestRelease(ctx);
      return c.json({
        ok: true,
        currentVersion,
        latestVersion: release.version,
        updateAvailable: compareVersions(release.version, currentVersion) > 0,
        hasInstallAsset: Boolean(release.asset?.browser_download_url),
      });
    } catch (error) {
      dbg("check-update ERROR: " + String(error?.message || error));
      return c.json({ ok: false, error: String(error?.message || error) }, 502);
    }
  });

  // 下载、校验、备份并覆盖安装最新版
  app.post("/api/apply-update", async (c) => {
    try {
      const requested = await c.req.json().catch(() => ({}));
      const release = await latestRelease(ctx);
      const currentVersion = currentPluginVersion(ctx);
      if (requested.version && normalizeVersion(requested.version) !== normalizeVersion(release.version)) {
        return c.json({ ok: false, error: "Latest Release 已变化，请重新检查更新" }, 409);
      }
      if (compareVersions(release.version, currentVersion) <= 0) {
        return c.json({ ok: true, alreadyLatest: true, version: currentVersion });
      }
      const result = await installRelease(ctx, release);
      return c.json(result);
    } catch (error) {
      dbg("apply-update ERROR: " + String(error?.message || error));
      return c.json({ ok: false, error: String(error?.message || error) }, 500);
    }
  });

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
    if (query.file && !files.some((f) => f.name === query.file)) {
      return c.json({ error: "session not found", file: query.file }, 404);
    }
    const name = query.file || files[0].name;
    const result = readSession(dir, name, limit);
    if (!result) {
      return c.json({ error: "no usage data in session", file: name });
    }
    result.title = detectSessionTitle(dir, name); // HanaAgent 正式会话标题优先，首句兜底
    return c.json(result);
  });

  // 多供应商余额（并行查询 + 60s 缓存，避免每次进入都全量查询）
  let balanceCache = { at: 0, data: null };
  // 动态供应商列表：从 HanaAgent provider-catalog 同步（只返回 id，绝不返回 api_key）
let providersCache = { at: 0, data: null };
function computeActiveProviders(ctx) {
  const now = Date.now();
  if (now - providersCache.at < 30000 && providersCache.data) return providersCache.data;
  // models.json 是能力全集；真正启用集合必须由 API Key 配置或 OAuth 登录凭据证明
  const modelsConfig = readModelsConfig(ctx);
  const catalog = readProviderCatalog(ctx);
  const auth = readAuthConfig(ctx);
  const modelProviders = modelsConfig?.providers || {};
  const active = new Set();

  // API 供应商：只收录实际配置了 api_key 的条目
  for (const [id, cfg] of Object.entries(catalog?.providers || {})) {
    if (!cfg?.api_key) continue;
    if (modelProviders[id]) active.add(id);
    else if (id.endsWith("-oauth") && modelProviders[id.slice(0, -6)]) active.add(id.slice(0, -6));
    else active.add(id);
  }

  // OAuth 供应商：只收录 auth.json 中已有有效登录凭据的条目；不返回任何凭据内容
  for (const [authId, cfg] of Object.entries(auth || {})) {
    if (cfg?.type !== "oauth" || (!cfg?.access && !cfg?.refresh)) continue;
    const candidates = [authId, authId + "-oauth", authId.replace(/-oauth$/, "")];
    const providerId = candidates.find((id) => modelProviders[id]);
    if (providerId) active.add(providerId);
  }

  const source = Object.keys(modelProviders).length ? modelProviders : (catalog?.providers || {});
  const list = Object.entries(source)
    .filter(([id]) => active.has(id))
    .map(([id, cfg]) => ({
      id,
      models: (cfg?.models || []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean),
    }));
  providersCache = { at: now, data: { providers: list } };
  return providersCache.data;
}
app.get("/api/providers", (c) => c.json(computeActiveProviders(ctx)));

app.get("/api/balance", async (c) => {
    const now = Date.now();
    if (now - balanceCache.at < 60000 && balanceCache.data) {
      return c.json(balanceCache.data);
    }
    const catalog = readProviderCatalog(ctx);
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
    tasks.push(queryZhipuQuota(ctx, fetchFn, catalog));
    tasks.push(queryOpenAICosts(ctx, fetchFn));
    tasks.push(queryXaiBalance(ctx, fetchFn));
    tasks.push(queryCodexQuota(ctx, fetchFn));

    const balances = (await Promise.all(tasks)).filter(Boolean);
    const okProviders = new Set(balances.filter((item) => item.status === "ok").map((item) => item.provider));
    const unsupported = [];
    const activeIds = new Set(computeActiveProviders(ctx).providers.map((p) => p.id));
    if (configValue(ctx, "xaiManagementKey") && configValue(ctx, "xaiTeamId")) activeIds.add("xai");
    for (const [provider, defaultNote] of Object.entries(NO_BALANCE_API)) {
      if (!activeIds.has(provider) || okProviders.has(provider)) continue;
      let note = defaultNote;
      if (provider === "zhipu") note = "当前账户非 Coding Plan 或配额不可用";
      if (provider === "openai" && configValue(ctx, "openaiAdminKey")) note = "Admin Costs 查询失败";
      if (provider === "openai-codex" && configValue(ctx, "enableCodexQuota") === true) note = "实验性配额暂不可用";
      unsupported.push({ provider, note });
    }
    if (activeIds.has("xai") && !okProviders.has("xai")) {
      unsupported.push({ provider: "xai", note: "Management Key 或 Team ID 无效" });
    }
    balanceCache = { at: now, data: { balances, unsupported } };
    return c.json(balanceCache.data);
  });

  // 全局用量总览（agent/来源/日期/模型/延迟聚合，30s 缓存，可传 ?provider= 过滤）
  app.get("/api/ledger-stats", (c) => {
    const provider = c.req.query("provider") || null;
    const r = computeLedgerStats(ctx, provider);
    return c.json(r);
  });

  // 总消费金额（按用量总账计算，30s 缓存）
  app.get("/api/total-cost", (c) => {
    const r = computeTotalCost(ctx);
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
      "chatgpt.com",
      "grok.com",
      "console.x.ai",
      "github.com",
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
