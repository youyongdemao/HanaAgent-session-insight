// _hero-probe.cjs 鈥斺€?浼氳瘽椤?hero 涓ゅ潡閲嶅彔鐨勭幇鍦哄嫎鏌?const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = "D:/AI/Hanako/OH-WorkSpace/session-insight/repo";
const ID = "session-insight";
const THEME_CSS = (() => { try { const base = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "themes", "midnight.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {} return ""; })();
const HTML = `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
const series = Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8, input: 12000 + i * 800, output: 18000 + i * 1200, cacheInc: 30000 + i * 2000, cacheRead: 30000 + i * 2000, cacheMiss: 12000 + i * 800, reasoning: 0, hit: 62 + (i % 17) }));
const STATS = { file: "a.jsonl", title: "浼氳瘽 A", model: "deepseek-v3.2", turns: 40, sessionTokens: 342545107, sessionCostCny: 12.51, contextPercent: 98, contextWindow: 128000, lastWindowTokens: 126720, remainingToCompact: 1280, sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0, series, providers: [{ provider: "deepseek", tokens: 342545107, turns: 40, models: [{ model: "deepseek-v3.2", tokens: 342545107 }] }] };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1"), p = u.pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  const json = (o) => send("application/json", JSON.stringify(o));
  if (p === "/theme.css") return send("text/css", THEME_CSS);
  if (p === `/api/plugins/${ID}/page` || p === `/api/plugins/${ID}/panel.html`) return send("text/html; charset=utf-8", HTML);
  const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); } res.writeHead(404); return res.end(""); }
  const api = p.startsWith("/api/apps/session-insight-v2/routes/api/") ? p.slice("/api/apps/session-insight-v2/routes/api/".length) : null;
  if (api !== null) {
    if (api === "stats") return json(STATS);
    if (api === "hero-stats") return json({ ok: true, totalTok: 342545107, totalCost: 214.6, balance: 112.99 });
    if (api === "active") return json({ dir: "mock", file: "a.jsonl" });
    if (api === "resolve-entry") return json({ file: "a.jsonl" });
    if (api === "ledger-stats") return json({ ok: true, totalCost: 214.6, entries: [], providers: [] });
    if (api === "sessions") return json({ dir: "mock", sessions: [{ name: "a.jsonl", title: "浼氳瘽 A", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 40 }] });
    if (api === "dist") return json({ ok: true, items: [] });
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
const Q = `(()=>{const R=e=>{if(!e)return null;const r=e.getBoundingClientRect();const cs=getComputedStyle(e);return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),fs:cs.fontSize,disp:cs.display,pos:cs.position,tf:cs.transform};};
 const main=document.querySelector('#usage-session .uh-main');
 const tok=document.querySelector('#usage-session .uh-tok'),side=document.querySelector('#usage-session .uh-side'),div=document.querySelector('#usage-session .uh-divider');
 const sTok=document.querySelector('#sTok'),sHit=document.querySelector('#sHit');
 const l1=document.querySelector('#usage-session .uh-tok .uh-label'),l2=document.querySelector('#usage-session .uh-hit .uh-label');
 return {pageShown:!!(document.querySelector('#usage-session')&&document.querySelector('#usage-session').classList.contains('active')),
  mainClass:main?main.className:null, mainStyle:main?getComputedStyle(main).display+' / gap '+getComputedStyle(main).gap:null,
  tok:R(tok),div:R(div),side:R(side),sTok:R(sTok),sHit:R(sHit),lab1:R(l1),lab2:R(l2),
  sTokDigits:sTok?sTok.style.getPropertyValue('--digits'):null,
  tokContainer:tok?getComputedStyle(tok).containerType:null,
  sideGrid:side?getComputedStyle(side).display+' / cols '+getComputedStyle(side).gridTemplateColumns:null};})()`;
(async () => {
  await new Promise((r) => srv.listen(8875, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-hero-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9361", "--user-data-dir=" + path.join(TMP, "p"), "--window-size=1200,1000", "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9361/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:8875/api/plugins/${ID}/page` });
    await sleep(2600);
    // 鍒囧埌銆屼細璇濄€嶉〉
    await ev(cdp, `(()=>{const b=document.querySelector('[data-page="usage-session"]');if(b)b.click();return !!b;})()`);
    await sleep(1200);
    const out = await ev(cdp, Q);
    console.log(JSON.stringify(out, null, 1));
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(300); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
