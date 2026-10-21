// lib/pricing-db-cache.js — 公共计费数据库的独立缓存模块
//
// 职责边界：只负责「取数 → 校验 → 选定 → 交给 apply → 落盘 / 回读」这条链。
// 不 import usage-parser：apply 由调用方注入（通常就是 setPricingConfig），
// 这样缓存层不需要知道价格怎么被消费，也不会把 300KB 的解析器拖进每条冷路径。
//
// 状态语义（state() 返回的字段）：
//   ok        —— 当前是否有可用数据（包内内置数据算「没有」，初始 ok=false）
//   remoteOk  —— 最近一次联网是否成功拿到 HTTP 响应（与 ok 独立：断网时 ok 可以是 true）
//   source    —— 'builtin' | 'local-cache' | 实际命中并采用的远端 URL
//   snapshotAt—— 当前活动数据的快照日期（YYYY-MM-DD）
//   savedAt   —— 当前活动数据落盘的时间（ISO 字符串），从未落盘为 null
//   persisted —— 当前活动数据是否已经写进 filePath
//   error     —— 最近一次失败的明确原因，成功时为 null
//
// 铁律：
//   1. 校验不过不 apply；apply 返回非 true 不写盘。
//   2. 写盘用「临时文件 + rename」，失败时旧文件原样保留，绝不假报 persisted。
//   3. restore() 只读本地不联网，也不影响之后 refresh() 是否联网（不设冷却、不设 TTL 时钟）。
//   4. 同一实例的 refresh() 并发调用共享同一个 in-flight promise（singleflight）。
//   5. 没有 filePath 时只在内存里活，绝不写到 CWD。

import { createHash } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const CACHE_VERSION = 1;
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 5000;
/** 失败后的短重试窗口：不整天锁死，5 分钟后再试。 */
export const FAILURE_RETRY_MS = 5 * 60 * 1000;

export const DEFAULT_PRICING_DB_URLS = Object.freeze([
  // 顺序即优先级：同一天有多源可用时选靠前的（raw 优先）
  "https://raw.githubusercontent.com/youyongdemao/HanaAgent-session-insight/main/pricing.json",
  "https://cdn.jsdelivr.net/gh/youyongdemao/HanaAgent-session-insight@main/pricing.json",
]);

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ── 资源与投毒防线 ──
// 仓库有写权限控制，但仍将网络响应视为不可信，以防账号泄露、缓存损坏或异常大文档。
const CACHE_ENVELOPE_BYTES = 16 * 1024;
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024; // 单份文档字节上限（现网约 320KB）
export const MAX_MODELS = 4000;                    // 条目数上限（现网 467）
export const MAX_KEY_LENGTH = 256;                 // 模型键长度上限
export const MAX_NESTING_DEPTH = 24;               // 对象嵌套深度上限
export const MAX_NODES = 200000;                   // 单份文档节点数上限
export const MAX_PRICE_VALUE = 1e9;                // 单价上限（元 / 百万 tokens），防溢出与垃圾值
export const MAX_FX_USD = 1000;                    // 汇率上限，防「汇率 1e12」把费用拉爆

// 与 usage-parser.js 的 PROVIDER_ALIAS 保持一致（只用于判定「限定键与 provider 是否冲突」）。
// 复制而不 import：缓存模块要保持零依赖加载，测试里有一条用例盯着两边是否漂移。
const PROVIDER_ALIAS = {
  "xai-oauth": "xai",
  "openai-codex-oauth": "openai",
  "zhipu-coding": "zhipu",
  "kimi-coding": "moonshot",
  "dashscope-coding": "dashscope",
  "dashscope-token-plan": "dashscope",
  "volcengine-coding": "volcengine",
};

function canonProvider(p) {
  const s = String(p ?? "").trim();
  if (!s) return "";
  return PROVIDER_ALIAS[s] || s;
}

function isPlainObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isFiniteNonNegative(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** 价格类数值：非负有限，且在合理量级内（防 1e308 这类垃圾值把费用算成 Infinity）。 */
function isPlausibleAmount(v) {
  return isFiniteNonNegative(v) && v <= MAX_PRICE_VALUE;
}

/** 递归扫一遍整棵结构：拒绝危险键名、超深嵌套、超量节点。JSON.parse 已排除循环，仍用 seen 兜底。 */
function scanStructure(value, fail) {
  const seen = new WeakSet();
  let nodes = 0;
  const walk = (v, depth, path) => {
    if (depth > MAX_NESTING_DEPTH) {
      fail(`${path} 嵌套超过 ${MAX_NESTING_DEPTH} 层，疑似资源耗尽攻击`);
    }
    nodes += 1;
    if (nodes > MAX_NODES) {
      fail(`文档节点数超过上限 ${MAX_NODES}，疑似资源耗尽攻击`);
    }
    if (!v || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) walk(v[i], depth + 1, `${path}[${i}]`);
      return;
    }
    for (const key of Object.keys(v)) {
      if (DANGEROUS_KEYS.has(key)) {
        fail(`${path} 命中危险键名 ${JSON.stringify(key)}`);
      }
      walk(v[key], depth + 1, `${path}.${key}`);
    }
  };
  walk(value, 0, "$");
}

/** 只接受 http/https 且不带用户名密码的 URL：不解析、不回源，仅做静态校验。 */
function checkSourceUrl(raw, label, fail) {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "string" || !raw.trim()) fail(`${label} 必须是非空字符串`);
  if (raw.length > 2048) fail(`${label} 过长（>2048）`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} 不是合法 URL：${JSON.stringify(raw.slice(0, 120))}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail(`${label} 协议必须是 http/https（实际 ${parsed.protocol}）`);
  }
  if (parsed.username || parsed.password) {
    fail(`${label} 不允许携带用户名或密码`);
  }
}

/** 严格 YYYY-MM-DD，且必须是真实存在的日历日（2026-02-30 之类不算）。 */
export function isValidSnapshotDate(v) {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d
  );
}

