// _probe-profile.cjs —— 静止状态下抓 CPU profile，定位到底谁在持续跑
// 用法: node scripts/_probe-profile.cjs [秒数] [page|widget]
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const SELF = __dirname, REPO = path.resolve(SELF, ".."), ID = "session-insight", APP = "session-insight-v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9091, CDP_PORT = 9591;
const SECS = Number(process.argv[2] || 10);
const SURFACE = process.argv[3] || "page";

const N = 256;
const series = (b, m, w) => Array.from({ length: N }, (_, i) => b + m * Math.abs(Math.sin(i / w)));
const TOK = { hour: series(2e5, 4e6, 7), d7: series(1e6, 2.6e7, 9), d30: series(3e6, 7e7, 11), day: series(2e6, 5e7, 13) };
const RATE = { hour: series(58, 34, 3), d7: series(62, 30, 5), d30: series(65, 28, 8), day: series(70, 22, 6) };
const COST = { hour: series(0.5, 9, 7), d7: series(3, 60, 9), d30: series(8, 160, 11), day: series(6, 130, 13) };
const MODELS = {}, PROVS = {}, RANGEP = { hour: {}, d7: {}, d30: {} }, RANGEM = { hour: {}, d7: {}, d30: {} };
const PN = ["deepseek", "xiaomi", "zhipu", "moonshot"];
PN.forEach((p, i) => { PROVS[p] = { tokens: (4 - i) * 4e8, calls: 9000 - i * 900, cost: 12.5, hitRate: 0.9 }; });
for (let i = 0; i < 12; i++) MODELS["model-" + i] = { tokens: (12 - i) * 8e7, calls: 4000 - i * 90, cost: 3.3, hitRate: 0.95, provider: PN[i % PN.length] };
for (const u of ["hour", "d7", "d30"]) { PN.forEach((p, i) => RANGEP[u][p] = { tokens: (4 - i) * 2e8 }); Object.keys(MODELS).forEach((m, i) => RANGEM[u][m] = { tokens: (12 - i) * 4e7, provider: PN[i % PN.length] }); }
const DAYS = {}; for (let i = 20; i >= 0; i--) { const d = new Date(Date.now() - i * 86400e3); DAYS[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`] = { tokens: 1e8 + i * 3e7, cost: 8 + i * 2.2, hitRate: 0.9, calls: 1200, err: 0 }; }
const LEDGER = { days: DAYS, calls: 39408, errors: 39, tokens: { input: 5.1e9, output: 9.1e7, cacheHit: 4.9e9, cacheMiss: 1.1e8, hitRate: 0.982 }, coverage: { firstDay: Object.keys(DAYS)[0] }, latency: { buckets: { lt1: 10, "1_3": 20, "3_10": 5, gt10: 1 } }, models: MODELS, providers: PROVS, subsystems: { session: { tokens: 2.2e9 }, utility: { tokens: 0.9e9 } }, tokenBuckets: TOK, cacheRateBuckets: RATE, timeBuckets: COST, rangeProviders: RANGEP, rangeModels: RANGEM };
const HERO = { at: Date.now(), tokens: 2.6e9, firstDay: Object.keys(DAYS)[0], calls: 39408, errors: 39, hitRate: 0.982, totalCost: 16.62 };
const STATS = { file: "mock.jsonl", title: "探针会话", model: "deepseek-v3.2", turns: 60, sessionTokens: 1240000, sessionCostCny: 12.34, contextPercent: 42.5, contextWindow: 128000, sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0, series: Array.from({ length: 60 }, (_, i) => ({ turn: i + 1, i: i + 1, total: 62000 + i * 4200, cost: 62000 * 3e-8, input: 12000, output: 18000, cacheInc: 30000, cacheRead: 30000, cacheMiss: 12000, reasoning: 0, hit: 62 + (i % 17), latencyMs: 1100 })), providers: [{ provider: "deepseek", tokens: 1240000, turns: 60, models: [{ model: "deepseek-v3.2", tokens: 1240000 }] }] };
const THEME_CSS = (() => { try { const b = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(b).sort().reverse()) { const p = path.join(b, d, "themes", "midnight.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {} return ""; })();
const HTML = (s) => `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="${s}"><div id="root" data-surface="${s}"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
function startServer(port) {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, "http://127.0.0.1").pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === "/theme.css") return send("text/css", THEME_CSS);
    if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML("page"));
    if (p === `/api/plugins/${ID}/widget`) return send("text/html; charset=utf-8", HTML("widget"));
    const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
    if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : e === ".js" ? "text/javascript" : "application/octet-stream", fs.readFileSync(f)); } res.writeHead(404); return res.end("nf"); }
    const PRE = [`/api/apps/${APP}/routes/api/`, `/api/plugins/${ID}/api/`];
    let api = null; for (const x of PRE) if (p.startsWith(x)) api = p.slice(x.length);
    if (api !== null) {
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
      if (api === "build-stamp") return json({ stamp: "prof" });
      return json({ ok: true });
    }
    if (p === "/api/sessions/messages") return json({ messages: [] });
    return json({ ok: true });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
function httpJson(u) { return new Promise((s, j) => { http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { s(JSON.parse(d)); } catch (e) { j(e); } }); }).on("error", j); }); }
async function waitChrome(p) { for (let i = 0; i < 80; i++) { try { return await httpJson(`http://127.0.0.1:${p}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.subs = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; } if (m.method && this.subs.has(m.method)) for (const cb of this.subs.get(m.method)) cb(m.params); }); }
  on(m, cb) { if (!this.subs.has(m)) this.subs.set(m, []); this.subs.get(m).push(cb); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); } }

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-prof-"));
  const srv = await startServer(PORT);
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--remote-debugging-port=" + CDP_PORT, "--user-data-dir=" + path.join(TMP, "p"), "about:blank"], { stdio: "ignore" });
  try {
    await waitChrome(CDP_PORT);
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { const l = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null); target = (l || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (!target) await sleep(250); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Profiler.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1334, height: 1044, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/plugins/${ID}/${SURFACE === "widget" ? "widget" : "page"}` });
    await sleep(6000);
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
    await sleep(SECS * 1000);
    const res = await cdp.send("Profiler.stop");
    const p = res.profile;
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const self = new Map();
    for (let i = 0; i < p.samples.length; i++) {
      const id = p.samples[i];
      self.set(id, (self.get(id) || 0) + 1);
    }
    const total = p.samples.length;
    const rows = [...self.entries()].map(([id, c]) => {
      const n = byId.get(id) || {};
      const cf = n.callFrame || {};
      const url = (cf.url || "").split("/").pop();
      return { fn: cf.functionName || "(anonymous)", where: url + ":" + (cf.lineNumber + 1), samples: c, pct: +(c / total * 100).toFixed(1) };
    }).sort((a, b) => b.samples - a.samples).slice(0, 24);
    console.log(JSON.stringify({ surface: SURFACE, seconds: SECS, totalSamples: total, top: rows }, null, 2));
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(400); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
