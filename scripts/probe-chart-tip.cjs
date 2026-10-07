// scripts/probe-chart-tip.cjs
// 折线图悬停读数的真实渲染验证 + 预览图：本地起一个 mock 服务，用无头 Chrome 打开面板，
// 把鼠标移到折线图上，检查浮层是否出现、竖线是否画出、数值是否格式化正确，并截图。
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = "D:/AI/Hanako/OH-WorkSpace/HanaApp-Dev/session-insight/session-insight-v2";
const ID = "session-insight";
const THEME_CSS = (() => { try { const base = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "themes", "midnight.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {} return ""; })();
const HTML = `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
const series = Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8, input: 12000 + i * 800, output: 18000 + i * 1200, cacheInc: 30000 + i * 2000, cacheRead: 30000 + i * 2000, cacheMiss: 12000 + i * 800, reasoning: 0, hit: 62 + (i % 17) }));
const STATS = { file: "a.jsonl", title: "optimizer v2 优化", model: "deepseek-v3.2", turns: 40, sessionTokens: 345547912, sessionCostCny: 12.51, contextPercent: 98, contextWindow: 128000, lastWindowTokens: 126720, remainingToCompact: 1280, sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0, series, providers: [{ provider: "deepseek", tokens: 345547912, turns: 40, models: [{ model: "deepseek-v3.2", tokens: 345547912 }] }] };
const DAYS = Array.from({ length: 40 }, (_, i) => 2 + (i % 28));
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1"), p = u.pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  const json = (o) => send("application/json", JSON.stringify(o));
  if (p === "/theme.css") return send("text/css", THEME_CSS);
  if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
  const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); } res.writeHead(404); return res.end(""); }
  const api = p.startsWith("/api/apps/session-insight/routes/api/") ? p.slice("/api/apps/session-insight/routes/api/".length) : null;
  if (api !== null) {
    if (api === "stats") return json(STATS);
    if (api === "hero-stats") return json({ ok: true, totalTok: 345547912, totalCost: 12.51, balance: 108.63 });
    if (api === "active") return json({ dir: "mock", file: "a.jsonl" });
    if (api === "resolve-entry") return json({ file: "a.jsonl" });
    if (api === "ledger-stats") return json({ ok: true, totalCost: 12.51, calls: 1234, tokens: { hitRate: 0.71 }, days: { "2026-09-28": { tokens: 1234 } }, timeBuckets: { day: Array.from({ length: 256 }, (_, i) => (i % 7) * 0.02) }, tokenBuckets: { day: Array.from({ length: 256 }, (_, i) => (i % 9) * 1200) }, latency: { buckets: {} }, coverage: { firstDay: "2026-09-01" }, entries: [], providers: [] });
    if (api === "sessions") return json({ dir: "mock", sessions: [{ name: "a.jsonl", title: "optimizer v2 优化", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 40 }] });
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

const LIST = `(()=>[...document.querySelectorAll('svg[data-sitip]')].map(e=>{const r=e.getBoundingClientRect(),c=e.closest('[data-chart]');return {id:e.getAttribute('data-sitip'),chart:c?c.dataset.chart:null,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),host:(e.closest('.scl-wrap')?'scl-wrap':(e.closest('.chart-card')?'chart-card':'inline'))};}))()`;
const TIP = (id) => `(()=>{const svg=document.querySelector('svg[data-sitip="${id}"]'),e=document.querySelector('.si-charttip'),g=svg?svg.querySelector('.si-guide'):null;
 const r=e?e.getBoundingClientRect():null,sr=svg?svg.getBoundingClientRect():null,gl=g?g.querySelector('line'):null,gr=gl?gl.getBoundingClientRect():null;
 return {hidden:e?e.hidden:null,text:e?e.innerText.replace(/\\n/g,' | '):null,guide:!!g,dots:g?g.querySelectorAll('circle').length:0,
  box:r?{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}:null,
  svg:sr?{x:Math.round(sr.x),y:Math.round(sr.y),w:Math.round(sr.width),h:Math.round(sr.height)}:null,
  guideX:gr?Math.round(gr.x):null};})()`;

(async () => {
  await new Promise((r) => srv.listen(8879, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-tip-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9366", "--user-data-dir=" + path.join(TMP, "p"), "--window-size=1280,1200", "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9366/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:8879/api/plugins/${ID}/page` });
    await sleep(2600);
    await ev(cdp, `(()=>{const b=document.querySelector('[data-page="usage-session"]');if(b)b.click();return !!b;})()`);
    await sleep(1200);

    const charts = await ev(cdp, LIST);
    const live = (charts || []).filter((c) => c.w > 200);
    console.log("\n会话页四张折线图，逐个悬停看读数窗格：");
    for (const c of live) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x + Math.round(c.w * 0.62), y: c.y + Math.round(c.h * 0.55), button: "none", pointerType: "mouse" });
      await sleep(200);
      const t = await ev(cdp, TIP(c.id));
      console.log(`  ${c.chart || c.host}  ->  ${t && t.text}`);
      if (c.chart === "sessionStack" && t && t.box && t.svg) {
        const pad = 16;
        const x = Math.max(0, Math.min(t.svg.x, t.box.x) - pad), y = Math.max(0, Math.min(t.svg.y, t.box.y) - pad);
        const w = Math.min(1260, Math.max(t.svg.x + t.svg.w, t.box.x + t.box.w) - x + pad), h = Math.max(t.svg.y + t.svg.h, t.box.y + t.box.h) - y + pad;
        const shot3 = (await cdp.send("Page.captureScreenshot", { format: "png", clip: { x, y, width: w, height: h, scale: 2 } })).data;
        const out3 = path.join(REPO, "scripts", "probe-chart-tip-names.png");
        fs.writeFileSync(out3, Buffer.from(shot3, "base64"));
        console.log("  截图 -> " + out3);
      }
    }

    const target = live.sort((a, b) => b.w - a.w)[0];
    if (!target) throw new Error("no chart");
    const px = target.x + Math.round(target.w * 0.62), py = target.y + Math.round(target.h * 0.55);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", pointerType: "mouse" });
    await sleep(260);
    const tip = await ev(cdp, TIP(target.id));
    console.log("\n悬停后：");
    console.log(JSON.stringify(tip, null, 1));

    // 鼠标移开（移到页面左上角）后，竖线与窗格都必须收走
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none", pointerType: "mouse" });
    await sleep(200);
    const after = await ev(cdp, `(()=>{const e=document.querySelector('.si-charttip');return {tipHidden:e?e.hidden:null,guides:document.querySelectorAll('.si-guide').length};})()`);
    console.log("\n鼠标移开后：" + JSON.stringify(after));

    // 带日期/时间的折线图（用量页 · 费用面板切到折线）：标签应当是「日期 时间」
    await ev(cdp, `(()=>{const t=document.querySelector('.tab[data-view="usage"]');if(t)t.click();const b=document.querySelector('#costModeSeg [data-v="line"]');if(b)b.click();return true;})()`);
    await sleep(900);
    const cost = await ev(cdp, LIST);
    const c1 = (cost || []).find((x) => x.w > 200);
    if (c1) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c1.x + Math.round(c1.w * 0.45), y: c1.y + Math.round(c1.h * 0.55), button: "none", pointerType: "mouse" });
      await sleep(240);
      const ct = await ev(cdp, TIP(c1.id));
      console.log("\n费用面板（折线 · 近24h）读数：" + JSON.stringify({ text: ct && ct.text, guide: ct && ct.guide }));
      if (ct && ct.box && ct.svg) {
        const pad = 16;
        const x = Math.max(0, Math.min(ct.svg.x, ct.box.x) - pad), y = Math.max(0, Math.min(ct.svg.y, ct.box.y) - pad);
        const w = Math.min(1260, Math.max(ct.svg.x + ct.svg.w, ct.box.x + ct.box.w) - x + pad), h = Math.max(ct.svg.y + ct.svg.h, ct.box.y + ct.box.h) - y + pad;
        const shot2 = (await cdp.send("Page.captureScreenshot", { format: "png", clip: { x, y, width: w, height: h, scale: 2 } })).data;
        const out2 = path.join(REPO, "scripts", "probe-chart-tip-time.png");
        fs.writeFileSync(out2, Buffer.from(shot2, "base64"));
        console.log("截图 -> " + out2);
      }
    }

    // 截图：把图表与浮层一起框进去
    if (tip && tip.box && tip.svg) {
      const pad = 18;
      const x = Math.max(0, Math.min(tip.svg.x, tip.box.x) - pad);
      const y = Math.max(0, Math.min(tip.svg.y, tip.box.y) - pad);
      const w = Math.min(1260, Math.max(tip.svg.x + tip.svg.w, tip.box.x + tip.box.w) - x + pad);
      const h = Math.max(tip.svg.y + tip.svg.h, tip.box.y + tip.box.h) - y + pad;
      const shot = (await cdp.send("Page.captureScreenshot", { format: "png", clip: { x, y, width: w, height: h, scale: 2 } })).data;
      const out = path.join(REPO, "scripts", "probe-chart-tip-current.png");
      fs.writeFileSync(out, Buffer.from(shot, "base64"));
      console.log("\n截图 -> " + out + "  (" + Math.round(w) + "x" + Math.round(h) + ")");
    }
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(300); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
