// _shot-glow-off.cjs —— 验证「关掉光晕后不再留下固定光斑」并出对比图
// 场景：把鼠标停在分段按钮 / 延迟卡上，分别截「光晕关」与「光晕开」两种状态
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const SELF = __dirname, REPO = path.resolve(SELF, ".."), ID = "session-insight", APP = "session-insight";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9061, CDP_PORT = 9561;

const N = 256;
const series = (b, m, w) => Array.from({ length: N }, (_, i) => b + m * Math.abs(Math.sin(i / w)));
const TOK = { hour: series(2e5, 4e6, 7), d7: series(1e6, 2.6e7, 9), d30: series(3e6, 7e7, 11), day: series(2e6, 5e7, 13) };
const RATE = { hour: series(58, 34, 3), d7: series(62, 30, 5), d30: series(65, 28, 8), day: series(70, 22, 6) };
const COST = { hour: series(0.5, 9, 7), d7: series(3, 60, 9), d30: series(8, 160, 11), day: series(6, 130, 13) };
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const MODELS = {}, PROVS = {}, RANGEP = { hour: {}, d7: {}, d30: {} }, RANGEM = { hour: {}, d7: {}, d30: {} };
const PN = ["deepseek", "xiaomi", "zhipu", "moonshot"];
PN.forEach((p, i) => { PROVS[p] = { tokens: (4 - i) * 4e8, calls: 9000 - i * 900, cost: (4 - i) * 12.5, hitRate: 0.9 - i * 0.03 }; });
for (let i = 0; i < 8; i++) MODELS["model-" + i] = { tokens: (8 - i) * 8e7, calls: 4000 - i * 90, cost: (8 - i) * 3.3, hitRate: 0.95, provider: PN[i % PN.length] };
for (const u of ["hour", "d7", "d30"]) { PN.forEach((p, i) => RANGEP[u][p] = { tokens: (4 - i) * 2e8 }); Object.keys(MODELS).forEach((m, i) => RANGEM[u][m] = { tokens: (8 - i) * 4e7, provider: PN[i % PN.length] }); }
const DAYS = {}; for (let i = 20; i >= 0; i--) { const d = new Date(Date.now() - i * 86400e3); DAYS[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`] = { tokens: 1e8 + i * 3e7, cost: 8 + i * 2.2, hitRate: 0.9, calls: 1200, err: 0 }; }
const LEDGER = { days: DAYS, calls: 39408, errors: 39, tokens: { input: 5.1e9, output: 9.1e7, cacheHit: 4.9e9, cacheMiss: 1.1e8, hitRate: 0.982 }, coverage: { firstDay: Object.keys(DAYS)[0] }, latency: { buckets: { lt1: 10, "1_3": 20, "3_10": 5, gt10: 1 } }, models: MODELS, providers: PROVS, subsystems: { session: { tokens: 2.2e9 }, utility: { tokens: 0.9e9 } }, tokenBuckets: TOK, cacheRateBuckets: RATE, timeBuckets: COST, rangeProviders: RANGEP, rangeModels: RANGEM };
const HERO = { at: Date.now(), tokens: 2.6e9, firstDay: Object.keys(DAYS)[0], calls: 39408, errors: 39, hitRate: 0.982, totalCost: 16.62 };
const STATS = { file: "mock.jsonl", title: "探针会话", model: "deepseek-v3.2", turns: 40, sessionTokens: 1240000, sessionCostCny: 12.34, contextPercent: 42.5, contextWindow: 128000, sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0, series: Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, i: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8, input: 12000, output: 18000, cacheInc: 30000, cacheRead: 30000, cacheMiss: 12000, reasoning: 0, hit: 62 + (i % 17), latencyMs: 1100 })), providers: [{ provider: "deepseek", tokens: 1240000, turns: 40, models: [{ model: "deepseek-v3.2", tokens: 1240000 }] }] };
const THEME_CSS = (() => { try { const b = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(b).sort().reverse()) { const p = path.join(b, d, "themes", "midnight.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {} return ""; })();
const HTML = `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
let FX = { glass: false, glow: false };
const readBody = (req) => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { res(JSON.parse(d || "{}")); } catch { res({}); } }); });
function startServer(port) {
  const srv = http.createServer(async (req, res) => {
    const p = new URL(req.url, "http://127.0.0.1").pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === "/theme.css") return send("text/css", THEME_CSS);
    if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
    const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
    if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : e === ".js" ? "text/javascript" : "application/octet-stream", fs.readFileSync(f)); } res.writeHead(404); return res.end("nf"); }
    const PRE = [`/api/apps/${APP}/routes/api/`, `/api/plugins/${ID}/api/`];
    let api = null; for (const x of PRE) if (p.startsWith(x)) api = p.slice(x.length);
    if (api !== null) {
      if (api === "fx-config") { if (req.method === "POST") { const b = await readBody(req); if (typeof b.glass === "boolean") FX.glass = b.glass; if (typeof b.glow === "boolean") FX.glow = b.glow; } return json(FX); }
      if (api === "stats") return json(STATS);
      if (api === "ledger-stats") return json(LEDGER);
      if (api === "hero-stats") return json(HERO);
      if (api === "total-cost") return json({ totalCost: 16.62, todayModel: {} });
      if (api === "active") return json({ dir: "mock", file: "mock.jsonl" });
      if (api === "sessions") return json({ dir: "mock", sessions: [{ name: "mock.jsonl", title: "探针会话", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 40 }] });
      if (api === "events") return json({ events: [] });
      if (api === "balance") return json({ balances: [], updatedAt: Date.now() });
      if (api === "pricing") return json({ rows: [], updatedAt: Date.now() });
      if (api === "providers" || api === "local-providers") return json({ providers: [] });
      if (api === "build-stamp") return json({ stamp: "glow" });
      return json({ ok: true });
    }
    return json({ ok: true });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
