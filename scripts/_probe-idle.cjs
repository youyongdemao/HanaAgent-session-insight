// _probe-idle.cjs —— 量「什么都不做」时的后台开销：接口调用、主线程占用、DOM 变动、堆内存
// 分别测 page（工作台整页）与 widget（实时用量卡片）两个 surface。
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const SELF = __dirname, REPO = path.resolve(SELF, ".."), ID = "session-insight", APP = "session-insight";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const PORT = Number(argOf("--port", "9071")), CDP_PORT = Number(argOf("--cdp", "9571"));
const IDLE_MS = Number(argOf("--secs", "25000"));
const TAG = argOf("--tag", "current");
const JS_FILE = argOf("--js", path.join(REPO, "ui", "assets", "panel-v2.js"));
const CSS_FILE = argOf("--css", path.join(REPO, "ui", "assets", "panel-v2.css"));

const N = 256;
const series = (b, m, w) => Array.from({ length: N }, (_, i) => b + m * Math.abs(Math.sin(i / w)));
const TOK = { hour: series(2e5, 4e6, 7), d7: series(1e6, 2.6e7, 9), d30: series(3e6, 7e7, 11), day: series(2e6, 5e7, 13) };
const RATE = { hour: series(58, 34, 3), d7: series(62, 30, 5), d30: series(65, 28, 8), day: series(70, 22, 6) };
const COST = { hour: series(0.5, 9, 7), d7: series(3, 60, 9), d30: series(8, 160, 11), day: series(6, 130, 13) };
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const MODELS = {}, PROVS = {}, RANGEP = { hour: {}, d7: {}, d30: {} }, RANGEM = { hour: {}, d7: {}, d30: {} };
const PN = ["deepseek", "xiaomi", "zhipu", "moonshot", "openai", "anthropic"];
PN.forEach((p, i) => { PROVS[p] = { tokens: (6 - i) * 4e8, calls: 9000 - i * 900, cost: (6 - i) * 12.5, hitRate: 0.9 - i * 0.03 }; });
for (let i = 0; i < 30; i++) MODELS["model-" + String(i + 1).padStart(2, "0")] = { tokens: (30 - i) * 8e7, calls: 4000 - i * 90, cost: (30 - i) * 3.3, hitRate: 0.95, provider: PN[i % PN.length] };
for (const u of ["hour", "d7", "d30"]) { const lim = u === "hour" ? 6 : 30; PN.slice(0, lim).forEach((p, i) => RANGEP[u][p] = { tokens: (lim - i) * 2e8 }); Object.keys(MODELS).slice(0, lim * 3).forEach((m, i) => RANGEM[u][m] = { tokens: (lim * 3 - i) * 4e7, provider: PN[i % PN.length] }); }
const DAYS = {}; for (let i = 44; i >= 0; i--) { const d = new Date(Date.now() - i * 86400e3); DAYS[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`] = { tokens: 1e8 + i * 3e7, cost: 8 + i * 2.2, hitRate: 0.9, calls: 1200, err: 0 }; }
const LEDGER = { days: DAYS, calls: 39408, errors: 39, tokens: { input: 5.1e9, output: 9.1e7, cacheHit: 4.9e9, cacheMiss: 1.1e8, hitRate: 0.982 }, coverage: { firstDay: Object.keys(DAYS)[0] }, latency: { buckets: { lt1: 10, "1_3": 20, "3_10": 5, gt10: 1 } }, models: MODELS, providers: PROVS, subsystems: { session: { tokens: 2.2e9 }, utility: { tokens: 0.9e9 }, memory: { tokens: 4e8 } }, tokenBuckets: TOK, cacheRateBuckets: RATE, timeBuckets: COST, rangeProviders: RANGEP, rangeModels: RANGEM };
const HERO = { at: Date.now(), tokens: 2.6e9, firstDay: Object.keys(DAYS)[0], calls: 39408, errors: 39, hitRate: 0.982, totalCost: 16.62 };
const STATS = { file: "mock.jsonl", title: "探针会话", model: "deepseek-v3.2", turns: 60, sessionTokens: 1240000, sessionCostCny: 12.34, contextPercent: 42.5, contextWindow: 128000, sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0, series: Array.from({ length: 60 }, (_, i) => ({ turn: i + 1, i: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8, input: 12000, output: 18000, cacheInc: 30000, cacheRead: 30000, cacheMiss: 12000, reasoning: 0, hit: 62 + (i % 17), latencyMs: 1100 })), providers: [{ provider: "deepseek", tokens: 1240000, turns: 60, models: [{ model: "deepseek-v3.2", tokens: 1240000 }] }] };
const THEME_CSS = (() => { try { const b = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(b).sort().reverse()) { const p = path.join(b, d, "themes", "midnight.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {} return ""; })();
const HTML = (surface) => `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="${surface}"><div id="root" data-surface="${surface}"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
const REQ_LOG = [];
function startServer(port, assets) {
  const srv = http.createServer(async (req, res) => {
    const p = new URL(req.url, "http://127.0.0.1").pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === "/theme.css") return send("text/css", THEME_CSS);
    if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML("page"));
    if (p === `/api/plugins/${ID}/widget`) return send("text/html; charset=utf-8", HTML("widget"));
    const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
    if (m) { const f = (assets && assets[m[1]]) || path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : e === ".js" ? "text/javascript" : "application/octet-stream", fs.readFileSync(f)); } res.writeHead(404); return res.end("nf"); }
    const PRE = [`/api/apps/${APP}/routes/api/`, `/api/plugins/${ID}/api/`];
    let api = null; for (const x of PRE) if (p.startsWith(x)) api = p.slice(x.length);
    if (api !== null) {
      REQ_LOG.push(api);
      if (api === "fx-config") return json({ glass: false, glow: true });
      if (api === "stats") return json(STATS);
      if (api === "ledger-stats") return json(LEDGER);
      if (api === "hero-stats") return json(HERO);
      if (api === "total-cost") return json({ totalCost: 16.62, todayModel: {} });
      if (api === "active") return json({ dir: "mock", file: "mock.jsonl" });
      if (api === "sessions") return json({ dir: "mock", sessions: [{ name: "mock.jsonl", title: "探针会话", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 60 }] });
      if (api === "events") return json({ events: [] });
      if (api === "balance") return json({ balances: [], updatedAt: Date.now() });
      if (api === "pricing") return json({ rows: [], updatedAt: Date.now() });
      if (api === "providers" || api === "local-providers") return json({ providers: [] });
      if (api === "build-stamp") return json({ stamp: "idle-probe" });
      return json({ ok: true });
    }
    if (p === "/api/sessions/messages") { REQ_LOG.push("/api/sessions/messages"); return json({ messages: [] }); }
    return json({ ok: true });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
function httpJson(u) { return new Promise((s, j) => { http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { s(JSON.parse(d)); } catch (e) { j(e); } }); }).on("error", j); }); }
async function waitChrome(p) { for (let i = 0; i < 80; i++) { try { return await httpJson(`http://127.0.0.1:${p}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.subs = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; } if (m.method && this.subs.has(m.method)) for (const cb of this.subs.get(m.method)) cb(m.params); }); }
  on(m, cb) { if (!this.subs.has(m)) this.subs.set(m, []); this.subs.get(m).push(cb); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); } }
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.text }; return r.result?.value; }
async function metrics(cdp) { const r = await cdp.send("Performance.getMetrics"); const o = {}; for (const m of r.metrics) o[m.name] = m.value; return o; }

const WATCH = `(()=>{window.__mut=0;window.__rab=0;window.__frames=0;try{new MutationObserver(ms=>{window.__mut+=ms.length}).observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});}catch(e){}const loop=()=>{window.__frames++;requestAnimationFrame(loop);};requestAnimationFrame(loop);return true;})()`;
const READ = `(()=>({mut:window.__mut||0,frames:window.__frames||0,nodes:document.querySelectorAll('*').length,ods:document.querySelectorAll('.od').length,listeners:window.__listeners||0}))()`;

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-idle-"));
  const srv = await startServer(PORT, { "panel-v2.js": JS_FILE, "panel-v2.css": CSS_FILE });
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--remote-debugging-port=" + CDP_PORT, "--user-data-dir=" + path.join(TMP, "p"), "about:blank"], { stdio: "ignore" });
  const out = {};
  try {
    await waitChrome(CDP_PORT);
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { const l = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null); target = (l || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (!target) await sleep(250); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Performance.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1334, height: 1044, deviceScaleFactor: 1, mobile: false });

    for (const [name, url] of [["page", `http://127.0.0.1:${PORT}/api/plugins/${ID}/page`], ["widget", `http://127.0.0.1:${PORT}/api/plugins/${ID}/widget`]]) {
      REQ_LOG.length = 0;
      await cdp.send("Page.navigate", { url });
      await sleep(5000);
      const m0 = await metrics(cdp);
      const d0 = await ev(cdp, WATCH);
      await sleep(IDLE_MS);
      const d1 = await ev(cdp, READ);
      const m1 = await metrics(cdp);
      const counts = {};
      for (const r of REQ_LOG) counts[r] = (counts[r] || 0) + 1;
      out[name] = {
        tag: TAG, js: path.basename(JS_FILE),
        seconds: IDLE_MS / 1000,
        requests: REQ_LOG.length,
        perMinute: +(REQ_LOG.length * 60000 / IDLE_MS).toFixed(1),
        byPath: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])),
        taskMs: +(((m1.TaskDuration || 0) - (m0.TaskDuration || 0)) * 1000).toFixed(1),
        scriptMs: +(((m1.ScriptDuration || 0) - (m0.ScriptDuration || 0)) * 1000).toFixed(1),
        layoutMs: +(((m1.LayoutDuration || 0) - (m0.LayoutDuration || 0)) * 1000).toFixed(1),
        styleMs: +(((m1.RecalcStyleDuration || 0) - (m0.RecalcStyleDuration || 0)) * 1000).toFixed(1),
        layouts: +((m1.LayoutCount || 0) - (m0.LayoutCount || 0)).toFixed(0),
        styles: +((m1.RecalcStyleCount || 0) - (m0.RecalcStyleCount || 0)).toFixed(0),
        mut: d1.mut, frames: d1.frames, nodes: d1.nodes, ods: d1.ods,
        heapMB: +(((m1.JSHeapUsedSize || 0) / 1048576).toFixed(1)),
        heapDeltaMB: +((((m1.JSHeapUsedSize || 0) - (m0.JSHeapUsedSize || 0)) / 1048576).toFixed(2)),
      };
    }
    console.log(JSON.stringify(out, null, 2));
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(400); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
