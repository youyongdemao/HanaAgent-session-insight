// shot-provider-lamps.cjs —— 用无头 Chrome 渲染 API 管理页的供应商区块并截图
// 用于肉眼确认灯色语义与排序：绿=可读 / 粉=本地部署 / 亮红=有接口但失败 / 灰=暂无余额接口
// 用法: node scripts/shot-provider-lamps.cjs [输出png路径]
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const CSS = path.join(REPO, "assets", "panel-v2.css");
const PANEL = path.join(REPO, "assets", "panel-v2.js");
const ID = "session-insight";
const OUT = process.argv[2] || path.join(REPO, "..", "provider-lamps.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG = ["deepseek", "ollama", "freetoken", "zhipu", "openai", "gemini", "agnes"];
const BASE_URL = {
  deepseek: "https://api.deepseek.com", ollama: "http://localhost:11434/v1", freetoken: "http://127.0.0.1:1919/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4", openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com", agnes: "https://apihub.agnes-ai.com/v1",
};
const BALANCE = {
  deepseek: { provider: "deepseek", name: "DeepSeek", status: "ok", kind: "balance", label: "可用余额", summary: "¥42.50", total: 42.5, currency: "CNY" },
  agnes: { provider: "agnes", name: "Agnes", status: "ok", kind: "quota", label: "订阅配额", summary: "76%", remainingPercent: 76 },
  zhipu: { provider: "zhipu", name: "智谱", status: "http_502", detail: "bad gateway" },
};
const UNSUPPORTED = {
  ollama: { provider: "ollama", note: "无官方余额接口" },
  openai: { provider: "openai", note: "需配置 OpenAI Admin Key" },
  gemini: { provider: "gemini", note: "暂无余额接口" },
};
const STATS = { file: "20260919-a.jsonl", title: "会话", model: "deepseek-flash", turns: 2, sessionTokens: 1000, sessionCostCny: 1, contextPercent: 10, sumInput: 700, sumOutput: 300, sumCacheRead: 200, sumReasoning: 0, series: [{ turn: 1, total: 1000, cost: 0.01, input: 700, output: 300, cacheHit: 200, cacheMiss: 100, reasoning: 0, hitRate: 0.6, latencyMs: 900 }], providers: [{ provider: "deepseek", tokens: 1000 }] };
const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="dark" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

function startServer(port) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    const base = `/api/plugins/${ID}`;
    if (p === `${base}/page`) return send("text/html; charset=utf-8", HTML);
    if (p === `${base}/assets/panel-v2.css`) return send("text/css", fs.readFileSync(CSS));
    if (p === `${base}/assets/panel-v2.js`) return send("text/javascript", fs.readFileSync(PANEL));
    if (p === `${base}/api/providers`) return json({ providers: CONFIG.map((id) => ({ id, name: null, baseUrl: BASE_URL[id] || null, models: [] })) });
    if (p === `${base}/api/balance`) return json({
      balances: CONFIG.filter((id) => BALANCE[id]).map((id) => BALANCE[id]),
      unsupported: CONFIG.filter((id) => UNSUPPORTED[id]).map((id) => UNSUPPORTED[id]),
      updatedAt: Date.now(),
    });
    if (p === `${base}/api/stats`) return json(STATS);
    if (p === `${base}/api/active`) return json({ dir: "mock", file: null });
    if (p === `${base}/api/resolve-entry`) return json({ file: null });
    if (p === `${base}/api/sessions`) return json({ dir: "mock", sessions: [{ name: STATS.file, title: "会话", model: STATS.model, size: 1, mtime: Date.now(), turns: 2 }] });
    if (p === `${base}/api/ledger-stats`) return json({ days: { "2026-09-19": { tokens: 1000, cost: 1 } }, calls: 3, errors: 0, tokens: { input: 700, output: 300, cacheHit: 200, cacheMiss: 100, hitRate: 0.6 } });
    if (p === `${base}/api/total-cost`) return json({ totalCost: 1.23 });
    if (p === `${base}/api/rules`) return json({});
    if (p === `${base}/api/events`) return json({ events: [] });
    if (p === `${base}/api/pricing`) return json({ models: [], updatedAt: Date.now() });
    if (p === "/api/sessions/messages") return setTimeout(() => json({ messages: [] }), 300);
    return json({ ok: true });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
async function waitChrome(port, tries = 80) { for (let i = 0; i < tries; i++) { try { return await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-shot-"));
  const srv = await startServer(8797);
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (!fs.existsSync(chromePath)) { console.error("找不到 Chrome: " + chromePath); srv.close(); return; }
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--window-size=1500,1200", "--remote-debugging-port=9338", "--user-data-dir=" + path.join(TMP, "profile"), "about:blank"], { stdio: "ignore" });
  try {
    await waitChrome(9338);
    const list = await httpJson("http://127.0.0.1:9338/json/list");
    const page = list.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const c = new CDP(ws);
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1200, deviceScaleFactor: 2, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:8797/api/plugins/${ID}/page` });
    await sleep(3000);
    await c.send("Runtime.evaluate", { expression: `document.querySelector('.tab[data-view="api"]').click()` });
    await sleep(3000);
    const rect = (await c.send("Runtime.evaluate", {
      expression: `(()=>{const el=document.querySelector('.provider-section')||document.querySelector('#providerList');if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.max(0,r.x-8),y:Math.max(0,r.y-8),width:Math.min(1500,r.width+16),height:Math.min(1200,r.height+16)};})()`,
      returnByValue: true,
    })).result.value;
    if (!rect) throw new Error("没找到供应商区块");
    const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 2 } });
    fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
    console.log("已保存: " + OUT + " (" + fs.statSync(OUT).size + " bytes)");
    ws.close();
  } catch (e) {
    console.error("SHOT ERROR:", (e && e.stack) || e);
  } finally {
    proc.kill(); srv.close();
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
