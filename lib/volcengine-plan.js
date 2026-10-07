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
// 两个 plan 共用一个 action 域，同一份 AK/SK：先 GetAFPUsage（Agent Plan，回绝对额度
// Quota/Used），未订阅再 GetCodingPlanUsage（Coding Plan，只回已用百分比）。

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

async function openapiCall(fetchFn, { region, accessKeyId, secretAccessKey, action, timeoutMs }) {
  const canonicalQueryStr = canonicalQuery(action, region);
  const url = `https://${OPENAPI_HOST}/?${canonicalQueryStr}`;
  const { authorization, xDate, xContentSha256 } = signRequest({
    accessKeyId,
    secretAccessKey,
    region,
    canonicalQueryStr,
  });
  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      "X-Date": xDate,
      "X-Content-Sha256": xContentSha256,
      "Content-Type": CONTENT_TYPE,
      Authorization: authorization,
    },
    body: "",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: resp.status, ok: resp.ok, body, error: responseError(body), raw: String(text).slice(0, 200) };
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
  for (const action of ["GetAFPUsage", "GetCodingPlanUsage"]) {
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
