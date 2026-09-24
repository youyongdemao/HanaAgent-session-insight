// probe-hero-glow.cjs —— hero 数字的外观不能被光晕元素插队影响（回归探针）
// 用法: node scripts/probe-hero-glow.cjs
// 背景：updateGlow() 会 card.prepend(.si-glow-spot/.si-border-glow)。
// 只要 hero 的样式还挂在 :first-child / :last-child 上，插入后字号/字重/透明度就会变。
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, "..");
const THEME = (() => { const p = "D:/AI/Hanako/artifacts/renderer/0.970.9/themes/warm-paper.css"; return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; })();
const HTML = `<!doctype html><html data-theme="warm-paper"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/assets/panel-v2.css"><link rel="stylesheet" href="/assets/update-notice.css"></head><body data-hana-theme="warm-paper" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/assets/panel-v2.js"></script></body></html>`;
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://127.0.0.1").pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  const json = (o) => send("application/json", JSON.stringify(o));
  if (p === "/page") return send("text/html; charset=utf-8", HTML);
  if (p === "/theme.css") return send("text/css", THEME);
  const m = p.match(/^\/assets\/(.+)$/);
  if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); } res.writeHead(404); return res.end(""); }
  const PREFIX = "/api/apps/session-insight-v2/routes/api/";
  if (p.startsWith(PREFIX)) {
    const api = p.slice(PREFIX.length);
    if (api === "total-cost") return json({ totalCost: 209.31 });
    if (api === "hero-stats") return json({ ok: true, tokens: 5630000000, totalCost: 209.31, calls: 120, errors: 0, hitRate: 0.62, firstDay: "2026-08-01" });
    if (api === "balance") return json({ balances: [], unsupported: [] });
    if (api === "ledger-stats") return json({ days: {}, tokens: { hitRate: 0.62 }, models: {}, billingModes: {}, providerWindows: {} });
    if (api === "stats") return json({ file: null, turns: 0, series: [] });
    if (api === "providers") return json({ providers: [] });
    if (api === "rules") return json({});
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
const Q = `(()=>{const S=id=>{const e=document.getElementById(id);if(!e)return null;const cs=getComputedStyle(e);const blk=e.closest('.ah-block');return {fs:cs.fontSize,w:cs.fontWeight,color:cs.color,op:cs.opacity,blockOp:blk?getComputedStyle(blk).opacity:null,blockClass:blk?blk.className:null,text:e.textContent};};
 const hero=document.querySelector('.api-hero');return {cost:S('tCost'),bal:S('tBal'),heroKids:hero?[...hero.children].map(c=>c.className||c.tagName):null};})()`;
(async () => {
  await new Promise((r) => srv.listen(8877, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-gh-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9366", "--user-data-dir=" + path.join(TMP, "p"), "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9366/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:8877/page" });
    await sleep(3000);
    await ev(cdp, `document.querySelector('.tab[data-view="api"]')?.click()`);
    await sleep(2200);
    const before = await ev(cdp, Q);
    const clip = await ev(cdp, `(()=>{const r=document.getElementById('tCost').getBoundingClientRect();return {x:Math.max(0,r.x-40),y:Math.max(0,r.y-45),width:r.width+120,height:150,scale:2};})()`);
    const shot0 = await cdp.send("Page.captureScreenshot", { format: "png", clip });
    fs.writeFileSync(path.join(REPO, "scripts", "_hero-before.png"), Buffer.from(shot0.data, "base64"));
    // 复刻光晕系统：往 .api-hero 里 prepend 两个元素
    await ev(cdp, `(()=>{const hero=document.querySelector('.api-hero');const a=document.createElement('div');a.className='si-glow-spot';const b=document.createElement('div');b.className='si-border-glow';hero.prepend(b);hero.prepend(a);return 1;})()`);
    await sleep(600);
    const after = await ev(cdp, Q);
    const shot1 = await cdp.send("Page.captureScreenshot", { format: "png", clip });
    fs.writeFileSync(path.join(REPO, "scripts", "_hero-after.png"), Buffer.from(shot1.data, "base64"));
    const same = JSON.stringify(before.cost) === JSON.stringify(after.cost) && JSON.stringify(before.bal) === JSON.stringify(after.bal);
    console.log(JSON.stringify({ sameAfterGlowPrepend: same, beforeCost: before.cost, afterCost: after.cost, heroKids: after.heroKids }, null, 1));
    ws.close();
  } catch (e) { console.error("ERR", (e && e.stack) || e); }
  finally { proc.kill(); srv.close(); await sleep(300); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
