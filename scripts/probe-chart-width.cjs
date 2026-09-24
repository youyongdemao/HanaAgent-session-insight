// probe-chart-width.cjs —— 会话页「一个宽度量错、满屏横向滚动条」问题回归探针
// 场景：页面起来时会话页是隐藏的（display:none），按容器宽度作画的图表量到 0 会退回 640 兜底宽度；
//       进会话页时若已选过会话（setPage 直接 return），不会重画 → 一屏画不下、底下多一条横向滚动条。
// 用法：node scripts/probe-chart-width.cjs
//   对照两面：HEAD（基线）与当前工作区。只读仓库源码，临时副本写在系统临时目录，跑完删掉。
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const SELF = __dirname;
const REPO = path.resolve(SELF, "..");
const CSS = path.join(REPO, "ui", "assets", "panel-v2.css");
const PANEL = path.join(REPO, "ui", "assets", "panel-v2.js");
const ID = "session-insight";
const TURNS = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkSeries(n, base) {
  return Array.from({ length: n }, (_, i) => ({
    turn: i + 1, i: i + 1,
    total: base + i * 4200, cost: (base + i * 4200) * 3e-8,
    input: Math.round((base + i * 4200) * 0.2), output: Math.round((base + i * 4200) * 0.3),
    cacheInc: Math.round((base + i * 4200) * 0.5),
    cacheRead: Math.round((base + i * 4200) * 0.5), cacheMiss: Math.round((base + i * 4200) * 0.2),
    reasoning: 0, hit: 62 + (i % 17), latencyMs: 1100,
  }));
}
const SESSION_FILE = "20260925-si.jsonl";
const STATS = {
  file: SESSION_FILE, title: "会话 SI", model: "deepseek-v3.2", turns: TURNS,
  sessionTokens: 1240000, sessionCostCny: 12.34, contextPercent: 42.5, contextWindow: 128000,
  lastWindowTokens: 54000, remainingToCompact: 48000,
  sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0,
  series: mkSeries(TURNS, 62000), providers: [{ provider: "deepseek", tokens: 1240000, turns: TURNS, models: [{ model: "deepseek-v3.2", tokens: 1240000 }] }],
};
const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="dark" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