function dateOrdinal(v) {
  if (!isValidSnapshotDate(v)) return -1;
  const [y, m, d] = v.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** pricing.json 里一条价格对象：三价必须齐全且非负有限；cacheWrite 可缺省、可 null、若是数值须合法。 */
function checkPriceObject(price, label, fail) {
  if (!isPlainObject(price)) fail(`${label} 必须是 plain object`);
  for (const field of ["inputMiss", "inputHit", "output"]) {
    if (!isPlausibleAmount(price[field])) {
      fail(`${label}.${field} 必须是 0~${MAX_PRICE_VALUE} 的有限数值（实际 ${String(price[field])}）`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(price, "cacheWrite")) {
    const cw = price.cacheWrite;
    if (cw !== null && !isPlausibleAmount(cw)) {
      fail(`${label}.cacheWrite 只能省略、null 或 0~${MAX_PRICE_VALUE} 的有限数值（实际 ${String(cw)}）`);
    }
  }
}

/**
 * 校验一份计费数据库是否能被当前 setPricingConfig 完整消费。
 * 通过返回 true；不通过抛带 code='INVALID_PRICING_DB' 的 Error，message 里指名到具体条目。
 * 不做「部分条目丢弃」：只要有一条坏，整份拒收。
 */
export function validatePricingDatabase(db) {
  const fail = (msg) => {
    const err = new Error(`pricing.json 校验失败：${msg}`);
    err.code = "INVALID_PRICING_DB";
    err.reason = msg;
    throw err;
  };

  if (!isPlainObject(db)) fail("根节点必须是 plain object");
  // 先扫结构，再谈业务字段：恶意原型键、超深嵌套、超量节点一律整份拒收
  scanStructure(db, fail);
  let serialized;
  try { serialized = JSON.stringify(db); } catch { fail('数据库不能安全序列化'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) fail('数据库文档体积超过上限');
  checkSourceUrl(db.sourceUrl, "sourceUrl", fail);
  if (db.schemaVersion !== 2) fail(`schemaVersion 必须是 2（实际 ${String(db.schemaVersion)}）`);
  if (db.currency !== "CNY") fail(`currency 必须是 CNY（实际 ${String(db.currency)}）`);
  if (db.unit !== "per_million_tokens") {
    fail(`unit 必须是 per_million_tokens（实际 ${String(db.unit)}）`);
  }
  if (!isValidSnapshotDate(db.snapshotAt)) {
    fail(`snapshotAt 必须是真实存在的 YYYY-MM-DD 日期（实际 ${String(db.snapshotAt)}）`);
  }

  const models = db.models;
  if (!isPlainObject(models)) fail("models 必须是 plain object");
  const keys = Object.keys(models);
  if (!keys.length) fail("models 不能为空");
  if (keys.length > MAX_MODELS) fail(`models 条目数 ${keys.length} 超过上限 ${MAX_MODELS}`);

  // 汇率：只要库里有 USD 条，就必须给合法 fx.USD；给了 fx.USD 的话无论如何都要合法。
  const hasUsdEntry = keys.some((k) => isPlainObject(models[k]) && models[k].currency === "USD");
  const fxUsdGiven =
    isPlainObject(db.fx) && Object.prototype.hasOwnProperty.call(db.fx, "USD");
  if (hasUsdEntry && !fxUsdGiven) fail("存在 USD 条目但缺少 fx.USD");
  if (fxUsdGiven && !(isFiniteNonNegative(db.fx.USD) && db.fx.USD > 0 && db.fx.USD <= MAX_FX_USD)) {
    fail(`fx.USD 必须是 0 < 值 <= ${MAX_FX_USD} 的有限数值（实际 ${String(db.fx.USD)}）`);
  }

  for (const key of keys) {
    if (!key) fail("models 存在空键");
    if (key.length > MAX_KEY_LENGTH) fail(`模型键长度超过 ${MAX_KEY_LENGTH}：${JSON.stringify(key.slice(0, 80))}…`);
    const sep = key.indexOf("::");
    const keyProvider = sep > 0 ? key.slice(0, sep) : null;
    const modelName = sep > 0 ? key.slice(sep + 2) : key;
    if (DANGEROUS_KEYS.has(modelName) || (keyProvider && DANGEROUS_KEYS.has(keyProvider))) {
      fail(`模型键 ${JSON.stringify(key)} 命中危险键名（__proto__ / constructor / prototype）`);
    }
    if (sep > 0 && (!keyProvider || !modelName)) {
      fail(`模型键 ${JSON.stringify(key)} 的 "::" 前后不能为空`);
    }

    const cfg = models[key];
    if (!isPlainObject(cfg)) fail(`models[${JSON.stringify(key)}] 必须是 plain object`);
    checkSourceUrl(cfg.sourceUrl, `models[${JSON.stringify(key)}].sourceUrl`, fail);

    if (Object.prototype.hasOwnProperty.call(cfg, "provider")) {
      if (typeof cfg.provider !== "string" || !cfg.provider.trim()) {
        fail(`models[${JSON.stringify(key)}].provider 必须是非空字符串`);
      }
      if (keyProvider && canonProvider(keyProvider).toLowerCase() !== canonProvider(cfg.provider).toLowerCase()) {
        fail(
          `models[${JSON.stringify(key)}].provider=${JSON.stringify(cfg.provider)} 与限定键前缀 ${JSON.stringify(keyProvider)} 冲突`,
        );
      }
    }

    const label = `models[${JSON.stringify(key)}]`;
    const usdMode = cfg.currency === "USD";
    // 出现的价格对象一律要合法：坏的一律拒收，不允许被 setPricingConfig 静默跳过。
    for (const slot of ["flat", "peak", "offPeak"]) {
      if (Object.prototype.hasOwnProperty.call(cfg, slot) && cfg[slot] !== null) {
        checkPriceObject(cfg[slot], `${label}.${slot}`, fail);
      }
    }
    for (const slot of ["usd", "usdPeak", "usdOffPeak"]) {
      if (Object.prototype.hasOwnProperty.call(cfg, slot) && cfg[slot] !== null) {
        checkPriceObject(cfg[slot], `${label}.${slot}`, fail);
      }
    }

    // 至少有一条 setPricingConfig 认得的计价路径
    const flatOk = isPlainObject(cfg.flat);
    const peakOk = isPlainObject(cfg.peak) && isPlainObject(cfg.offPeak);
    const usdOk = isPlainObject(cfg.usd);
    const usdPeakOk = isPlainObject(cfg.usdPeak) && isPlainObject(cfg.usdOffPeak);
    const usable = usdMode ? usdOk || usdPeakOk || flatOk || peakOk : flatOk || peakOk;
    if (!usable) {
      fail(`${label} 没有任何可用计价：需要 flat，或 peak+offPeak，或 USD 条目的 usd`);
    }
    for (const field of ["contextWindow"]) {
      if (Object.prototype.hasOwnProperty.call(cfg, field) && cfg[field] !== null) {
        if (!(typeof cfg[field] === "number" && Number.isFinite(cfg[field]) && cfg[field] > 0)) {
          fail(`${label}.${field} 必须是大于 0 的有限数值`);
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(cfg, "tiers") && !Array.isArray(cfg.tiers)) {
      fail(`${label}.tiers 必须是数组`);
    }
  }

  return true;
}

function hashDatabase(db) {
  return createHash("sha256").update(JSON.stringify(db), "utf8").digest("hex");
}

function emptyState(builtinSnapshotAt, now) {
  return {
    at: now,
    ok: false,
    source: "builtin",
    snapshotAt: isValidSnapshotDate(builtinSnapshotAt) ? builtinSnapshotAt : null,
    savedAt: null,
    persisted: false,
    remoteOk: false,
    error: null,
  };
}

/**
 * @param {object} options
 * @param {string|null} [options.filePath]  App 私有缓存文件绝对路径；缺省则纯内存
 * @param {Function} options.fetchFn        (url, init) => Response，注入以便测试/换传输层
 * @param {Function} options.apply          (db) => boolean|Promise<boolean>，返回 false 表示不可消费
 * @param {string} options.builtinSnapshotAt 包内内置数据的快照日期
 * @param {string[]} [options.urls]         远端源，顺序即同日优先级
 * @param {number} [options.ttlMs]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.now]
 * @param {object} [options.fs]             可选 fs/promises 替身（测试注入故障用）
 */
export function createPricingDatabaseCache(options = {}) {
  const {
    filePath = null,
    fetchFn,
    apply,
    builtinSnapshotAt = null,
    urls = DEFAULT_PRICING_DB_URLS,
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now,
    fs: fsImpl = nodeFs,
  } = options;

  if (typeof fetchFn !== "function") throw new TypeError("createPricingDatabaseCache: fetchFn 必须是函数");
  if (typeof apply !== "function") throw new TypeError("createPricingDatabaseCache: apply 必须是函数");
  const sources = Array.isArray(urls) && urls.length ? urls.filter((u) => typeof u === "string" && u) : [...DEFAULT_PRICING_DB_URLS];
  if (!sources.length) throw new TypeError("createPricingDatabaseCache: urls 至少需要一个可用 URL");
  const cachePath = typeof filePath === "string" && filePath.trim() ? filePath : null;
  if (cachePath && !isAbsolute(cachePath)) throw new TypeError('缓存文件必须是 App 私有目录内的绝对路径');
  const builtinDate = isValidSnapshotDate(builtinSnapshotAt) ? builtinSnapshotAt : null;

  let state = emptyState(builtinDate, now());
  let database = null; // 当前活动数据（唯一真相，不外泄）
  let restored = false;
  let restorePromise = null;
  let inflight = null;
  let lastAppliedAt = 0; // 决定 TTL 的时钟：只有真正采用了远端新数据才推进
  let lastFailureAt = 0; // 失败冷却：5 分钟后再试，不锁一整天

  function currentFloorDate() {
    // 不允许任何来源把活动数据倒退回早于「当前活动」或「包内内置」的日期
    const active = isValidSnapshotDate(state.snapshotAt) ? state.snapshotAt : null;
    let floor = builtinDate;
    if (active && (!floor || dateOrdinal(active) > dateOrdinal(floor))) floor = active;
    return floor;
  }

  function adopt(db, source, savedAt, persisted, remoteOk) {
    database = db;
    state = {
      at: now(),
      ok: true,
      source,
      snapshotAt: db.snapshotAt,
      savedAt: savedAt ?? null,
      persisted: Boolean(persisted),
      remoteOk: Boolean(remoteOk),
      error: null,
    };
  }

  async function writeCache(db, sourceUrl) {
    if (!cachePath) {
      // 没有私有路径时只能活在内存里；绝不偷偷写 CWD
      state = { ...state, persisted: false, savedAt: null, at: now() };
      return { persisted: false, savedAt: null, error: null };
    }
    const payload = {
      cacheVersion: CACHE_VERSION,
      savedAt: new Date(now()).toISOString(),
      sourceUrl,
      hash: hashDatabase(db),
      database: db,
    };
    const text = JSON.stringify(payload);
    const tmp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      if (typeof fsImpl.mkdir === 'function') await fsImpl.mkdir(dirname(cachePath), { recursive: true });
      await fsImpl.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      await fsImpl.rename(tmp, cachePath);
      return { persisted: true, savedAt: payload.savedAt, error: null };
    } catch (e) {
      try {
        await fsImpl.unlink(tmp);
      } catch {}
      return { persisted: false, savedAt: null, error: `写入缓存失败：${e?.message || e}` };
    }
  }

  async function readCacheFile() {
    if (!cachePath) return { kind: "absent" };
    if (typeof fsImpl.stat === "function") {
      try {
        const st = await fsImpl.stat(cachePath);
        if (st && typeof st.size === "number" && st.size > MAX_DOCUMENT_BYTES + CACHE_ENVELOPE_BYTES) {
          return { kind: "broken", error: `缓存文件体积 ${st.size} 超过上限 ${MAX_DOCUMENT_BYTES}` };
        }
      } catch (e) {
        if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { kind: "absent" };
        return { kind: "broken", error: `读取缓存失败：${e?.message || e}` };
      }
    }
    let text;
    try {
      text = await fsImpl.readFile(cachePath, "utf8");
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { kind: "absent" };
      return { kind: "broken", error: `读取缓存失败：${e?.message || e}` };
    }
    if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES + CACHE_ENVELOPE_BYTES) {
      return { kind: "broken", error: `缓存文件体积超过上限 ${MAX_DOCUMENT_BYTES + CACHE_ENVELOPE_BYTES}` };
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { kind: "broken", error: "缓存文件不是合法 JSON" };
    }
    if (!isPlainObject(payload)) return { kind: "broken", error: "缓存文件根节点不是对象" };
    if (payload.cacheVersion !== CACHE_VERSION) {
      return { kind: "broken", error: `缓存版本不支持（${String(payload.cacheVersion)}）` };
    }
    if (typeof payload.hash !== "string" || !isPlainObject(payload.database)) {
      return { kind: "broken", error: "缓存文件缺少 hash / database" };
    }
    if (hashDatabase(payload.database) !== payload.hash) {
      return { kind: "broken", error: "缓存 SHA256 校验不匹配" };
    }
    try {
      validatePricingDatabase(payload.database);
    } catch (e) {
      return { kind: "broken", error: e.message };
    }
    return {
      kind: "ok",
      database: payload.database,
      sourceUrl: typeof payload.sourceUrl === "string" ? payload.sourceUrl : null,
      savedAt: typeof payload.savedAt === "string" ? payload.savedAt : null,
    };
  }

  function restore() {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      const read = await readCacheFile();
      restored = true;
      if (read.kind === "absent") {
        state = { ...state, at: now(), error: null };
        return state;
      }
      if (read.kind === "broken") {
        // 坏缓存：不 apply、不清空已有好数据，只记下原因
        state = { ...state, at: now(), error: read.error };
        return state;
      }
      const floor = currentFloorDate();
      if (floor && dateOrdinal(read.database.snapshotAt) < dateOrdinal(floor)) {
        state = {
          ...state,
          at: now(),
          error: `本地缓存快照 ${read.database.snapshotAt} 早于当前有效数据 ${floor}，已忽略`,
        };
        return state;
      }
      let accepted = false;
      try {
        accepted = (await apply(read.database)) === true;
      } catch (e) {
        state = { ...state, at: now(), error: `本地缓存 apply 抛错：${e?.message || e}` };
        return state;
      }
      if (!accepted) {
        state = { ...state, at: now(), error: "本地缓存未被 apply 接受，已忽略" };
        return state;
      }
      adopt(read.database, "local-cache", read.savedAt, true, false);
      state = { ...state, error: null };
      return state;
    })();
    return restorePromise;
  }

  async function fetchOne(url) {
    const res = await fetchFn(url, {
      headers: { "User-Agent": "Session-Insight-Pricing" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? "无响应"}`);
    const declared = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
      throw new Error(`响应声明体积 ${declared} 超过上限 ${MAX_DOCUMENT_BYTES}`);
    }
    let text;
    if (typeof res.text === "function") {
      text = await res.text();
      if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) {
        throw new Error(`响应体积超过上限 ${MAX_DOCUMENT_BYTES}`);
      }
    }
    let json;
    if (text !== undefined) json = JSON.parse(text);
    else if (typeof res.json === "function") json = await res.json();
    else throw new Error("响应既没有 text() 也没有 json()");
    validatePricingDatabase(json);
    return json;
  }

  async function runRefresh(force) {
    await restore();
    if (inflight) return inflight;

    // TTL / 失败冷却的短路要在 singleflight 之外判定：
    // 否则一次命中 TTL 的普通 refresh 会把并发的 force 调用一起吞掉。
    if (!force) {
      const at = now();
      if (lastAppliedAt && at - lastAppliedAt < ttlMs) {
        state = { ...state, at };
        return state;
      }
      if (lastFailureAt && at - lastFailureAt < FAILURE_RETRY_MS) {
        state = { ...state, at };
        return state;
      }
    }

    inflight = (async () => {
      const startedAt = now();

      // 并行抓所有源，单个 attempt 只负责「取 + 校验」，绝不在这里 apply
      const slots = new Array(sources.length).fill(null);
      const failures = [];
      let budgetTimer = null;
      const all = Promise.allSettled(
        sources.map(async (url, index) => {
          try {
            slots[index] = { url, index, db: await fetchOne(url) };
          } catch (e) {
            failures.push({ url, message: e?.message || String(e) });
            throw e;
          }
        }),
      );
      const budget = new Promise((resolve) => {
        budgetTimer = setTimeout(() => resolve("budget"), timeoutMs);
        if (typeof budgetTimer?.unref === "function") budgetTimer.unref();
      });
      try {
        await Promise.race([all, budget]);
      } finally {
        clearTimeout(budgetTimer);
      }

      const candidates = slots.filter(Boolean);
      if (!candidates.length) {
        lastFailureAt = now();
        const detail = failures.map((f) => `${f.url}: ${f.message}`).join("；");
        state = {
          ...state,
          at: now(),
          remoteOk: false,
          error: detail || "所有远端源都不可用",
        };
        // 有旧数据就继续用旧数据，source 保持原样（不误标 builtin）
        return state;
      }

      const floor = currentFloorDate();
      const fresh = candidates.filter(
        (c) => !floor || dateOrdinal(c.db.snapshotAt) >= dateOrdinal(floor),
      );
      if (!fresh.length) {
        lastFailureAt = now();
        const seen = candidates.map((c) => `${c.url}@${c.db.snapshotAt}`).join("；");
        state = {
          ...state,
          at: now(),
          remoteOk: true,
          error: `远端快照均不新于当前有效数据 ${floor}（${seen}），保留现有数据`,
        };
        return state;
      }

      // 同日多源时取 urls 顺序靠前的（raw 优先）
      fresh.sort((a, b) => {
        const d = dateOrdinal(b.db.snapshotAt) - dateOrdinal(a.db.snapshotAt);
        return d !== 0 ? d : a.index - b.index;
      });
      const chosen = fresh[0];

      let accepted = false;
      try {
        accepted = (await apply(chosen.db)) === true;
      } catch (e) {
        lastFailureAt = now();
        state = { ...state, at: now(), remoteOk: true, error: `apply 抛错：${e?.message || e}` };
        return state;
      }
      if (!accepted) {
        lastFailureAt = now();
        state = {
          ...state,
          at: now(),
          remoteOk: true,
          error: `远端数据 ${chosen.db.snapshotAt} 未被 apply 接受`,
        };
        return state;
      }

      const saved = await writeCache(chosen.db, chosen.url);
      // 写盘失败时短期重试，不能因为在线已采用就把持久化失败锁住24小时。
      lastAppliedAt = saved.error ? 0 : now();
      lastFailureAt = saved.error ? now() : 0;
      adopt(chosen.db, chosen.url, saved.savedAt, saved.persisted, true);
      state = {
        ...state,
        at: now(),
        error: saved.error || null,
      };
      return state;
    })().finally(() => {
      inflight = null;
    });

    return inflight;
  }

  return {
    restore,
    refresh(force = false) {
      return runRefresh(force === true);
    },
    state() {
      return { ...state };
    },
    // 测试与诊断用：确认是否已经处理过本地缓存，不参与业务逻辑
    get restored() {
      return restored;
    },
  };
}
