// probe-view-prefs.cjs —— 「图表形态 / 时间范围切换后记不住」回归探针
// 场景：工作台各处的 seg（折线图/热力图、近24h/近7天/…）改完，下次再进来应保持上次的选择。
// 用法：node scripts/probe-view-prefs.cjs
//   用本地 mock server + 无头 Chrome：先读默认 → 逐个点改 → 重新导航（模拟“下次进入”）→ 复读。
//   只读仓库源码，跑完不留临时文件（截图除外，落在 scripts/ 下）。
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const SELF = __dirname;
const REPO = path.resolve(SELF, "..");
const CSS = path.join(REPO, "ui", "assets", "panel-v2.css");
const PANEL = path.join(REPO, "ui", "assets", "panel-v2.js");
const ID = "session-insight";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIES = Array.from({ length: 48 }, (_, i) => ({ turn: i + 1, total: 1000 + i * 90, cost: 0.01 * i, hit: 60 + (i % 20), cacheRead: 500, input: 900, output: 300, latencyMs: 900 }));
const STATS = { file: "20260925-si.jsonl", title: "会话 SI", model: "deepseek-v3.2", turns: 48, sessionTokens: 240000, sessionCostCny: 2.4, contextPercent: 22.5, contextWindow: 128000, lastWindowTokens: 24000, remainingToCompact: 78000, sumInput: 90000, sumOutput: 30000, sumCacheRead: 60000, sumReasoning: 0, series: SERIES, providers: [{ provider: "deepseek", tokens: 240000, turns: 48, models: [{ model: "deepseek-v3.2", tokens: 240000 }] }] };
const BUCKETS = { hour: Array.from({ length: 256 }, (_, i) => (i % 7) * 3), d7: Array.from({ length: 256 }, (_, i) => (i % 5) * 4), d30: Array.from({ length: 256 }, (_, i) => (i % 3) * 5), day: Array.from({ length: 256 }, (_, i) => (i % 4) * 6) };
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

function startServer(port, js) {
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
      const file = name === "panel-v2.js" ? js : path.join(REPO, "ui", "assets", name);
      if (fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase();
        const t = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : ext === ".webp" ? "image/webp" : ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
        return send(t, fs.readFileSync(file));
      }
      res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found");
    }
    const PREFIXES = [`/api/apps/session-insight-v2/routes/api/`, `/api/plugins/${ID}/api/`];
    let api = null;
    for (const pre of PREFIXES) if (p.startsWith(pre)) api = p.slice(pre.length);
    if (api !== null) {
      if (api === "stats") return json(STATS);
      if (api === "active") return json({ dir: "mock", file: STATS.file });
      if (api === "resolve-entry") return json({ file: STATS.file });
      if (api === "sessions") return json({ dir: "mock", sessions: [{ name: STATS.file, title: STATS.title, model: STATS.model, size: 1, mtime: Date.now(), turns: 48 }] });
      if (api === "ledger-stats") return json({ days: {}, calls: 100, errors: 0, tokens: { input: 90000, output: 30000, cacheHit: 60000, cacheMiss: 30000, hitRate: 0.66 }, coverage: { firstDay: "2026-08-29" }, latency: { buckets: {} }, timeBuckets: BUCKETS, tokenBuckets: BUCKETS, cacheRateBuckets: BUCKETS, models: {}, providers: {} });
      if (api === "provider-ledger") return json({ timeBuckets: BUCKETS, tokenBuckets: BUCKETS });
      if (api === "total-cost") return json({ totalCost: 2.4 });
      if (api === "rules") return json({});
      if (api === "providers" || api === "local-providers") return json({ providers: [] });
      if (api === "events") return json({ events: [], entries: [], diags: [] });
      if (api === "balance") return json({ balances: [], updatedAt: Date.now() });
      if (api === "pricing") return json({ rows: [], updatedAt: Date.now() });
      if (api === "ui-env") return json({});
      if (api === "hero-stats") return json({ at: Date.now(), tokens: 240000, firstDay: "2026-08-29", calls: 100, errors: 0, hitRate: 0.66, totalCost: 2.4 });
      if (api === "update-check") return json({});
      if (api === "build-stamp") return json({ stamp: "probe-view-prefs" });
      return json({ ok: true });
    }
    if (p === "/api/sessions/messages") return json({ messages: [] });
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

