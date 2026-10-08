// scripts/_probe-share-anim.cjs —— 采样份额卡横竖切换时圆环/图例的 transform，判断 FLIP 是否真的在动
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, "..");
const ID = "session-insight";
const PORT = 8921, CDP_PORT = 9421;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-sa-"));
const now = Date.now();
const PROVIDERS = { providers: [{ id: "volcengine-coding", name: "火山方舟 Coding", baseUrl: null, local: false, links: [], launch: null, view: "token", models: [] }] };
const BALANCE = { balances: [], unsupported: [], updatedAt: now };
const THEME = (() => { try { const base = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "themes", "warm-paper.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {} return ""; })();
const HTML = `<!doctype html><html data-theme="warm-paper"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="warm-paper" data-surface="widget"><div id="root" data-surface="widget"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
const send = (res, t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
const json = (res, o) => send(res, "application/json", JSON.stringify(o));
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://127.0.0.1").pathname;
  if (p === "/theme.css") return send(res, "text/css", THEME);
  if (p === `/api/plugins/${ID}/page` || p === `/api/plugins/${ID}/widget`) return send(res, "text/html; charset=utf-8", HTML);
  const asset = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (asset) { const f = path.join(REPO, "ui", "assets", asset[1]); if (fs.existsSync(f)) return send(res, path.extname(f).toLowerCase() === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); res.writeHead(404); return res.end(""); }
  const api = p.startsWith(`/api/apps/session-insight/routes/api/`) ? p.slice(`/api/apps/session-insight/routes/api/`.length) : null;
  if (api === null) return json(res, { ok: true });
  switch (api) {
    case "providers": return json(res, PROVIDERS);
    case "balance": return json(res, BALANCE);
    case "stats": return json(res, { file: "a.jsonl", title: "会话 A", model: "deepseek-flash", turns: 3, sessionTokens: 120000, series: [], providers: [{ provider: "deepseek", tokens: 4060000, turns: 2, cost: 0 }, { provider: "magpie", tokens: 120000, turns: 1, cost: 0 }] });
    case "active": return json(res, { file: "a.jsonl" });
    case "sessions": return json(res, { sessions: [], count: 0 });
    case "events": return json(res, { events: [] });
    case "ledger-stats": return json(res, { days: {}, tokens: {}, models: {}, billingModes: {}, providerWindows: {} });
    default: return json(res, { ok: true });
  }
});
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); } send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); } }
async function ev(c, expression, release = false) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { __exception: r.exceptionDetails.text } : r.result?.value; }

(async () => {
  const WATCH = setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 100000);
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  console.log("SERVER UP");
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${CDP_PORT}`, "--user-data-dir=" + path.join(TMP, "p"), "--window-size=720,900", "about:blank"], { stdio: "ignore" });
  proc.on("error", (e) => { console.log("SPAWN ERROR " + e.message); process.exit(3); });
  try {
    let t = null;
    for (let i = 0; i < 80 && !t; i++) { const l = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    console.log("CDP TARGET " + (t ? "found" : "MISSING"));
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    console.log("CDP CONNECTED");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/plugins/${ID}/widget` });
    await sleep(4000);
    console.log("BEFORE " + JSON.stringify(await ev(cdp, `(()=>{const d=document.querySelector('#wProviderShare .w-share-donut'),l=document.querySelector('#wProviderShare .w-share-legend');const body=document.querySelector('#wProviderShare .w-share-body');return {stacked:body?body.dataset.stacked:'',dT:d?getComputedStyle(d).transform:'',lT:l?getComputedStyle(l).transform:''};})()`)));
    // 先布好采样器，再改宽度，尽量贴住切换那一刻
    await ev(cdp, `(()=>{const d=document.querySelector('#wProviderShare .w-share-donut'),l=document.querySelector('#wProviderShare .w-share-legend');window.__t=[];const t0=performance.now();const tick=()=>{const dt=Math.round(performance.now()-t0);window.__t.push([dt,(getComputedStyle(d).transform||'').slice(0,42),(getComputedStyle(l).transform||'').slice(0,42),d.style.transition.slice(0,20)]);if(performance.now()-t0<900)requestAnimationFrame(tick);};requestAnimationFrame(tick);})()`);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 300, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(1200);
    const rec = await ev(cdp, "window.__t");
    console.log("SAMPLES " + JSON.stringify(rec));
    clearTimeout(WATCH);
    ws.close();
  } catch (e) { console.error("PROBE ERROR:", (e && e.stack) || e); }
  finally { try { proc.kill(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(0), 300); }
})();
