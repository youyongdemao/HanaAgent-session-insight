// probe-roll-vs-settle.cjs —— 滚动中 vs 停稳后：到底哪些东西变了
// 用法: node scripts/probe-roll-vs-settle.cjs
// ① 打印 #tCost（API 页「总消耗」）在滚动中与停稳后的计算样式，以及它到 body 的整条祖先链
// ② 逐帧截图（滚动中 / 停稳后），落到 scripts/_roll-frames/
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "_roll-frames");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const THEME = (() => { const p = "D:/AI/Hanako/artifacts/renderer/0.970.9/themes/warm-paper.css"; return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; })();
const HTML = `<!doctype html><html data-theme="warm-paper"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/assets/panel-v2.css"><link rel="stylesheet" href="/assets/update-notice.css"></head><body data-hana-theme="warm-paper" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/assets/panel-v2.js"></script></body></html>`;

let tick = 0;
const ledger = { days: {}, tokens: { hitRate: 0.62, input: 1, output: 2 }, models: {}, billingModes: {}, providerWindows: {} };
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
    // 每次请求把总消耗推高一点，逼出滚动
    if (api === "total-cost") { tick++; return json({ totalCost: 200 + tick * 1.37 }); }
    if (api === "hero-stats") return json({ ok: true, tokens: 304537347 + tick * 77777, totalCost: 200 + tick * 1.37, calls: 120, errors: 0, hitRate: 0.62, firstDay: "2026-08-01" });
    if (api === "balance") return json({ balances: [], unsupported: [] });
    if (api === "ledger-stats") return json(ledger);
    if (api === "stats") return json({ file: null, turns: 0, series: [] });
    if (api === "total-tokens") return json({ tokens: 304537347, cost: 200 });
    if (api === "providers") return json({ providers: [] });
    if (api === "rules") return json({});
    if (api === "pricing") return json({ rows: [] });
    if (api === "ui-env") return json({});
    if (api === "sessions") return json({ dir: "", sessions: [] });
    if (api === "active") return json({ file: null });
    return json({ ok: true });
  }
  if (p === "/api/sessions/messages") return json({ messages: [] });
  if (p === "/api/ui-env") return json({});
  return json({ ok: true });
});
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.text }; return r.result?.value; }

const PROBE = `(()=>{
  const chain=[];let el=document.getElementById('tCost');
  const target=el;
  const snap=e=>{const cs=getComputedStyle(e);return {tag:e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+e.className.trim().split(/\\s+/).join('.'):''),
    opacity:cs.opacity,filter:cs.filter,transform:cs.transform,fontSize:cs.fontSize,color:cs.color,
    willChange:cs.willChange,mask:(cs.webkitMaskImage||cs.maskImage||'none').slice(0,80),
    textShadow:cs.textShadow,mixBlendMode:cs.mixBlendMode,isolation:cs.isolation,backdropFilter:cs.backdropFilter,
    fontWeight:cs.fontWeight,letterSpacing:cs.letterSpacing};};
  const start=target;
  let cur=start;
  while(cur&&cur!==document.documentElement){chain.push(snap(cur));cur=cur.parentElement;}
  const ods=[...target.querySelectorAll('.od')];
  const strips=[...target.querySelectorAll('.od-strip')].map(s=>s.style.transform);
  const r=target.getBoundingClientRect();
  const lab=document.querySelector('.ah-block:first-child .ah-label');
  const labr=lab?getComputedStyle(lab):null;
  const host=document.querySelector('.hero-pricing')||document.body;
  return {chain,odCount:ods.length,od0:ods[0]?snap(ods[0]):null,strips:strips.slice(0,3),
    rect:{x:r.x,y:r.y,w:r.width,h:r.height},
    label:labr?{color:labr.color,opacity:labr.opacity,fontSize:labr.fontSize}:null,
    htmlTheme:document.documentElement.getAttribute('data-theme'),
    bodyOpacity:getComputedStyle(document.body).opacity,
    hostFilter:getComputedStyle(host).filter};
})()`;

(async () => {
  await new Promise((r) => srv.listen(8874, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-rs-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9362", "--user-data-dir=" + path.join(TMP, "p"), "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9362/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:8874/page" });
    await sleep(3000);
    // 切到 API 管理页
    await ev(cdp, `document.querySelector('.tab[data-view="api"]')?.click()`);
    await sleep(2500);
    const has = await ev(cdp, `!!document.getElementById('tCost')`);
    if (!has) { console.log("NO #tCost", JSON.stringify(await ev(cdp, `({html:document.getElementById('root')?.innerHTML?.length||0})`))); }
    const shot = async (name, clip) => {
      const r = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 } });
      fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
    };
    const before = await ev(cdp, PROBE);
    const clip = { x: Math.max(0, before.rect.x - 24), y: Math.max(0, before.rect.y - 18), w: Math.min(760, before.rect.w + 60), h: 130 };
    await shot("settled-0", clip);
    console.log("SETTLED0>>" + JSON.stringify(before, null, 1));
    // 触发刷新 → 值变化 → 滚动
    await ev(cdp, `document.getElementById('refreshBtn')?.click()`);
    for (let i = 0; i < 12; i++) {
      const s = await ev(cdp, PROBE);
      const rolling = (s.strips || []).some((x) => x && /translateY\(-?\d*\.\d+em\)/.test(x));
      await shot("f" + String(i).padStart(2, "0") + (rolling ? "-roll" : "-post"), clip);
      if (rolling) console.log("ROLL" + i + ">>" + JSON.stringify({ od0: s.od0, chain0: s.chain[0], chain1: s.chain[1], strips: s.strips, rect: s.rect }, null, 1));
      await sleep(70);
    }
    await sleep(2500);
    const after = await ev(cdp, PROBE);
    await shot("settled-1", clip);
    console.log("SETTLED1>>" + JSON.stringify(after, null, 1));
    console.log("CLIP>>" + JSON.stringify(clip));
    ws.close();
  } catch (e) { console.error("ERR", (e && e.stack) || e); }
  finally { proc.kill(); srv.close(); await sleep(300); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
