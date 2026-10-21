// volcengine-plan.js —— 火山方舟 Agent Plan / Coding Plan 的套餐额度查询
//
// 这条链跟别家余额接口不是一回事：它走的是**控制面 OpenAPI**
//   POST https://open.volcengineapi.com/?Action=...&Version=2024-01-01&Region=...
// 强制火山引擎签名 V4（HMAC-SHA256，用账号的 AccessKey ID + Secret）。
// 推理用的 Bearer Key 打不动这里（网关在格式层就拒），两套凭据不能混用。
//
// 签名算法是 AWS SigV4 的变体，照搬标准 SigV4 会签不通，两处差异：
//   1) CanonicalHeaders / SignedHeaders 用**固定顺序**（host;x-date;x-content-sha256;content-type），
//      不按字母序排；
//   2) 算法串是 `HMAC-SHA256`（无 AWS4 前缀），credential scope 结尾是 `request`
//      （不是 aws4_request），派生密钥时 SecretKey 也不加 `AWS4` 前缀。
// 对照官方 volc-openapi-demos/signature 与社区实测实现（cc-switch coding_plan.rs）。
//
// 两个 plan 共用一个 action 域，同一份 AK/SK。GetAFPUsage（Agent Plan，回绝对额度
// Quota/Used）与 GetCodingPlanUsage（Coding Plan，只回已用百分比）都只给**额度窗口**，
// 窗口里的 ResetTime/SubscribeTime 是滚动窗口属性，**不是订阅到期日**。
// 到期日要从订阅交易接口 ListSubscribeTrade 取：Result.InfoList[].EndTime（Unix 秒）。
// 该接口的字段结构来自官方 ark-cli 的 plans 命令说明（skills/arkcli-plans/references/
// arkcli-plans-get.md），官方 API 参考页未逐字段核对，投影因此只取白名单字段。

import { createHash, createHmac } from "node:crypto";

const OPENAPI_HOST = "open.volcengineapi.com";
const API_VERSION = "2024-01-01";
const SERVICE = "ark";
const CONTENT_TYPE = "application/json; charset=utf-8";
const SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type";
const DEFAULT_REGION = "cn-beijing";

/** 两种 plan 的字段名不同，窗口统一归到这三档。 */
const WINDOW_META = {
  five_hour: { short: "5h", label: "5 小时窗口" },
  weekly: { short: "周", label: "周窗口" },
  monthly: { short: "月", label: "月窗口" },
};
const WINDOW_ORDER = ["five_hour", "weekly", "monthly"];

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC3986：只放过 unreserved，其余按 %XX（大写）编码。签名串与实际 URL 必须逐字一致。 */
function uriEncode(input) {
  return encodeURIComponent(String(input)).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** 从数据面 baseUrl（如 ark.cn-shanghai.volces.com/api/coding）里取 region，取不到回落 cn-beijing。 */
export function regionFromBaseUrl(baseUrl) {
  const host = String(baseUrl || "").split("://").pop().split("/")[0];
  const seg = host.split(".").find((p) => p.startsWith("cn-") || p.startsWith("ap-"));
  return seg || DEFAULT_REGION;
}

/** 按 key 字母序拼 canonical query；同一份串既用于签名也用于实际 URL。 */
function canonicalQuery(action, region) {
  const pairs = [
    ["Action", action],
    ["Region", region],
    ["Version", API_VERSION],
  ];
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
}

/** 生成鉴权头三元组；canonicalQueryStr 必须与实际请求 URL 的 query 完全一致。 */
export function signRequest({
  accessKeyId,
  secretAccessKey,
  region,
  canonicalQueryStr,
  body = "",
  now = new Date(),
  service = SERVICE,
  host = OPENAPI_HOST,
}) {
  const iso = now.toISOString();
  const xDate = iso.slice(0, 10).replace(/-/g, "") + "T" + iso.slice(11, 19).replace(/:/g, "") + "Z";
  const shortDate = xDate.slice(0, 8);
  const xContentSha256 = sha256Hex(body);

  // 固定顺序，不排序（火山特有，照抄标准 SigV4 的字母序会失败）。
  const canonicalHeaders =
    `host:${host}\n` +
    `x-date:${xDate}\n` +
    `x-content-sha256:${xContentSha256}\n` +
    `content-type:${CONTENT_TYPE}\n`;
  const canonicalRequest =
    `POST\n/\n${canonicalQueryStr}\n${canonicalHeaders}\n${SIGNED_HEADERS}\n${xContentSha256}`;

  const scope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;

  // kDate=HMAC(SK, date)：SecretKey 不加 AWS4 前缀，终止串是 request 而非 aws4_request。
  const kDate = hmacSha256(secretAccessKey, shortDate);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");

  return {
    authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    xDate,
    xContentSha256,
  };
}

/** 火山 OpenAPI 业务错误常以 200 + ResponseMetadata.Error 返回。 */
function responseError(body) {
  const e = body?.ResponseMetadata?.Error || body?.Error;
  if (!e) return null;
  const code = String(e.Code || "");
  const message = String(e.Message || "");
  return code || message ? { code, message } : null;
}

/** 鉴权类错误码：命中就停，不必再试另一个 action（两个 plan 共用同一份 AK/SK）。 */
function isAuthError(code) {
  const c = String(code || "").toLowerCase();
  return ["auth", "signature", "accessdenied", "denied", "unauthorized", "forbidden", "credential", "token"].some(
    (k) => c.includes(k)
  );
}

/**
 * 调一个控制面 action。body 可选：不传时发空串（现有额度查询就是无 body 的 POST），
 * 传对象或字符串时按 UTF-8 序列化，**签名用的 body 与实际发送的 body 必须是同一份字符串**。
 */
async function openapiCall(fetchFn, { region, accessKeyId, secretAccessKey, action, timeoutMs, body }) {
  const bodyStr = typeof body === "string" ? body : body ? JSON.stringify(body) : "";
  const canonicalQueryStr = canonicalQuery(action, region);
  const url = `https://${OPENAPI_HOST}/?${canonicalQueryStr}`;
  const { authorization, xDate, xContentSha256 } = signRequest({
    accessKeyId,
    secretAccessKey,
    region,
    canonicalQueryStr,
    body: bodyStr,
  });
  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      "X-Date": xDate,
      "X-Content-Sha256": xContentSha256,
      "Content-Type": CONTENT_TYPE,
      Authorization: authorization,
    },
    body: bodyStr,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: resp.status, ok: resp.ok, body: parsed, error: responseError(parsed), raw: String(text).slice(0, 200) };
}

