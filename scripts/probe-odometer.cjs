// probe-odometer.cjs —— 滚动数字的回归探针
// 用法: node scripts/probe-odometer.cjs
// ① .od 遮罩的不透明带必须完整包住字形墨迹（旧版 20%-80% 会切掉字底，滚动时看起来变细变淡）
// ② 滚动过程中的 translateY 必须落在整像素（亚像素位置会让字形发虚，和停下来时不一致）
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, "..");
const ID = "session-insight";
const THEME_CSS = (() => { try { const base = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "themes", "midnight.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {} return ""; })();
const HTML = `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="widget"><div id="root" data-surface="widget"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
const series = Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8, input: 12000 + i * 800, output: 18000 + i * 1200, cacheInc: 30000 + i * 2000, cacheRead: 30000 + i * 2000, cacheMiss: 12000 + i * 800, reasoning: 0, hit: 62 + (i % 17) }));
let tick = 0; // 每次请求让总量变一点，逼出滚动
const stats = () => { tick++; const t = 304537347 + tick * 77777; return { file: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", turns: 40, sessionTokens: t, sessionCostCny: 12.51, contextPercent: 99, contextWindow: 128000, lastWindowTokens: 126720, remainingToCompact: 1280, sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0, series, providers: [{ provider: "deepseek", tokens: t, turns: 40, models: [{ model: "deepseek-v3.2", tokens: t }] }] }; };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1"), p = u.pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  const json = (o) => send("application/json", JSON.stringify(o));
  if (p === "/theme.css") return send("text/css", THEME_CSS);
  if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
  const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); } res.writeHead(404); return res.end(""); }
  const api = p.startsWith("/api/apps/session-insight-v2/routes/api/") ? p.slice("/api/apps/session-insight-v2/routes/api/".length) : null;
  if (api !== null) {
    if (api === "stats") return json(stats());
    if (api === "hero-stats") return json({ ok: true, totalTok: 304537347 + tick * 77777, totalCost: 214.6, balance: 112.99 });
    if (api === "active") return json({ dir: "mock", file: "a.jsonl" });
    if (api === "resolve-entry") return json({ file: "a.jsonl" });
    if (api === "sessions") return json({ dir: "mock", sessions: [{ name: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 40 }] });
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
const MASKQ = `(()=>{const od=document.querySelector('.od');if(!od)return null;const cs=getComputedStyle(od);
  const el=od.parentElement;const fcs=getComputedStyle(el);const fs=parseFloat(fcs.fontSize);
  const cv=document.createElement('canvas');const ctx=cv.getContext('2d');ctx.font=fcs.fontWeight+' '+fcs.fontSize+' '+fcs.fontFamily;
  const mx=ctx.measureText('0123456789');const asc=mx.actualBoundingBoxAscent,desc=mx.actualBoundingBoxDescent;
  const fbAsc=(mx.fontBoundingBoxAscent!=null?mx.fontBoundingBoxAscent:asc),fbDesc=(mx.fontBoundingBoxDescent!=null?mx.fontBoundingBoxDescent:desc);
  const contentH=fbAsc+fbDesc,half=(fs-contentH)/2;const baseY=half+fbAsc;
  const inkTop=(baseY-asc)/fs,inkBot=(baseY+desc)/fs;
  return {mask:cs.webkitMaskImage||cs.maskImage,inline:(od.getAttribute('style')||'').match(/mask-image[^;]*/)?.[0]||null,band:(od.getAttribute('style')||'').match(/rgb\\(0, 0, 0\\) [\\d.]+%/g),fontSize:fs,inkTopPct:+(inkTop*100).toFixed(1),inkBotPct:+(inkBot*100).toFixed(1),inkFits:inkTop>=0.06&&inkBot<=0.94};})()`;
(async () => {
  await new Promise((r) => srv.listen(8873, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-od-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9359", "--user-data-dir=" + path.join(TMP, "p"), "--window-size=900,900", "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9359/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:8873/api/plugins/${ID}/page` });
    await sleep(2600);
    const mask = await ev(cdp, MASKQ);
    // 等一次真实滚动：轮询到新值就会滚，采样 strip 的 transform 看是否整像素
    let sampled = [], sawRoll = false, prev = null;
    for (let i = 0; i < 260; i++) {
      const cur = await ev(cdp, `(()=>[...document.querySelectorAll('.od-strip')].map(s=>s.style.transform).join('|'))()`);
      if (prev !== null && cur !== prev) { sawRoll = true; }
      if (sawRoll && cur) { sampled.push(cur); if (sampled.length >= 14) break; }
      prev = cur;
      await sleep(45);
    }
    const flat = sampled.flatMap((s) => s.split("|"));
    const pxVals = [...new Set(flat.filter((v) => v.includes("px")).map((v) => v))];
    const emVals = [...new Set(flat.filter((v) => v.includes("em")).map((v) => v))];
    const ints = pxVals.every((v) => Number.isInteger(Number(v.replace(/[^-\d.]/g, ""))));
    console.log(JSON.stringify({ sawRoll, pxMidRoll: pxVals.slice(0, 8), emMidRoll: emVals.slice(0, 4), allIntegerPx: ints, maskInline: mask && mask.inline, opaqueBand: mask && mask.band, fontSize: mask && mask.fontSize, inkTopPct: mask && mask.inkTopPct, inkBotPct: mask && mask.inkBotPct, inkInsideOpaqueBand: mask && mask.inkFits }, null, 1));
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(300); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
