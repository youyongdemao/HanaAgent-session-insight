// probe-perf-switch.cjs —— 度量「切图表范围/模式」时的渲染开销（长任务、布局、样式、脚本、帧率）
// 背景：内测反馈「会话消费工作台动画卡、帧率低」。此探针把主观感受变成数字：
//   ① 每次点击后主线程多干了多少活（TaskDuration / Layout / RecalcStyle / Script）
//   ② 触发了多少次布局与样式重算（LayoutCount / RecalcStyleCount）
//   ③ 有没有长任务（>50ms），最长多少
//   ④ 点击后 1.2 秒内的实际帧率
//   ⑤ 页面 DOM 规模（元素总数、滚动数字 .od 数量）
// 用法：node scripts/probe-perf-switch.cjs [--js <panel-v2.js 路径>] [--tag 名字]
//   默认测仓库工作区的 ui/assets/panel-v2.js；用 --js 指向另一份副本即可做改前/改后对比。
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const SELF = __dirname;
const REPO = path.resolve(SELF, "..");
const ID = "session-insight";
const APP = "session-insight";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const JS_FILE = argOf("--js", path.join(REPO, "ui", "assets", "panel-v2.js"));
const TAG = argOf("--tag", "current");
const PORT = Number(argOf("--port", "8901"));
const CDP_PORT = Number(argOf("--cdp", "9447"));

// ── mock 账本：256 点序列（切范围时前端的重活都在这里）──
const N = 256;
const series = (base, mul, wave) => Array.from({ length: N }, (_, i) => base + mul * Math.abs(Math.sin(i / wave)));
const TOK = { hour: series(2e5, 4e6, 7), d7: series(1e6, 2.6e7, 9), d30: series(3e6, 7e7, 11), day: series(2e6, 5e7, 13) };
const RATE = { hour: series(58, 34, 3), d7: series(62, 30, 5), d30: series(65, 28, 8), day: series(70, 22, 6) };
const COST = { hour: series(0.5, 9, 7), d7: series(3, 60, 9), d30: series(8, 160, 11), day: series(6, 130, 13) };
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const LEDGER = {
  days: { [today]: { tokens: 3.51e8, cost: 16.05, hitRate: 0.99, calls: 2424, err: 1 }, "2026-09-10": { tokens: 2.6e9, cost: 146.4 }, "2026-09-20": { tokens: 1.9e9, cost: 101.2 } },
  calls: 39408, errors: 39,
  tokens: { input: 5.1e9, output: 9.1e7, cacheHit: 4.9e9, cacheMiss: 1.1e8, hitRate: 0.982 },
  coverage: { firstDay: "2026-08-29" },
  latency: { buckets: { lt1: 10, "1_3": 20, "3_10": 5, gt10: 1 } },
  models: { "deepseek-v3.2": { tokens: 2.4e9, calls: 12100, cost: 61.2, hitRate: 0.94, provider: "deepseek" }, "mimo-v2.5": { tokens: 1.1e9, calls: 8200, cost: 33.8, hitRate: 0.9, provider: "xiaomi" } },
  providers: { deepseek: { tokens: 2.4e9, calls: 12100, cost: 61.2, hitRate: 0.94 }, xiaomi: { tokens: 1.1e9, calls: 8200, cost: 33.8, hitRate: 0.9 } },
  subsystems: { session: { tokens: 2.2e9 }, utility: { tokens: 0.9e9 }, memory: { tokens: 0.4e9 }, vision: { tokens: 0.2e9 } },
  tokenBuckets: TOK, cacheRateBuckets: RATE, timeBuckets: COST,
  rangeProviders: { hour: { deepseek: { tokens: 1.2e8 } }, d7: { deepseek: { tokens: 8e8 } }, d30: { deepseek: { tokens: 3e9 } } },
  rangeModels: { hour: { "deepseek-v3.2": { tokens: 1.2e8, provider: "deepseek" } }, d7: {}, d30: {} },
};
const HERO = { at: Date.now(), tokens: 2.6e9, firstDay: "2026-08-29", calls: 39408, errors: 39, hitRate: 0.982, totalCost: 16.62 };
const STATS = {
  file: "mock.jsonl", title: "探针会话", model: "deepseek-v3.2", turns: 40,
  sessionTokens: 1240000, sessionCostCny: 12.34, contextPercent: 42.5, contextWindow: 128000,
  sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0,
  series: Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, i: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8, input: 12000, output: 18000, cacheInc: 30000, cacheRead: 30000, cacheMiss: 12000, reasoning: 0, hit: 62 + (i % 17), latencyMs: 1100 })),
  providers: [{ provider: "deepseek", tokens: 1240000, turns: 40, models: [{ model: "deepseek-v3.2", tokens: 1240000 }] }],
};