/** epoch（秒或毫秒）→ ISO。0 与负数（无活跃窗口的哨兵值）当没有。 */
function resetAtFromEpoch(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  const ms = v < 1e12 ? v * 1000 : v;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function buildWindow(slot, usedPercent, resetAt) {
  const meta = WINDOW_META[slot];
  const used = Math.max(0, Math.min(100, Number(usedPercent) || 0));
  return {
    type: slot,
    label: meta.label,
    short: meta.short,
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    resetAt: resetAt || null,
    windowSeconds: null,
  };
}

/** GetAFPUsage：Quota/Used 是绝对 AFP 值，Quota<=0 视为该窗口未订阅/未启用。 */
function parseAfpWindows(result) {
  const out = [];
  for (const [key, slot] of [
    ["AFPFiveHour", "five_hour"],
    ["AFPWeekly", "weekly"],
    ["AFPMonthly", "monthly"],
  ]) {
    const win = result?.[key];
    const quota = Number(win?.Quota);
    if (!win || !Number.isFinite(quota) || quota <= 0) continue;
    const used = Number(win?.Used);
    out.push(buildWindow(slot, Number.isFinite(used) ? (used / quota) * 100 : 0, resetAtFromEpoch(win?.ResetTime)));
  }
  return out;
}

/** GetCodingPlanUsage：只回已用百分比，Level 实测是 session/weekly/monthly。 */
function parseCodingPlanWindows(result) {
  const arr = result?.QuotaUsage || result?.Usages || result?.Details;
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const level = String(item?.Level || item?.Type || "").toLowerCase();
    const slot = ["session", "5h", "fivehour", "five_hour", "rolling_5h"].includes(level)
      ? "five_hour"
      : ["weekly", "week", "7d"].includes(level)
        ? "weekly"
        : ["monthly", "month"].includes(level)
          ? "monthly"
          : null;
    if (!slot) continue;
    const used = Number(item?.Percent ?? item?.Percentage);
    if (!Number.isFinite(used)) continue;
    out.push(buildWindow(slot, used, resetAtFromEpoch(item?.ResetTimestamp ?? item?.ResetTime)));
  }
  return out;
}

function sortWindows(windows) {
  return windows.slice().sort((a, b) => WINDOW_ORDER.indexOf(a.type) - WINDOW_ORDER.indexOf(b.type));
}

/** 额度查询的 action 顺序：Coding 专用 baseUrl 优先 Coding 接口，免得先命中 Agent 套餐把额度串了。 */
function planActionOrder(baseUrl) {
  return /\/coding|coding[-_]?plan|token[-_]?plan/i.test(String(baseUrl || ""))
    ? ["GetCodingPlanUsage", "GetAFPUsage"]
    : ["GetAFPUsage", "GetCodingPlanUsage"];
}