function httpJson(u) { return new Promise((s, j) => { http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { s(JSON.parse(d)); } catch (e) { j(e); } }); }).on("error", j); }); }
async function waitChrome(p) { for (let i = 0; i < 80; i++) { try { return await httpJson(`http://127.0.0.1:${p}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); } send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); } }
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.text }; return r.result?.value; }

const RECTS = `(()=>{const R=e=>{if(!e)return null;const b=e.getBoundingClientRect();return{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}};return {seg:R(document.querySelector('#tokUnitSeg')),lat:R(document.querySelector('.lat-kpis')),latDiv:R(document.querySelector('.lat-kpis>div')),scrollY:Math.round(window.scrollY)};})()`;
const PROBE = `(()=>{const g=(el,ps)=>{try{return el?getComputedStyle(el,ps).display:null}catch(e){return 'err'}};return {segAfter:g(document.querySelector('#tokUnitSeg'),'::after'),latBefore:g(document.querySelector('.lat-kpis>div'),'::before'),spots:document.querySelectorAll('.si-glow-spot').length};})()`;
const SET_FX = (obj) => `(async()=>{
  await fetch('/api/plugins/${ID}/api/fx-config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(obj)})});
  const f=document.createElement('iframe');f.style.display='none';document.body.appendChild(f);
  await new Promise(r=>setTimeout(r,80));
  f.contentWindow.localStorage.setItem('si-fx-config',String(Date.now()));
  await new Promise(r=>setTimeout(r,800));
  f.remove();
  return {fxGlass:document.body.dataset.fxGlass,fxGlow:document.body.dataset.fxGlow};
})()`;

async function hoverAndShoot(cdp, sel, tag) {
  await ev(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e)e.scrollIntoView({block:'center'});return true;})()`);
  await sleep(450);
  const R = await ev(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),sy:Math.round(window.scrollY)};})()`);
  if (!R) return { err: "no element " + sel };
  const x = R.x + R.w / 2, y = R.y + R.h / 2;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 6, y: y - 6, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await sleep(520);
  const pad = 26;
  const clip = { x: Math.max(0, R.x - pad), y: Math.max(0, R.y + R.sy - pad), width: R.w + pad * 2, height: R.h + pad * 2, scale: 3 };
  const r = await cdp.send("Page.captureScreenshot", { format: "png", clip });
  const f = path.join(SELF, `_glow-${tag}.png`);
  fs.writeFileSync(f, Buffer.from(r.data, "base64"));
  return { file: f, rect: R };
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-glow-"));
  const srv = await startServer(PORT);
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=" + CDP_PORT, "--user-data-dir=" + path.join(TMP, "p"), "about:blank"], { stdio: "ignore" });
  try {
    await waitChrome(CDP_PORT);
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { const l = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null); target = (l || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (!target) await sleep(250); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1334, height: 1044, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/plugins/${ID}/page` });
    await sleep(4500);

    const out = { off: {}, on: {} };
    // 关光晕状态
    out.off.state = await ev(cdp, PROBE);
    out.off.segShot = await hoverAndShoot(cdp, "#tokUnitSeg", "off-seg");
    out.off.latShot = await hoverAndShoot(cdp, ".lat-kpis>div", "off-lat");
    out.off.after = await ev(cdp, PROBE);
    // 打开光晕再试同样位置
    out.on.set = await ev(cdp, SET_FX({ glass: false, glow: true }));
    out.on.state = await ev(cdp, PROBE);
    out.on.segShot = await hoverAndShoot(cdp, "#tokUnitSeg", "on-seg");
    out.on.latShot = await hoverAndShoot(cdp, ".lat-kpis>div", "on-lat");
    console.log(JSON.stringify(out, null, 2));
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(400); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