const THEME_CSS = (() => {
  try {
    const base = "D:/AI/Hanako/artifacts/renderer";
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const p = path.join(base, d, "themes", "midnight.css");
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
  } catch {}
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
      const name = m[1];
      const file = assets[name] || path.join(REPO, "ui", "assets", name);
      if (fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase();
        const t = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "application/octet-stream";
        return send(t, fs.readFileSync(file));
      }
      res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found");
    }
    const PREFIXES = [`/api/apps/${APP}/routes/api/`, `/api/plugins/${ID}/api/`];
    let api = null;
    for (const pre of PREFIXES) if (p.startsWith(pre)) api = p.slice(pre.length);
    if (api !== null) {
      if (api === "stats") return json(STATS);
      if (api === "ledger-stats") return json(LEDGER);
      if (api === "hero-stats") return json(HERO);
      if (api === "total-cost") return json({ totalCost: 16.62, todayModel: {} });
      if (api === "diag-report") return json({ ok: true });
      if (api === "active") return json({ dir: "mock", file: "mock.jsonl" });
      if (api === "sessions") return json({ dir: "mock", sessions: [{ name: "mock.jsonl", title: "探针会话", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 40 }] });
      if (api === "events") return json({ events: [] });
      if (api === "balance") return json({ balances: [], updatedAt: Date.now() });
      if (api === "pricing") return json({ rows: [], updatedAt: Date.now() });
      if (api === "providers" || api === "local-providers") return json({ providers: [] });
      if (api === "rules") return json({});
      if (api === "ui-env") return json({});
      if (api === "update-check") return json({});
      if (api === "build-stamp") return json({ stamp: "probe-perf" });
      return json({ ok: true });
    }
    return json({ ok: true });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
async function waitChrome(port, tries = 80) { for (let i = 0; i < tries; i++) { try { return await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.text };
  return r.result?.value;
}
async function metrics(cdp) { const r = await cdp.send("Performance.getMetrics"); const o = {}; for (const m of r.metrics) o[m.name] = m.value; return o; }
const dMs = (a, b, k) => +(((b[k] || 0) - (a[k] || 0)) * 1000).toFixed(1);
const dN = (a, b, k) => +((b[k] || 0) - (a[k] || 0)).toFixed(0);

const DOMSTAT = `(()=>{
  const all=document.querySelectorAll('*').length;
  const ods=document.querySelectorAll('.od').length;
  const odStrips=document.querySelectorAll('.od-strip').length;
  const glass=document.querySelectorAll('.glass').length;
  const svgs=document.querySelectorAll('svg').length;
  const paths=document.querySelectorAll('path').length;
  const nodes=document.querySelectorAll('.si-line,.si-area,.heat i,.cost-heat i').length;
  return {all,ods,odStrips,glass,svgs,paths,chartNodes:nodes};
})()`;

// 单次切换：点击 → 观察 1.2s 内的帧率、长任务、主线程计量增量
const SWITCH = (segId, unit) => `(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const seg=document.getElementById('${segId}');
  const btn=seg&&seg.querySelector('button[data-v="${unit}"]');
  if(!btn)return{err:'button not found: ${segId} ${unit}'};
  window.__lt=[];window.__ltMax=0;
  if(!window.__po){window.__po=new PerformanceObserver(l=>{for(const e of l.getEntries()){window.__lt.push(Math.round(e.duration));}});try{window.__po.observe({entryTypes:['longtask']});}catch{}}
  await sleep(400);
  window.__lt.length=0;
  let frames=0,stop=false;const t0=performance.now();
  const loop=()=>{frames++;if(!stop)requestAnimationFrame(loop);};requestAnimationFrame(loop);
  const tClick=performance.now();
  btn.click();
  const syncMs=performance.now()-tClick;           // 点击处理函数同步耗时（重渲染都在这段里）
  await sleep(1200);
  stop=true;
  const ms=performance.now()-t0;
  return {syncMs:+syncMs.toFixed(1),frames,fps:+(frames/(ms/1000)).toFixed(1),longtasks:window.__lt.slice(),maxLt:window.__lt.length?Math.max(...window.__lt):0};
})()`;

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-perf-"));
  const srv = await startServer(PORT, {});
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (!fs.existsSync(chromePath)) throw new Error("找不到 Chrome: " + chromePath);
  const udd = path.join(TMP, "chrome-profile");
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    `--remote-debugging-port=${CDP_PORT}`, "--user-data-dir=" + udd, "about:blank"], { stdio: "ignore" });
  try {
    await waitChrome(CDP_PORT);
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null);
      target = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (!target) await sleep(250);
    }
    if (!target) throw new Error("找不到 page target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Performance.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 1400, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/plugins/${ID}/page` });
    await sleep(3500);

    const out = { tag: TAG, js: JS_FILE, dom: await ev(cdp, DOMSTAT), rounds: [] };
    const acts = [["tokUnitSeg", "d7"], ["tokUnitSeg", "d30"], ["tokUnitSeg", "day"], ["cacheUnitSeg", "d7"], ["tokUnitSeg", "hour"], ["cacheUnitSeg", "hour"]];
    for (const [seg, unit] of acts) {
      const m0 = await metrics(cdp);
      const page = await ev(cdp, SWITCH(seg, unit));
      const m1 = await metrics(cdp);
      out.rounds.push(Object.assign({ seg, unit,
        taskMs: dMs(m0, m1, "TaskDuration"), scriptMs: dMs(m0, m1, "ScriptDuration"),
        layoutMs: dMs(m0, m1, "LayoutDuration"), styleMs: dMs(m0, m1, "RecalcStyleDuration"),
        layouts: dN(m0, m1, "LayoutCount"), styles: dN(m0, m1, "RecalcStyleCount"),
        nodes: dN(m0, m1, "Nodes"), jsHeapMB: +(((m1.JSHeapUsedSize || 0) / 1048576).toFixed(1)),
      }, page));
    }
    out.domAfter = await ev(cdp, DOMSTAT);
    console.log(JSON.stringify(out, null, 2));
    ws.close();
  } finally {
    proc.kill();
    srv.close();
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
