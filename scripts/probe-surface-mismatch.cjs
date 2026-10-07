// probe-surface-mismatch.cjs —— body[data-surface] 与 #root[data-surface] 不一致时，hero 会变成什么样
// 用法: node scripts/probe-surface-mismatch.cjs
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "_surface-frames");
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const THEME = (() => { const p = "D:/AI/Hanako/artifacts/renderer/0.970.9/themes/warm-paper.css"; return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; })();
const page = (bodySurface, rootSurface, rootTag) => `<!doctype html><html data-theme="warm-paper"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/assets/panel-v2.css"><link rel="stylesheet" href="/assets/update-notice.css"></head><body data-hana-theme="warm-paper" data-surface="${bodySurface}"><div id="root" data-surface="${rootSurface}"></div><script type="module" src="/assets/panel-v2.js"></script></body></html>`;
let tick = 0;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1"), p = u.pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  const json = (o) => send("application/json", JSON.stringify(o));
  if (p === "/page") return send("text/html; charset=utf-8", page(u.searchParams.get("b") || "page", u.searchParams.get("r") || "page"));
  if (p === "/theme.css") return send("text/css", THEME);
  const m = p.match(/^\/assets\/(.+)$/);
  if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); } res.writeHead(404); return res.end(""); }
  const PREFIX = "/api/apps/session-insight/routes/api/";
  if (p.startsWith(PREFIX)) {
    const api = p.slice(PREFIX.length);
    if (api === "total-cost") { tick++; return json({ totalCost: 209.31 }); }
    if (api === "hero-stats") return json({ ok: true, tokens: 5630000000, totalCost: 209.31, calls: 120, errors: 0, hitRate: 0.62, firstDay: "2026-08-01" });
    if (api === "balance") return json({ balances: [], unsupported: [] });
    if (api === "ledger-stats") return json({ days: {}, tokens: { hitRate: 0.62 }, models: {}, billingModes: {}, providerWindows: {} });
    if (api === "stats") return json({ file: null, turns: 0, series: [] });
    if (api === "providers") return json({ providers: [] });
    if (api === "rules") return json({});
    if (api === "pricing") return json({ rows: [] });
    if (api === "ui-env") return json({});
    if (api === "sessions") return json({ dir: "", sessions: [] });
    if (api === "active") return json({ file: null });
    return json({ ok: true });
  }
  if (p === "/api/sessions/messages") return json({ messages: [] });
  return json({ ok: true });
});
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); } send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); } }
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.text }; return r.result?.value; }
const Q = `(()=>{const t=document.getElementById('tCost');const lab=document.querySelector('.ah-label');const blk=document.querySelector('.ah-block');
 const cs=e=>e?{fs:getComputedStyle(e).fontSize,w:getComputedStyle(e).fontWeight,color:getComputedStyle(e).color,op:getComputedStyle(e).opacity,ls:getComputedStyle(e).letterSpacing}:null;
 const r=t?t.getBoundingClientRect():null;
 return {bodySurface:document.body.getAttribute('data-surface'),rootSurface:document.getElementById('root')?.getAttribute('data-surface'),
  hasTCost:!!t, num:cs(t), label:cs(lab), block:cs(blk), rect:r?{x:r.x,y:r.y,w:r.width,h:r.height}:null, text:(t?t.textContent:'')};})()`;
(async () => {
  await new Promise((r) => srv.listen(8875, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-sm-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9363", "--user-data-dir=" + path.join(TMP, "p"), "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9363/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [name, b, r] of [["bodypage_rootpage", "page", "page"], ["bodywidget_rootpage", "widget", "page"], ["bodypage_rootwidget", "page", "widget"]]) {
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:8875/page?b=${b}&r=${r}` });
      await sleep(3200);
      await ev(cdp, `document.querySelector('.tab[data-view="api"]')?.click()`);
      await sleep(2000);
      const info = await ev(cdp, Q);
      console.log(name + ">>" + JSON.stringify(info));
      if (info && info.rect) {
        const clip = { x: Math.max(0, info.rect.x - 30), y: Math.max(0, info.rect.y - 40), width: 420, height: 150, scale: 2 };
        const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip });
        fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(shot.data, "base64"));
      }
    }
    ws.close();
  } catch (e) { console.error("ERR", (e && e.stack) || e); }
  finally { proc.kill(); srv.close(); await sleep(300); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
