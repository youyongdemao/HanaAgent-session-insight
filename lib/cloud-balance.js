// cloud-balance.js —— 云账户余额查询（火山 / 阿里云 / 腾讯云 / 百度云）
//
// 这几家给的是**云账号的可用现金**，不是某个产品的额度：同一笔钱会被该账号下
// 所有产品（ECS、OSS、模型服务…）一起消耗，所以界面上标"云账户余额"，
// 免得被读成"百炼/混元还剩这么多"。
//
// 每家都要账号级 AK/SK，各用各的签名：火山 V4（与方舟同族）、阿里云 RPC(HMAC-SHA1)、
// 腾讯云 TC3-HMAC-SHA256、百度云 BCE。凭据一律走子进程直连发出去。

import { createHash, createHmac } from "node:crypto";
import { signRequest as volcSignRequest } from "./volcengine-plan.js";

function sha256hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmacBuf(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC3986 百分号编码：只放过 unreserved，`!*'()` 也要编掉（阿里/百度要求）。 */
function pct(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

async function readJson(resp) {
  const text = await resp.text();
  try {
    return { text, data: JSON.parse(text) };
  } catch {
    return { text, data: null };
  }
}

// ── 火山引擎：费用中心 QueryBalanceAcct（service=billing，V4 签名）──
async function volcengineBalance(fetchFn, ak, sk, timeoutMs) {
  const host = "open.volcengineapi.com";
  const region = "cn-beijing";
  const query = "Action=QueryBalanceAcct&Region=cn-beijing&Version=2022-01-01";
  const s = volcSignRequest({
    accessKeyId: ak,
    secretAccessKey: sk,
    region,
    canonicalQueryStr: query,
    body: "",
    service: "billing",
    host,
  });
  const resp = await fetchFn(`https://${host}/?${query}`, {
    method: "POST",
    headers: {
      "X-Date": s.xDate,
      "X-Content-Sha256": s.xContentSha256,
      "Content-Type": "application/json; charset=utf-8",
      Authorization: s.authorization,
    },
    body: "",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const { text, data } = await readJson(resp);
  const err = data?.ResponseMetadata?.Error;
  if (err) {
    return { ok: false, reason: /auth|denied|signature|permission|forbidden/i.test(String(err.Code)) ? "auth" : "api", detail: `${err.Code}: ${err.Message}`.slice(0, 160) };
  }
  if (!resp.ok) return { ok: false, reason: "api", detail: `HTTP ${resp.status} ${text.slice(0, 120)}` };
  const r = data?.Result || {};
  const total = Number(r.AvailableBalance ?? r.CashBalance);
  if (!Number.isFinite(total)) return { ok: false, reason: "empty", detail: text.slice(0, 160) };
  return { ok: true, total, currency: String(r.Currency || "CNY") };
}

// ── 阿里云：BssOpenApi QueryAccountBalance（RPC 风格 + HMAC-SHA1）──
/** 阿里云 RPC 签名（V2）。导出只为单测能对着官方测试向量核。 */
export function aliyunSignature(params, accessKeySecret) {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const stringToSign = `GET&${pct("/")}&${pct(canonical)}`;
  return createHmac("sha1", accessKeySecret + "&").update(stringToSign, "utf8").digest("base64");
}

async function aliyunBalance(fetchFn, ak, sk, timeoutMs) {
  const host = "business.aliyuncs.com";
  const params = {
    AccessKeyId: ak,
    Action: "QueryAccountBalance",
    Format: "JSON",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2017-12-14",
  };
  const signature = aliyunSignature(params, sk);
  const query =
    Object.keys(params)
      .sort()
      .map((k) => `${pct(k)}=${pct(params[k])}`)
      .join("&") + `&Signature=${pct(signature)}`;
  const resp = await fetchFn(`https://${host}/?${query}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const { text, data } = await readJson(resp);
  if (data?.Code) {
    return { ok: false, reason: /InvalidAccessKey|Forbidden|SignatureDoesNotMatch|Unauthorized/i.test(String(data.Code)) ? "auth" : "api", detail: `${data.Code}: ${data.Message || ""}`.slice(0, 160) };
  }
  if (!resp.ok) return { ok: false, reason: "api", detail: `HTTP ${resp.status} ${text.slice(0, 120)}` };
  const d = data?.Data || {};
  const total = Number(d.AvailableAmount ?? d.AvailableCashAmount);
  if (!Number.isFinite(total)) return { ok: false, reason: "empty", detail: text.slice(0, 160) };
  return { ok: true, total, currency: String(d.Currency || "CNY") };
}

// ── 腾讯云：billing DescribeAccountBalance（TC3-HMAC-SHA256）──
export function tencentSignature({ secretId, secretKey, host, service, action, version, payload, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256hex(payload)}`;
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const kDate = hmacBuf(`TC3${secretKey}`, date);
  const kService = hmacBuf(kDate, service);
  const kSigning = hmacBuf(kService, "tc3_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    contentType,
    timestamp: String(timestamp),
  };
}

async function tencentBalance(fetchFn, secretId, secretKey, timeoutMs) {
  const host = "billing.tencentcloudapi.com";
  const payload = "{}";
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = tencentSignature({
    secretId,
    secretKey,
    host,
    service: "billing",
    action: "DescribeAccountBalance",
    version: "2018-10-09",
    payload,
    timestamp,
  });
  const resp = await fetchFn(`https://${host}/`, {
    method: "POST",
    headers: {
      Authorization: signed.authorization,
      "Content-Type": signed.contentType,
      Host: host,
      "X-TC-Action": "DescribeAccountBalance",
      "X-TC-Timestamp": signed.timestamp,
      "X-TC-Version": "2018-10-09",
    },
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const { text, data } = await readJson(resp);
  const err = data?.Response?.Error;
  if (err) {
    return { ok: false, reason: /AuthFailure|Unauthorized|Signature/i.test(String(err.Code)) ? "auth" : "api", detail: `${err.Code}: ${err.Message || ""}`.slice(0, 160) };
  }
  if (!resp.ok) return { ok: false, reason: "api", detail: `HTTP ${resp.status} ${text.slice(0, 120)}` };
  const r = data?.Response || {};
  // Balance 单位是「分」；RealBalance 口径更接近可支配金额。
  const cents = Number(r.RealBalance ?? r.Balance);
  if (!Number.isFinite(cents)) return { ok: false, reason: "empty", detail: text.slice(0, 160) };
  return { ok: true, total: Math.round(cents) / 100, currency: "CNY" };
}

// ── 百度智能云：Finance 账户余额（BCE 签名）──
export function baiduAuthString({ accessKeyId, secretKey, host, path, timestamp, expireSeconds = 1800 }) {
  const authStringPrefix = `bce-auth-v1/${accessKeyId}/${timestamp}/${expireSeconds}`;
  const signingKey = createHmac("sha256", secretKey).update(authStringPrefix).digest("hex");
  const canonicalHeaders = `host:${host}`;
  const canonicalRequest = `GET\n${path}\n\n${canonicalHeaders}`;
  const signature = createHmac("sha256", signingKey).update(canonicalRequest).digest("hex");
  return `${authStringPrefix}/${encodeURIComponent("host")}/${signature}`;
}

async function baiduBalance(fetchFn, ak, sk, timeoutMs) {
  const host = "billing.baidubce.com";
  const path = "/v1/finance/cash/balance";
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const authorization = baiduAuthString({ accessKeyId: ak, secretKey: sk, host, path, timestamp });
  const resp = await fetchFn(`https://${host}${path}`, {
    method: "GET",
    headers: { Authorization: authorization, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const { text, data } = await readJson(resp);
  if (data?.code || data?.Code) {
    const code = String(data.code || data.Code);
    return { ok: false, reason: /AccessDenied|Signature|InvalidAccessKey/i.test(code) ? "auth" : "api", detail: `${code}: ${data.message || data.Message || ""}`.slice(0, 160) };
  }
  if (!resp.ok) return { ok: false, reason: "api", detail: `HTTP ${resp.status} ${text.slice(0, 120)}` };
  const total = Number(data?.cashBalance ?? data?.balance ?? data?.availableBalance);
  if (!Number.isFinite(total)) return { ok: false, reason: "empty", detail: text.slice(0, 160) };
  return { ok: true, total, currency: "CNY" };
}

/**
 * 云账户余额适配器。cred 形状：{ provider, keys: { a, b } }，两家用一对 AK/SK。
 * 火山与方舟共用一对 AK/SK（同一账号），凭据 id 沿用 volcengineAccessKey / volcengineSecretKey。
 */
export const CLOUD_ADAPTERS = {
  volcengine: {
    name: "火山方舟",
    keyIds: ["volcengineAccessKey", "volcengineSecretKey"],
    run: volcengineBalance,
  },
  dashscope: {
    name: "阿里云百炼",
    keyIds: ["aliyunAccessKeyId", "aliyunAccessKeySecret"],
    run: aliyunBalance,
  },
  hunyuan: {
    name: "腾讯混元",
    keyIds: ["tencentSecretId", "tencentSecretKey"],
    run: tencentBalance,
  },
  "baidu-cloud": {
    name: "百度智能云千帆",
    keyIds: ["baiduAccessKeyId", "baiduAccessKeySecret"],
    run: baiduBalance,
  },
};