const SEG_IDS = ["tokModeSeg", "tokUnitSeg", "cacheModeSeg", "cacheUnitSeg", "provUnitSeg", "evRangeSeg", "costModeSeg", "costUnitSeg", "providerCostUnitSeg"];
const READ = `(()=>{const ids=${JSON.stringify(SEG_IDS)};const out={};for(const id of ids){const s=document.getElementById(id);if(!s){out[id]='missing';continue;}const a=s.querySelector('[data-v].active');out[id]=a?a.dataset.v:'none';}
 const viz={tokHeat:!!document.querySelector('#tokViz .heat'),costHeat:!!document.querySelector('#costViz .heat'),cacheHeat:!!document.querySelector('#cacheViz .heat'),provHeat:!!document.querySelector('#providerCostHeat .heat')};
 let ls=null;try{ls=JSON.parse(localStorage.getItem('session-insight.view-prefs.v1')||'null');}catch(e){ls='ERR';}
 return {segs:out,viz,ls,evLabel:((document.getElementById('evRangeLabel')||{}).textContent||'').trim()};})()`;
const clickSeg = (id, v) => `(()=>{const s=document.getElementById('${id}');if(!s)return 'missing';const b=s.querySelector('[data-v="${v}"]');if(!b)return 'noopt';b.click();return 'ok';})()`;
const GO_API = `(()=>{const n=document.querySelector('.nav [data-view="api"]');if(!n)return 'missing';n.click();return 'ok';})()`;

async function snap(cdp) { await sleep(450); return ev(cdp, READ); }

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-vpref-"));
  const js = path.join(TMP, "panel-v2.js");
  fs.copyFileSync(PANEL, js);
  const srv = await startServer(8811, js);
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const udd = path.join(TMP, "chrome-profile");
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--remote-debugging-port=9339", "--user-data-dir=" + udd, "about:blank"], { stdio: "ignore" });
  try {
    if (!fs.existsSync(chromePath)) throw new Error("找不到 Chrome: " + chromePath);
    await waitChrome(9339);
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      const list = await httpJson("http://127.0.0.1:9339/json/list").catch(() => null);
      target = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (!target) await sleep(250);
    }
    if (!target) throw new Error("找不到 page target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 1400, deviceScaleFactor: 1, mobile: false });
    const URL = `http://127.0.0.1:8811/api/plugins/${ID}/page?hana-theme=midnight`;

    const out = {};
    // 1) 全新 profile：默认态
    await cdp.send("Page.navigate", { url: URL }); await sleep(2600);
    out.first = await snap(cdp);
    await ev(cdp, `(()=>{const e=document.getElementById('tokViz');if(e)e.scrollIntoView({block:'start'});return 'ok';})()`); await sleep(500);
    { const s0 = await cdp.send("Page.captureScreenshot", { format: "png" }); const f0 = path.join(SELF, "probe-view-prefs-first.png"); fs.writeFileSync(f0, Buffer.from(s0.data, "base64")); out.firstShotFile = f0; }
    // 2) 逐个改：形态全切热力、范围全切到更远的档
    const clicks = [["tokModeSeg", "heat"], ["tokUnitSeg", "d7"], ["cacheModeSeg", "heat"], ["cacheUnitSeg", "d30"], ["provUnitSeg", "d7"], ["evRangeSeg", "24h"], ["costModeSeg", "heat"], ["costUnitSeg", "day"]];
    out.clickResults = [];
    for (const [id, v] of clicks) out.clickResults.push([id, v, await ev(cdp, clickSeg(id, v))]);
    // 供应商详情页那一个 seg 要先切到 API 页
    out.goApi = await ev(cdp, GO_API); await sleep(600);
    out.clickResults.push(["providerCostUnitSeg", "d30", await ev(cdp, clickSeg("providerCostUnitSeg", "d30"))]);
    await sleep(700);
    out.afterClicks = await snap(cdp);
    // 3) 重新导航 = “下次再进入”
    await cdp.send("Page.navigate", { url: URL }); await sleep(2600);
    out.reenter = await snap(cdp);
    // 3b) 截图：重进后仍是「热力图 + 近7天」的实景（先落在 Token 消费统计上，再把日志区也带上）
    await ev(cdp, `(()=>{const e=document.getElementById('tokViz');if(e)e.scrollIntoView({block:'start'});return 'ok';})()`); await sleep(500);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const f = path.join(SELF, "probe-view-prefs.png");
    fs.writeFileSync(f, Buffer.from(shot.data, "base64"));
    out.shotFile = f;
    // 4) 坏值防护：塞一个不存在的值，重进后应回默认而不是空白
    await ev(cdp, `(()=>{try{localStorage.setItem('session-insight.view-prefs.v1',JSON.stringify({costUnit:'bogus',tokMode:'xxx',evRange:'24h'}));}catch(e){}return 'ok';})()`);
    await cdp.send("Page.navigate", { url: URL }); await sleep(2600);
    out.badValues = await snap(cdp);

    console.log(JSON.stringify(out, null, 2));
    ws.close();
  } finally {
    proc.kill(); srv.close(); await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
