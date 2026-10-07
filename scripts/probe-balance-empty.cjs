// probe-balance-empty.cjs —— 渲染「总余额」hero 的「无数据」态并截图
// 目的：确认无余额时那个位置显示的是什么（占位短横 vs 滚动残留）
// 用法：node scripts/probe-balance-empty.cjs [输出png路径]
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = "D:/AI/Hanako/OH-WorkSpace/HanaApp-Dev/session-insight/session-insight-v2";
const ID = "session-insight";
const OUT = process.argv[2] || path.join(REPO, "scripts", "probe-balance-empty.png");
const THEME = (() => {
  try {
    const base = "D:/AI/Hanako/artifacts/renderer";
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const p = path.join(base, d, "themes", "warm-paper.css");
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
  } catch {}
  return "";
})();
const HTML = `<!doctype html><html data-theme="warm-paper"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="warm-paper" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
const series = Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8, input: 12000 + i * 800, output: 18000 + i * 1200, cacheInc: 30000 + i * 2000, cacheRead: 30000 + i * 2000, cacheMiss: 12000 + i * 800, reasoning: 0, hit: 62 + (i % 17) }));
const STATS = { file: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", turns: 40, sessionTokens: 345547912, sessionCostCny: 12.51, contextPercent: 98, contextWindow: 128000, lastWindowTokens: 126720, remainingToCompact: 1280, sumInput: 9e5, sumOutput: 34e4, sumCacheRead: 7e5, sumReasoning: 0, series, providers: [{ provider: "deepseek", tokens: 345547912, turns: 40, models: [{ model: "deepseek-v3.2", tokens: 345547912 }] }] };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1"), p = u.pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  const json = (o) => send("application/json", JSON.stringify(o));
  if (p === "/theme.css") return send("text/css", THEME);
  if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
  const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); } res.writeHead(404); return res.end(""); }
  const api = p.startsWith("/api/apps/session-insight/routes/api/") ? p.slice("/api/apps/session-insight/routes/api/".length) : null;
  if (api !== null) {
    if (api === "stats") return json(STATS);
    // 关键：余额列表为空 —— 复现「没加载出来」的状态
    if (api === "balance") return json({ balances: [], updatedAt: Date.now() });
    if (api === "pricing") return json({});
    if (api === "ledger-stats") return json({ ok: true, totalCost: 94.25, entries: [], providers: [], days: { "2026-09-26": { tokens: 6430000000, cost: 94.25, calls: 2424, hitRate: 0.99 } } });
    if (api === "sessions") return json({ sessions: [{ name: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 40 }], count: 1 });
    if (api === "active") return json({ file: "a.jsonl" });
    if (api === "rules") return json({});
    if (api === "ui-env") return json({});
    if (api === "hero-stats") return json({ ok: true, totalTok: 345547912, totalCost: 12.51 });
    if (api === "total-cost") return json({ totalCost: 94.25 });
    if (api === "providers" || api === "local-providers") return json({ providers: [] });
    if (api === "events") return json({ events: [] });
    return json({ ok: true });
  }
  if (p === "/api/sessions/messages") return json({ messages: [] });
  return json({ ok: true });
});
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { __exception: r.exceptionDetails.text } : r.result?.value; }
const PROBE = `(()=>{const e=document.getElementById('tBal');if(!e)return {found:false};
  const hero=document.querySelector('.hero-pricing');
  const M=(el)=>{if(!el)return null;const cs=getComputedStyle(el);const r=el.getBoundingClientRect();
    return {text:JSON.stringify(el.textContent),cls:el.className,fs:cs.fontSize,fw:cs.fontWeight,ls:cs.letterSpacing,
      color:cs.color,filter:cs.filter,opacity:cs.opacity,font:cs.fontFamily.split(',')[0],
      w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top)};};
  return {found:true, bal:M(e), cost:M(document.getElementById('tCost')), token:M(document.getElementById('tCostSub')),
    diag:(document.getElementById('si-diag')||{}).textContent||null,
    hero:hero?{x:hero.getBoundingClientRect().x,y:hero.getBoundingClientRect().y,w:hero.getBoundingClientRect().width,h:hero.getBoundingClientRect().height}:null};})()`;
(async () => {
  await new Promise((r) => srv.listen(8879, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-bal-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9365", "--user-data-dir=" + path.join(TMP, "p"), "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9365/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:8879/api/plugins/${ID}/page` });
    await sleep(2600);
    await ev(cdp, `(()=>{const a=document.querySelector('.tab[data-view="api"]');if(a)a.click();return !!a;})()`);
    await sleep(700);
    await ev(cdp, `(()=>{const b=document.querySelector('[data-page="api-overview"]');if(b)b.click();return !!b;})()`);
    await sleep(2200);
    const info = await ev(cdp, PROBE);
    console.log("PROBE:", JSON.stringify(info));
    if (info && info.hero) {
      const pad = 10;
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, info.hero.x - pad), y: Math.max(0, info.hero.y - pad), width: info.hero.w + pad * 2, height: info.hero.h + pad * 2, scale: 2 } });
      fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
      console.log("SHOT:", OUT);
    }
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(300); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