/* ── 订阅（到期日）查询 ────────────────────────────────────────────────
 * ListSubscribeTrade 是只读的交易/订阅列举接口，与额度接口同域、同一份 AK/SK。
 *
 * 已核实：action 名、ResourceNames 分桶（个人版 Agent 用 RealAgentPlanPersonal，
 * Coding 用空字符串）、响应定位在 Result.InfoList、到期字段 EndTime（Unix 秒）。
 * 未核实：订阅起始时间字段、实付金额/币种字段。后者一律置 null，不猜、不套官网价。
 * 企业版不在 ListSubscribeTrade 暴露（官方改用 GetSeatInfo），所以 scope=team 明确 unsupported。
 */

const SUBSCRIPTION_ACTION = "ListSubscribeTrade";

/** 个人版分桶：Coding Plan 传 [""]，Agent Plan 才传 RealAgentPlanPersonal。两者不混用。 */
function resourceNamesFor(planKind) {
  return planKind === "agent" ? ["RealAgentPlanPersonal"] : [""];
}

/** 按 planKind 挑交付名。档位字段未核实，不拼进去。 */
function planNameFor(planKind) {
  return planKind === "agent" ? "Agent Plan" : "Coding Plan";
}

/**
 * 时间归一。EndTime 实测可能给 Unix 秒（数字或数字字符串），也可能给带时区 ISO。
 * 0 / 负数 / 解析失败一律当“没有”，不伪造 1970。
 */
function parseTimeValue(v) {
  if (v == null) return null;
  if (typeof v === "number") return epochToIso(v);
  const s = String(v).trim();
  if (!s) return null;
  if (/^-?\d+$/u.test(s)) return epochToIso(Number(s));
  const t = Date.parse(s);
  if (!Number.isFinite(t) || t <= 0) return null;
  return new Date(t).toISOString();
}

