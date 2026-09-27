// probe-perf-frame.cjs —— 抓「卡」的真凭据：逐帧间隔分布 + 主线程/光栅耗时分布
// 三个场景：静止 / 连续切范围 / 鼠标在页面上移动（触发光晕）
// 可加 --no-glass 把 backdrop-filter 全部关掉做对照，判断毛玻璃是不是主因
// 用法: node scripts/probe-perf-frame.cjs [--tag 名字] [--no-glass] [--js <panel-v2.js>]
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const SELF = __dirname;
const REPO = path.resolve(SELF, "..");
const ID = "session-insight";
const APP = "session-insight-v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const HAS = (k) => process.argv.includes(k);
const JS_FILE = argOf("--js", path.join(REPO, "ui", "assets", "panel-v2.js"));
const TAG = argOf("--tag", "current");
const PORT = Number(argOf("--port", "8911"));
const CDP_PORT = Number(argOf("--cdp", "9457"));
const NO_GLASS = HAS("--no-glass");
const CSS_FILE = argOf("--css", path.join(REPO, "ui", "assets", "panel-v2.css"));
const INJECT_NAME = argOf("--inject", "");
// 注入式对照实验：不动源码，只在页面运行时覆盖
// 注意：绝不能用 * 通配符改 backdrop-filter，那会把每个元素都变成毛玻璃（曾把帧率砸到 4fps）
const RADIAL = 'radial-gradient(closest-side circle,color-mix(in srgb,var(--accent) 32%,transparent) 0%,color-mix(in srgb,var(--accent) 18%,transparent) 36%,color-mix(in srgb,var(--accent) 8%,transparent) 64%,transparent 90%)';
const SET_RADIUS = (val) => `(()=>{let n=0;document.querySelectorAll('*').forEach(el=>{const cs=getComputedStyle(el);if(cs.backdropFilter&&cs.backdropFilter!=='none'){el.style.setProperty('backdrop-filter','${val}','important');el.style.setProperty('-webkit-backdrop-filter','${val}','important');n++;}});return n;})()`;
const GLOW_T_OFF = "(()=>{const s=document.createElement('style');s.textContent='.glow-text{filter:none!important}';document.head.appendChild(s);return true;})()";
// 光斑从“改渐变位置”改成“固定渐变 + transform 平移”（只动合成属性，不触发重绘）
const GLOW_TRANSFORM = `(()=>{
  const s=document.createElement('style');s.textContent='.glow-text{filter:none!important}';document.head.appendChild(s);
  window.addEventListener('mousemove',e=>{
    const t=e.target;if(!t||!t.closest)return;
    const card=t.closest('.card,.panel,.chart-card,.api-hero,.mini-card,.provider-item');
    if(!card)return;
    const spot=card.querySelector('.si-glow-spot');if(!spot)return;
    spot.style.position='absolute';spot.style.inset='auto';spot.style.left='50%';spot.style.top='50%';
    spot.style.width='680px';spot.style.height='680px';spot.style.marginLeft='-340px';spot.style.marginTop='-340px';
    spot.style.background='${RADIAL}';spot.style.willChange='transform';
    spot.style.opacity='1';
    const r=card.getBoundingClientRect();
    spot.style.transform='translate('+((e.clientX-r.left-r.width/2).toFixed(1))+'px,'+((e.clientY-r.top-r.height/2).toFixed(1))+'px)';
    const bord=card.querySelector('.si-border-glow');if(bord)bord.style.opacity='0';
  },true);
  return true;})()`;
const PRESETS = {
  noglow: "(()=>{const s=document.createElement('style');s.textContent='.si-glow-spot,.si-border-glow{display:none!important}';document.head.appendChild(s);return true;})()",
  blur6: SET_RADIUS("blur(6px)"),
  blur10: SET_RADIUS("blur(10px)"),
  nosaturate: SET_RADIUS("blur(18px)"),
  glowt: GLOW_T_OFF,
  glowopt: GLOW_TRANSFORM,
  nomouse: "(()=>{window.addEventListener('mousemove',e=>{e.stopImmediatePropagation();},true);return true;})()"
};