function startServer(port, assets) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
    // 静态资源：panel-v2.* 用本次对比的副本，其余（theme-sync/sdk/update-notice...）取仓库原文件
    const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
    if (m) {
      const name = m[1];
      const file = assets[name] || path.join(REPO, "ui", "assets", name);
      if (fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase();
        const t = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : ext === ".webp" ? "image/webp" : ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
        return send(t, fs.readFileSync(file));
      }
      res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found");
    }
    // v2 App 的接口前缀是 /api/apps/<appId>/routes/api/*，v1 插件时代是 /api/plugins/<id>/api/*
    const PREFIXES = [`/api/apps/session-insight-v2/routes/api/`, `/api/plugins/${ID}/api/`];
    let api = null;
    for (const pre of PREFIXES) if (p.startsWith(pre)) api = p.slice(pre.length);
    if (api !== null) {
      if (api === "stats") return json(STATS);
      if (api === "diag-report") return json({ ok: true });
      if (api === "active") return json({ dir: "mock", file: SESSION_FILE });
      if (api === "resolve-entry") return json({ file: SESSION_FILE });
      if (api === "sessions") return json({ dir: "mock", sessions: [{ name: SESSION_FILE, title: STATS.title, model: STATS.model, size: 1, mtime: Date.now(), turns: TURNS }] });
      if (api === "ledger-stats") return json({ days: {}, calls: 120, errors: 1, tokens: {}, latency: { buckets: { lt1: 10, "1_3": 20, "3_10": 5, gt10: 1 } }, models: {}, providers: {} });
      if (api === "total-cost") return json({ totalCost: 16.62 });
      if (api === "rules") return json({});
      if (api === "providers" || api === "local-providers") return json({ providers: [] });
      if (api === "events") return json({ events: [] });
      if (api === "balance") return json({ balances: [], updatedAt: Date.now() });
      if (api === "pricing") return json({ rows: [], updatedAt: Date.now() });
      if (api === "ui-env") return json({});
      if (api === "update-check") return json({});
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

// 量：容器宽 / 内容宽 / svg 实宽；溢出即 scrollWidth > clientWidth
const MEASURE = `(()=>{
  const ids=['ctxChart','costChart','stackChart','cacheChart'];
  return ids.map(id=>{const el=document.getElementById(id);if(!el)return{id,missing:true};
    const svg=el.querySelector('svg');const r=svg?svg.getBoundingClientRect():null;
    return {id,cw:Math.round(el.clientWidth),sw:Math.round(el.scrollWidth),svgW:r?Math.round(r.width):null,overflow:el.scrollWidth-el.clientWidth};});
})()`;

const ENTER = `(async()=>{const t=document.querySelector('.subtab[data-page="usage-session"]');t.click();await new Promise(r=>setTimeout(r,700));return true;})()`;

const OPEN_MODAL = `(async()=>{const c=document.querySelector('.chart-card[data-chart="sessionStack"]');c.click();await new Promise(r=>setTimeout(r,700));
  const box=document.querySelector('#wDetailBody .card.w-detail-visual.w-detail-scroll');
  const card=document.querySelector('#wDetail .w-detail-card');
  const diff=el=>el?el.offsetHeight-el.clientHeight:null;
  return {overlayOpen:document.getElementById('wDetail').classList.contains('open'),hasScrollBox:!!box,
    boxClientW:box?Math.round(box.clientWidth):null,boxScrollW:box?Math.round(box.scrollWidth):null,
    svgW:box&&box.querySelector('svg')?Math.round(box.querySelector('svg').getBoundingClientRect().width):null,
    boxBarPx:diff(box),boxBarPxW:box?box.offsetWidth-box.clientWidth:null,cardBarPx:diff(card)};})()`;

async function runSide(cdp, port, tag) {
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/api/plugins/${ID}/page?hana-theme=dark` });
  await sleep(2600);
  const atBoot = await ev(cdp, MEASURE);
  await ev(cdp, ENTER);
  const afterEnter = await ev(cdp, MEASURE);
  const modal = await ev(cdp, OPEN_MODAL);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  // 只看滚动条那一条：按图表容器的矩形裁一条底部带，放大 3 倍
  let band = null;
  const rect = await ev(cdp, `(()=>{const b=document.querySelector('#wDetailBody .card.w-detail-visual.w-detail-scroll');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom,w:r.width,h:r.height};})()`);
  if (rect) {
    const clip = { x: Math.max(0, rect.x - 4), y: Math.max(0, rect.bottom - 26), width: Math.min(1200, rect.w + 8), height: 26, scale: 3 };
    band = (await cdp.send("Page.captureScreenshot", { format: "png", clip })).data;
  }
  return { tag, atBoot, afterEnter, modal, rect, shot: shot.data, band };
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-chartw-"));
  const newJs = path.join(TMP, "panel-new.js");
  const newCss = path.join(TMP, "panel-new.css");
  const oldJs = path.join(TMP, "panel-old.js");
  const oldCss = path.join(TMP, "panel-old.css");
  fs.copyFileSync(PANEL, newJs);
  fs.copyFileSync(CSS, newCss);
  fs.writeFileSync(oldJs, execSync("git show HEAD:ui/assets/panel-v2.js", { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }));
  fs.writeFileSync(oldCss, execSync("git show HEAD:ui/assets/panel-v2.css", { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }));

  const srvNew = await startServer(8801, { "panel-v2.js": newJs, "panel-v2.css": newCss });
  const srvOld = await startServer(8802, { "panel-v2.js": oldJs, "panel-v2.css": oldCss });
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const udd = path.join(TMP, "chrome-profile");
  // 关键：开 OverlayScrollbar 模拟这台机器的系统设置（“自动隐藏滚动条”），否则无头里原生条也会一直画出来
  const overlay = process.argv.includes("--overlay");
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    ...(overlay ? ["--enable-features=OverlayScrollbar"] : []),
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--remote-debugging-port=9337", "--user-data-dir=" + udd, "about:blank"], { stdio: "ignore" });
  try {
    if (!fs.existsSync(chromePath)) throw new Error("找不到 Chrome: " + chromePath);
    const ver = await waitChrome(9337);
    // 要拿 page target 的 ws，browser 级端点不接受 Page/Runtime 域
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      const list = await httpJson("http://127.0.0.1:9337/json/list").catch(() => null);
      target = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (!target) await sleep(250);
    }
    if (!target) throw new Error("找不到 page target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });

    const out = {};
    out.baseline = await runSide(cdp, 8802, "HEAD");
    out.current = await runSide(cdp, 8801, "worktree");
    for (const k of ["baseline", "current"]) {
      const s = out[k].shot; delete out[k].shot;
      const f = path.join(SELF, `probe-chart-width-${k}.png`);
      fs.writeFileSync(f, Buffer.from(s, "base64"));
      out[k].shotFile = f;
      if (out[k].band) { const bf = path.join(SELF, `probe-bar-${k}.png`); fs.writeFileSync(bf, Buffer.from(out[k].band, "base64")); out[k].bandFile = bf; delete out[k].band; }
    }
    console.log(JSON.stringify(out, null, 2));
    ws.close();
  } finally {
    proc.kill();
    srvNew.close(); srvOld.close();
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