function epochToIso(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  // 小于 1e12 视为秒；再大的按毫秒（2026 年的毫秒值在 1.7e12 量级）。
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 只取已核实的容器；不认别的猜测字段名，免得把别的数组当订阅列表。 */
function subscriptionInfoList(body) {
  const result = body?.Result ?? body ?? {};
  return Array.isArray(result?.InfoList) ? result.InfoList : null;
}

/**
 * 稳定标识：优先用交易/订阅 ID；官方 CLI 文档只在续费流程里点名 InstanceID，
 * 所以候选顺序按它排，其余同类大小写变体兼容。全缺时用 kind/scope/起止拼指纹。
 */
function externalIdOf(item, planKind, scope, validTo) {
  const raw = item?.InstanceID ?? item?.InstanceId ?? item?.SubscriptionID ?? item?.SubscriptionId ?? item?.ID ?? item?.Id;
  const id = raw == null ? "" : String(raw).trim();
  if (id) return id;
  return `volc:${planKind}:${scope}:${validTo || "unknown"}`;
}

/** 白名单投影：只吐契约里的八个字段，原始响应一个键都不外流。 */
function projectSubscription(item, { planKind, scope, validTo }) {
  return {
    externalId: externalIdOf(item, planKind, scope, validTo),
    planName: planNameFor(planKind),
    planKind,
    scope,
    // 订阅起始字段未核实：不拿额度窗口的 SubscribeTime 冒充。
    validFrom: null,
    validTo,
    // 实付金额字段未核实：不套官网价。
    amount: null,
    currency: null,
  };
}

/** 错误详情脱敏：任何情况下不把 AK/SK 带回上层。 */
function redactDetail(text, secrets) {
  let out = String(text == null ? "" : text);
  for (const sec of secrets) {
    const s = String(sec || "");
    if (s) out = out.split(s).join("***");
  }
  return out.slice(0, 200);
}

/** 权限类与签名类分开：前者是 IAM 没给 ark:ListSubscribeTrade，后者是凭据/签名错。 */
function isPermissionError(code) {
  const c = String(code || "").toLowerCase();
  return ["accessdenied", "denied", "forbidden", "unauthorized", "notauthorized"].some((k) => c.includes(k));
}

/**
 * 查当前账号的套餐订阅（只读）。返回：
 *   { ok:true, subscriptions:[...] , reason?:"ambiguous", detail? }
 *   { ok:false, subscriptions:[], reason:"no_key"|"auth"|"permission"|"network"|"api"|"empty"|"unsupported", detail? }
 */
export async function queryVolcengineSubscription({
  fetchFn,
  accessKeyId,
  secretAccessKey,
  baseUrl,
  timeoutMs = 6000,
  planKind = "coding",
  scope = "personal",
} = {}) {
  const ak = String(accessKeyId || "").trim();
  const sk = String(secretAccessKey || "").trim();
  const secrets = [ak, sk];
  if (!ak || !sk) return { ok: false, subscriptions: [], reason: "no_key" };

  const kind = planKind === "agent" ? "agent" : "coding";
  const sc = String(scope || "personal");
  if (sc !== "personal") {
    // 团队版走 GetSeatInfo（ExpiredTime），参数/字段未在官方 API 参考页核实，不伪实现。
    return {
      ok: false,
      subscriptions: [],
      reason: "unsupported",
      detail: "scope=team 需 GetSeatInfo，参数与字段尚未核实",
    };
  }

  const region = regionFromBaseUrl(baseUrl);
  const body = { ResourceNames: resourceNamesFor(kind) };

  let res;
  try {
    res = await openapiCall(fetchFn, {
      region,
      accessKeyId: ak,
      secretAccessKey: sk,
      action: SUBSCRIPTION_ACTION,
      timeoutMs,
      body,
    });
  } catch (e) {
    return { ok: false, subscriptions: [], reason: "network", detail: redactDetail(e?.message || e, secrets) };
  }

  if (res.error) {
    const code = res.error.code;
    if (isPermissionError(code)) {
      return {
        ok: false,
        subscriptions: [],
        reason: "permission",
        detail: redactDetail(`${code}: ${res.error.message}`, secrets),
      };
    }
    if (isAuthError(code)) {
      return {
        ok: false,
        subscriptions: [],
        reason: "auth",
        detail: redactDetail(`${code}: ${res.error.message}`, secrets),
      };
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      subscriptions: [],
      reason: "api",
      detail: redactDetail(
        `HTTP ${res.status}${res.error ? " " + res.error.code : ""}`,
        secrets
      ),
    };
  }
  if (res.error) {
    return { ok: false, subscriptions: [], reason: "api", detail: redactDetail(res.error.code, secrets) };
  }

  const infoList = subscriptionInfoList(res.body);
  if (!infoList) return { ok: false, subscriptions: [], reason: "parse_failed", detail: "Result.InfoList 不是数组" };
  if (!infoList.length) return { ok: false, subscriptions: [], reason: "empty" };

  const projected = infoList.map((item) => {
    const validTo = parseTimeValue(item?.EndTime ?? item?.EndTimeMs);
    return projectSubscription(item, { planKind: kind, scope: sc, validTo });
  });

  // 同一订阅重复出现、或存在多条有效订阅时，不替调用方挑“第一条”。
  const seen = new Set();
  let duplicate = false;
  for (const s of projected) {
    if (seen.has(s.externalId)) duplicate = true;
    seen.add(s.externalId);
  }
  if (duplicate || projected.length > 1) {
    return {
      ok: true,
      subscriptions: projected,
      reason: "ambiguous",
      detail: duplicate
        ? `订阅条目重复（${projected.length} 条，去重后 ${seen.size} 条），未自动择一`
        : `存在 ${projected.length} 条订阅条目，未自动择一`,
    };
  }

  return { ok: true, subscriptions: projected };
}

/**
 * 查当前账号的套餐额度。返回三态之一：
 *   { ok:true, plan, windows }
 *   { ok:false, reason:"no_key"|"auth"|"network"|"api"|"empty", detail }
 */
export async function queryVolcenginePlan({ fetchFn, accessKeyId, secretAccessKey, baseUrl, timeoutMs = 6000 }) {
  const ak = String(accessKeyId || "").trim();
  const sk = String(secretAccessKey || "").trim();
  if (!ak || !sk) return { ok: false, reason: "no_key" };
  const region = regionFromBaseUrl(baseUrl);

  const soft = [];
  for (const action of planActionOrder(baseUrl)) {
    let res;
    try {
      res = await openapiCall(fetchFn, { region, accessKeyId: ak, secretAccessKey: sk, action, timeoutMs });
    } catch (e) {
      return { ok: false, reason: "network", detail: String(e?.message || e).slice(0, 160) };
    }
    if (res.error && isAuthError(res.error.code)) {
      return { ok: false, reason: "auth", detail: `${res.error.code}: ${res.error.message}`.slice(0, 200) };
    }
    if (!res.ok) {
      // 火山网关对签名/凭据类错误常返 4xx 且带同一个 Error 信封；非鉴权类记下来继续试另一个 plan。
      soft.push(`${action} HTTP ${res.status}${res.error ? " " + res.error.code : ""}`);
      continue;
    }
    if (res.error) {
      soft.push(`${action} ${res.error.code}`);
      continue;
    }
    const result = res.body?.Result ?? res.body ?? {};
    const windows = sortWindows(action === "GetAFPUsage" ? parseAfpWindows(result) : parseCodingPlanWindows(result));
    if (windows.length) {
      const planType = String(result?.PlanType || "").trim();
      return {
        ok: true,
        plan: action === "GetAFPUsage" ? (planType ? `Agent Plan ${planType}` : "Agent Plan") : "Coding Plan",
        windows,
      };
    }
  }
  if (soft.length) return { ok: false, reason: "api", detail: soft.join("; ").slice(0, 200) };
  return { ok: false, reason: "empty", detail: "签名通过但没取到额度（该账号可能没有 Agent / Coding Plan 订阅）" };
}
