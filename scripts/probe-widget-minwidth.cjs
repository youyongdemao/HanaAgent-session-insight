// probe-widget-minwidth.cjs —— 卡片最小宽度：三个容器宽度下卡片实际渲染宽度
// 用法: node scripts/probe-widget-minwidth.cjs
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, "..");
const OUT = path.join(REPO, "scripts", "_minwidth");
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const THEME = (() => { const p = "D:/AI/Hanako/artifacts/renderer/0.970.9/themes/warm-paper.css"; return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; })();
const HTML = `<!doctype html><html data-theme="warm-paper"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/assets/panel-v2.css"></head><body data-hana-theme="warm-paper" data-surface="widget"><div id="root" data-surface="widget"></div><script type="module" src="/assets/panel-v2.js"></script></body></html>`;
const series = Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8, input: 12000 + i * 800, output: 18000 + i * 1200, cacheInc: 30000 + i * 2000, cacheRead: 30000 + i * 2000, cacheMiss: 12000 + i * 800, reasoning: 0, hit: 62 + (i % 17) }));
const stats = { file: "a.jsonl", title: "动画数字字体大小不一致", model: "deepseek-v3.2", turns: 157, sessionTokens: 21781866, sessionCostCny: 12.51, contextPercent: 28, contextWindow: 128000, lastWindowTokens: 35840, remainingToCompact: 92160, compactThreshold: 0.8, sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0, avgHitPercent: 63.4, series, providers: [{ provider: "deepseek", tokens: 21781866, turns: 157, models: [{ model: "deepseek-v3.2", tokens: 21781866 }] }] };
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
    if (api === "stats") return json(stats);
    if (api === "balance") return json({ balances: [{ provider: "deepseek", name: "DeepSeek", status: "ok", kind: "balance", total: 112.99, currency: "CNY", windows: [{ remainingPercent: 61, resetAt: Date.now() + 3600e3, kind: "daily" }] }], unsupported: [] });
    if (api === "ledger-stats") return json({ days: {}, tokens: { hitRate: 0.634 }, models: {}, billingModes: {}, providerWindows: {} });
    if (api === "ui-env") return json({});
    if (api === "active") return json({ file: "a.jsonl" });
    if (api === "sessions") return json({ dir: "", sessions: [] });
    return json({ ok: true });
  }
  if (p === "/api/sessions/messages") return json({ messages: [] });
  return json({ ok: true });
});
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); } send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); } }
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.text }; return r.result?.value; }
const Q = `(()=>{const w=document.querySelector('.widget');const r=document.querySelector('.ring-state');const t=document.getElementById('wTokTotal');
 const rb=r?r.getBoundingClientRect():null;const tb=t?t.getBoundingClientRect():null;const cs=w?getComputedStyle(w):null;
 return {bodyClient:document.body.clientWidth, bodyScroll:document.body.scrollWidth, docScroll:document.documentElement.scrollWidth,
   widgetW:cs?+cs.width.replace('px',''):null, widgetX:w?+w.getBoundingClientRect().x.toFixed(1):null,
   ringCard:rb?{w:+rb.width.toFixed(1),h:+rb.height.toFixed(1)}:null, tok:{x:tb?+tb.x.toFixed(1):null,w:tb?+tb.width.toFixed(1):null},
   tokScroll:t?t.scrollWidth:null};})()`;
(async () => {
  await new Promise((r) => srv.listen(8878, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-mw-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9367", "--user-data-dir=" + path.join(TMP, "p"), "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9367/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    for (const W of [260, 320, 400, 560]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: 1200, deviceScaleFactor: 2, mobile: false });
      await cdp.send("Page.navigate", { url: "http://127.0.0.1:8878/page" });
      await sleep(2600);
      const info = await ev(cdp, Q);
      console.log("W=" + W + ">>" + JSON.stringify(info));
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      fs.writeFileSync(path.join(OUT, "w" + W + ".png"), Buffer.from(shot.data, "base64"));
      if (W === 260) {
        // 对照：把这条最小宽度临时摘掉，看卡片被压成什么样
        await ev(cdp, `(()=>{document.body.style.setProperty('min-width','0px','important');return 1;})()`);
        await sleep(400);
        const info2 = await ev(cdp, Q);
        console.log("W=260 no-min>>" + JSON.stringify(info2));
        const shot2 = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        fs.writeFileSync(path.join(OUT, "w260-nomin.png"), Buffer.from(shot2.data, "base64"));
      }
    }
    ws.close();
  } catch (e) { console.error("ERR", (e && e.stack) || e); }
  finally { proc.kill(); srv.close(); await sleep(300); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
