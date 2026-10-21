// assets/app-api.js — 应用内路由的统一入口
// v2 App 的接口都在 /api/apps/<appId>/routes/<path>，凭证走 appSurfaceSession 头。
export const APP_ID = "session-insight";

export function apiUrl(path) {
  return `${location.origin}/api/apps/${APP_ID}/routes/${path}`;
}

export async function apiFetch(path, init = {}, timeoutMs = 8000) {
  const ss = new URLSearchParams(location.search).get("appSurfaceSession") || "";
  const headers = new Headers(init.headers || {});
  if (ss) headers.set("X-Hana-App-Surface-Session", ss);
  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const messages = { 'revision-conflict': '计费配置已被另一窗口修改，请重新打开后再保存', 'store-corrupt': '计费配置文件损坏，已停止写入以保护原数据', 'invalid-body': '请求内容无效' };
    const message = (Array.isArray(detail?.errors) ? detail.errors.join('；') : '') || messages[detail?.error] || detail?.message || detail?.error || '';
    const error = new Error(message ? String(message) : "HTTP " + res.status);
    error.status = res.status;
    throw error;
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : null;
}