const N = 256;
const series = (base, mul, wave) => Array.from({ length: N }, (_, i) => base + mul * Math.abs(Math.sin(i / wave)));
const TOK = { hour: series(2e5, 4e6, 7), d7: series(1e6, 2.6e7, 9), d30: series(3e6, 7e7, 11), day: series(2e6, 5e7, 13) };
const RATE = { hour: series(58, 34, 3), d7: series(62, 30, 5), d30: series(65, 28, 8), day: series(70, 22, 6) };
const COST = { hour: series(0.5, 9, 7), d7: series(3, 60, 9), d30: series(8, 160, 11), day: series(6, 130, 13) };
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
// 真实规模：模型 30 个、供应商 6 个、子系统 8 个、账本天数 45 天
const MODELS = {}, PROVS = {}, RANGEP = { hour: {}, d7: {}, d30: {} }, RANGEM = { hour: {}, d7: {}, d30: {} };
const PN = ["deepseek", "xiaomi", "zhipu", "moonshot", "openai", "anthropic"];
PN.forEach((p, i) => { PROVS[p] = { tokens: (6 - i) * 4e8, calls: 9000 - i * 900, cost: (6 - i) * 12.5, hitRate: 0.9 - i * 0.03 }; });
for (let i = 0; i < 30; i++) { const p = PN[i % PN.length]; MODELS["model-" + String(i + 1).padStart(2, "0")] = { tokens: (30 - i) * 8e7, calls: 4000 - i * 90, cost: (30 - i) * 3.3, hitRate: 0.95 - (i % 9) * 0.02, provider: p }; }
for (const u of ["hour", "d7", "d30"]) { const lim = u === "hour" ? 6 : 30; PN.slice(0, lim).forEach((p, i) => { RANGEP[u][p] = { tokens: (lim - i) * 2e8 }; }); Object.keys(MODELS).slice(0, lim * 3).forEach((m, i) => { RANGEM[u][m] = { tokens: (lim * 3 - i) * 4e7, provider: PN[i % lim] }; }); }
const DAYS = {}; for (let i = 44; i >= 0; i--) { const d = new Date(Date.now() - i * 86400e3); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; DAYS[k] = { tokens: 1e8 + i * 3e7, cost: 8 + i * 2.2, hitRate: 0.9, calls: 1200 + i * 30, err: i % 13 === 0 ? 2 : 0 }; }
const LEDGER = {
  days: DAYS, calls: 39408, errors: 39,
  tokens: { input: 5.1e9, output: 9.1e7, cacheHit: 4.9e9, cacheMiss: 1.1e8, hitRate: 0.982 },
  coverage: { firstDay: Object.keys(DAYS)[0] },
  latency: { buckets: { lt1: 10, "1_3": 20, "3_10": 5, gt10: 1 } },
  models: MODELS, providers: PROVS,
  subsystems: { session: { tokens: 2.2e9 }, utility: { tokens: 0.9e9 }, memory: { tokens: 0.4e9 }, vision: { tokens: 0.2e9 }, automation: { tokens: 1.1e8 }, compaction: { tokens: 6e7 }, subagent: { tokens: 3e7 }, other: { tokens: 1e7 } },
  tokenBuckets: TOK, cacheRateBuckets: RATE, timeBuckets: COST,
  rangeProviders: RANGEP, rangeModels: RANGEM,
};
const HERO = { at: Date.now(), tokens: 2.6e9, firstDay: Object.keys(DAYS)[0], calls: 39408, errors: 39, hitRate: 0.982, totalCost: 16.62 };
const STATS = {
  file: "mock.jsonl", title: "探针会话", model: "deepseek-v3.2", turns: 200,
  sessionTokens: 1240000, sessionCostCny: 12.34, contextPercent: 42.5, contextWindow: 128000,
  sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0,
  series: Array.from({ length: 200 }, (_, i) => ({ turn: i + 1, i: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8, input: 12000, output: 18000, cacheInc: 30000, cacheRead: 30000, cacheMiss: 12000, reasoning: 0, hit: 62 + (i % 17), latencyMs: 1100 })),
  providers: [{ provider: "deepseek", tokens: 1240000, turns: 200, models: [{ model: "deepseek-v3.2", tokens: 1240000 }] }],
};
const THEME_CSS = (() => {
  try { const base = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "themes", "midnight.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {}
  return "";
})();
const HTML = `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

function startServer(port, assets) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === "/theme.css") return send("text/css", THEME_CSS);
    if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
    const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
    if (m) {
      const file = assets[m[1]] || path.join(REPO, "ui", "assets", m[1]);
      if (fs.existsSync(file)) { const ext = path.extname(file).toLowerCase(); return send(ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "application/octet-stream", fs.readFileSync(file)); }
      res.writeHead(404); return res.end("nf");
    }
    const PREFIXES = [`/api/apps/${APP}/routes/api/`, `/api/plugins/${ID}/api/`];
    let api = null; for (const pre of PREFIXES) if (p.startsWith(pre)) api = p.slice(pre.length);
    if (api !== null) {
      if (api === "stats") return json(STATS);
      if (api === "ledger-stats") return json(LEDGER);
      if (api === "hero-stats") return json(HERO);
      if (api === "total-cost") return json({ totalCost: 16.62, todayModel: {} });
      if (api === "active") return json({ dir: "mock", file: "mock.jsonl" });
      if (api === "sessions") return json({ dir: "mock", sessions: [{ name: "mock.jsonl", title: "探针会话", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 200 }] });
      if (api === "events") return json({ events: [] });
      if (api === "balance") return json({ balances: [], updatedAt: Date.now() });
      if (api === "pricing") return json({ rows: [], updatedAt: Date.now() });
      if (api === "providers" || api === "local-providers") return json({ providers: [] });
      if (api === "build-stamp") return json({ stamp: "probe-frame" });
      return json({ ok: true });
    }
    return json({ ok: true });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
async function waitChrome(port, tries = 80) { for (let i = 0; i < tries; i++) { try { return await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.subs = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; } if (m.method && this.subs.has(m.method)) for (const cb of this.subs.get(m.method)) cb(m.params); }); }
  on(method, cb) { if (!this.subs.has(method)) this.subs.set(method, []); this.subs.get(method).push(cb); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.text }; return r.result?.value; }

const FRAME_WATCH = (ms) => `(async()=>{
  const t=[];let stop=false;const t0=performance.now();
  const loop=(ts)=>{t.push(ts);if(!stop)requestAnimationFrame(loop);};requestAnimationFrame(loop);
  await new Promise(r=>setTimeout(r,${ms}));
  stop=true;
  const gaps=[];for(let i=1;i<t.length;i++)gaps.push(+(t[i]-t[i-1]).toFixed(2));
  const sorted=gaps.slice().sort((a,b)=>a-b);const q=p=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]:0;
  return {frames:t.length,ms:Math.round(performance.now()-t0),avg:+(gaps.reduce((a,b)=>a+b,0)/(gaps.length||1)).toFixed(2),p50:q(.5),p95:q(.95),max:Math.max(0,...gaps),over16:gaps.filter(g=>g>16.7).length,over33:gaps.filter(g=>g>33).length,over50:gaps.filter(g=>g>50).length};
})()`;

const CLICKER = (n) => `(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const units=document.querySelectorAll('#tokUnitSeg button');
  for(let i=0;i<${n};i++){const b=units[i%units.length];if(b)b.click();await sleep(320);}
  return true;})()`;

const ELEM_RECT = `(()=>{const e=document.querySelector('#tokUnitSeg');if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};})()`;

async function frameWatch(cdp, ms, action) {
  const p = ev(cdp, FRAME_WATCH(ms));
  await sleep(250);
  if (action) await action();
  return await p;
}
async function trace(cdp, ms, action) {
  const events = [];
  const off = (params) => { if (params?.value) for (const e of params.value) events.push(e); };
  cdp.on("Tracing.dataCollected", off);
  await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame", transferMode: "ReportEvents" });
  if (action) await action();
  await sleep(ms);
  const done = new Promise((r) => cdp.on("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  await Promise.race([done, sleep(6000)]);
  const agg = {};
  let totalUs = 0;
  for (const e of events) {
    const ph = e.ph, name = e.name; if (!name) continue;
    if (ph === "X" && typeof e.dur === "number") { const key = name; const g = agg[key] || (agg[key] = { n: 0, ms: 0, maxMs: 0 }); g.n++; g.ms += e.dur / 1000; g.maxMs = Math.max(g.maxMs, e.dur / 1000); totalUs += e.dur; }
  }
  const top = Object.entries(agg).map(([k, v]) => ({ name: k, n: v.n, ms: +v.ms.toFixed(1), maxMs: +v.maxMs.toFixed(1) }))
    .filter((x) => x.ms > 0.5).sort((a, b) => b.ms - a.ms).slice(0, 22);
  const interesting = ["Paint", "RasterTask", "CompositeLayers", "UpdateLayerTree", "UpdateLayoutTree", "Layout", "Rasterize", "PaintImage", "ParseHTML", "FunctionCall"];
  return { totalMs: +(totalUs / 1000).toFixed(1), top, focus: top.filter((t) => interesting.some((k) => t.name.includes(k))) };
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-fr-"));
  const srv = await startServer(PORT, { "panel-v2.css": CSS_FILE });
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (!fs.existsSync(chromePath)) throw new Error("找不到 Chrome");
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    `--remote-debugging-port=${CDP_PORT}`, "--user-data-dir=" + path.join(TMP, "p"), "about:blank"], { stdio: "ignore" });
  try {
    await waitChrome(CDP_PORT);
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null); target = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (!target) await sleep(250); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1334, height: 1044, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/plugins/${ID}/page` });
    await sleep(4000);
    if (NO_GLASS) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';document.head.appendChild(s);});" });
      await ev(cdp, `(()=>{const s=document.createElement('style');s.textContent='*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';document.head.appendChild(s);return true;})()`);
      await sleep(600);
    }
    const rect = await ev(cdp, ELEM_RECT);
    if (INJECT_NAME && PRESETS[INJECT_NAME]) { await ev(cdp, PRESETS[INJECT_NAME]); await sleep(500); }
    const out = { tag: TAG, noGlass: NO_GLASS, css: path.basename(CSS_FILE), inject: INJECT_NAME || null, rect, dom: await ev(cdp, `(()=>({all:document.querySelectorAll('*').length,ods:document.querySelectorAll('.od').length,glass:document.querySelectorAll('.glass').length}))()`) };

    out.idle = await frameWatch(cdp, 3000, null);
    out.switching = await frameWatch(cdp, 4000, async () => { await ev(cdp, CLICKER(12)); });
    out.mousemove = await frameWatch(cdp, 3000, async () => {
      if (!rect) return;
      for (let i = 0; i < 90; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + (i % rect.w), y: rect.y + rect.h / 2, button: "none" }); await sleep(30); }
    });
    out.traceSwitch = await trace(cdp, 1500, async () => { await ev(cdp, CLICKER(6)); });
    out.traceIdle = await trace(cdp, 2500, null);
    out.domAfter = await ev(cdp, `(()=>({all:document.querySelectorAll('*').length,ods:document.querySelectorAll('.od').length,glass:document.querySelectorAll('.glass').length}))()`);
    console.log(JSON.stringify(out, null, 2));
    ws.close();
  } finally {
    proc.kill(); srv.close(); await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
