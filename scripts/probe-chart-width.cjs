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
// 前端指纹：探针中途会改它，验证「页面自己发现代码变了就刷新」这条链路
const STAMP = { value: "probe-1" };
const BS_HITS = { value: 0 };
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
// 探针默认用宿主内置暗色主题 midnight 的调色板（设置里主题=auto、系统暗色时就是它）。
// 不然插件样式里的 var(--accent)/var(--bg) 取不到值，截图会退化成黑块。
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
      if (api === "ledger-stats") return json({ days: { "2026-08-29": { tokens: 2.6e9, cost: 146.4 }, "2026-09-10": { tokens: 2.59e9, cost: 146.5 } }, calls: 39408, errors: 39, tokens: { input: 5.1e9, output: 9.1e7, cacheHit: 4.9e9, cacheMiss: 1.1e8, hitRate: 0.982 }, coverage: { firstDay: "2026-08-29" }, latency: { buckets: { lt1: 10, "1_3": 20, "3_10": 5, gt10: 1 } }, models: {}, providers: {} });
      if (api === "total-cost") return json({ totalCost: 16.62 });
      if (api === "rules") return json({});
      if (api === "providers" || api === "local-providers") return json({ providers: [] });
      if (api === "events") return json({ events: [] });
      if (api === "balance") return json({ balances: [], updatedAt: Date.now() });
      if (api === "pricing") return json({ rows: [], updatedAt: Date.now() });
      if (api === "ui-env") return json({});
      if (api === "update-check") return json({});
      if (api === "build-stamp") { BS_HITS.value++; return json({ stamp: STAMP.value, hits: BS_HITS.value }); }
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

// 详情弹层：四种逐轮图逐个开一遍，量 y 轴列、滚动区、滚动条占位与绘图区宽；最后停在堆叠图上截图
const OPEN_MODAL = `(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const R=el=>{if(!el)return null;const q=el.getBoundingClientRect();return{x:Math.round(q.x),y:Math.round(q.y),w:Math.round(q.width),h:Math.round(q.height),bottom:Math.round(q.bottom),right:Math.round(q.right)};};
  const probe=()=>{
    const plot=document.querySelector('#wDetailBody .w-detail-plot');
    const yx=plot&&plot.querySelector('.sc-yaxis'), sc=plot&&plot.querySelector('.w-detail-scroll'), svg=sc&&sc.querySelector('svg');
    return {hasPlot:!!plot,cardsInBody:document.querySelectorAll('#wDetailBody .card').length,
      yaxis:R(yx),scroll:R(sc),svg:R(svg),svgAttrW:svg?+svg.getAttribute('width'):null,
      overflowPx:sc?Math.round(sc.scrollWidth-sc.clientWidth):null,barPx:sc?Math.round(sc.offsetHeight-sc.clientHeight):null,
      sx:sc?Math.round(sc.scrollLeft):null,sxMax:sc?Math.round(sc.scrollWidth-sc.clientWidth):null,xTicks:svg?svg.querySelectorAll('.axis-text').length:null,
      axisPinned:!!(yx&&sc&&yx.parentElement===sc.parentElement&&yx.nextElementSibling===sc)};
  };
  const out=[];
  for(const k of ['sessionTokens','sessionCost','sessionStack','sessionCache']){
    const c=document.querySelector('.chart-card[data-chart="'+k+'"]');
    if(!c){out.push({k,missing:true});continue;}
    c.click(); await sleep(650); out.push(Object.assign({k},probe()));
    document.querySelector('[data-detail-close]').click(); await sleep(300);
  }
  const c2=document.querySelector('.chart-card[data-chart="sessionStack"]'); c2.click(); await sleep(700);
  const sc=document.querySelector('#wDetailBody .w-detail-plot .w-detail-scroll');
  const mc=document.querySelector('#wDetail .w-detail-card');
  const mq=mc?mc.getBoundingClientRect():null;
  return {kinds:out,stack:probe(),scrollRect:R(sc),
    cardRect:mq?{x:Math.round(mq.x),y:Math.round(mq.y),w:Math.round(mq.width),h:Math.round(mq.height),bottom:Math.round(mq.bottom),right:Math.round(mq.right)}:null};
})()`;

const GEOM = `(()=>{
  const out={};
  const card=document.querySelector('#usage-session .chart-card');
  if(!card)return {missing:true};
  const sc=card.querySelector('.scroll-chart'), yx=card.querySelector('.sc-yaxis'), cs=card.querySelector('.chart-scroll'), svg=cs&&cs.querySelector('svg');
  const r=el=>el?((x)=>({x:Math.round(x.x),y:Math.round(x.y),w:Math.round(x.width),h:Math.round(x.height),bottom:Math.round(x.bottom),right:Math.round(x.right)}))(el.getBoundingClientRect()):null;
  out.card=r(card);out.h3=r(card.querySelector('h3'));out.scrollChart=r(sc);out.yaxis=r(yx);out.chartScroll=r(cs);out.svg=r(svg);
  const ccs=getComputedStyle(card),css=getComputedStyle(sc||card);
  out.cardPad=[ccs.paddingTop,ccs.paddingRight,ccs.paddingBottom,ccs.paddingLeft].join(' ');
  out.scrollMin=css.minHeight;
  out.xTicks=svg?svg.querySelectorAll('.axis-text').length:null;
  if(svg){const bb=(sel)=>{const n=svg.querySelector(sel);if(!n)return null;const b=n.getBBox();return {x:+b.x.toFixed(1),y:+b.y.toFixed(1),w:+b.width.toFixed(1),h:+b.height.toFixed(1)};};out.svgViewBox=svg.getAttribute('viewBox');out.lines=svg.querySelectorAll('.si-line').length;out.pathBox=bb('.si-line');out.gridBox=bb('.grid-line');out.textBox=bb('text');}
  return out;
})()`;

const SHOT_CARDS = `(async()=>{const g=document.querySelector('.session-charts');if(!g)return null;g.scrollIntoView({block:'start'});await new Promise(r=>setTimeout(r,300));const r=g.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`;

// 标尺字号与缩放调查：SVG 若被 CSS 拉伸（width:100%），实际字号 = 声明字号 × 缩放
const FONTS = `(()=>{
  const list=['#ctxChart','#tokViz','#cacheViz','#budgetChart','#providerCostLine','#usage-overview #taskCat'];
  const out=[];
  const add=(name,svg)=>{if(!svg)return;const r=svg.getBoundingClientRect();const vb=(svg.getAttribute('viewBox')||'').split(/\\s+/);const vbW=+vb[2]||0;const t=svg.querySelector('.axis-text');const fs2=t?parseFloat(getComputedStyle(t).fontSize):null;const scale=vbW?r.width/vbW:1;out.push({name,rectW:Math.round(r.width),vbW:vbW||null,scale:+scale.toFixed(3),declared:fs2,effective:fs2?+(fs2*scale).toFixed(2):null});};
  for(const s of list)add(s,document.querySelector(s+' svg'));
  return out;
})()`;

// 两个 hero 的几何：标签行、大数字、hero 本体的位置与间隙
const HERO = `(()=>{
  const R=el=>{if(!el)return null;const q=el.getBoundingClientRect();return{y:Math.round(q.y),h:Math.round(q.height),b:Math.round(q.bottom),x:Math.round(q.x),w:Math.round(q.width)};};
  const g=(root,tok,label,num)=>({hero:R(document.querySelector(root+' .usage-hero')),main:R(document.querySelector(root+' .uh-main')),tok:R(document.querySelector(tok)),label:R(document.querySelector(label)),num:R(document.querySelector(num))});
  const ov=g('#usage-overview','#usage-overview .uh-tok','#usage-overview .uh-tok .uh-label','#usage-overview #kTok');
  ov.hit={wrap:R(document.querySelector('#usage-overview .uh-hit')),label:R(document.querySelector('#usage-overview .uh-hit .uh-label')),num:R(document.querySelector('#usage-overview #kHit'))};
  ov.range=R(document.querySelector('#usage-overview #kTokRange'));
  ov.hitrow=R(document.querySelector('#usage-overview .uh-hitrow'));
  ov.divider=R(document.querySelector('#usage-overview .uh-hitrow .uh-divider'));
  ov.mini=R(document.querySelector('#usage-overview .uh-hitrow .uh-mini'));
  ov.labelCS=(()=>{const e=document.querySelector('#usage-overview .uh-tok .uh-label');if(!e)return null;const s=getComputedStyle(e);return{display:s.display,justify:s.justifyContent,width:s.width,minW:s.minWidth};})();
  const se=g('#usage-session','#usage-session .uh-tok','#usage-session .uh-tok .uh-label','#usage-session #sTok');
  return {overview:ov,session:se};
})()`;

async function runSide(cdp, port, tag) {
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/api/plugins/${ID}/page?hana-theme=midnight` });
  await sleep(2600);
  const fonts = await ev(cdp, FONTS);
  const heroBoot = await ev(cdp, HERO);
  const atBoot = await ev(cdp, MEASURE);
  // 总览 hero 整块截图（看 KPI 数字与「记录自…起」标记的位置）
  let heroShot = null;
  const hr = await ev(cdp, `(()=>{const e=document.querySelector('#usage-overview .usage-hero');if(!e)return null;const q=e.getBoundingClientRect();return {x:q.x,y:q.y,w:q.width,h:q.height};})()`);
  if (hr && hr.w) heroShot = (await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, hr.x - 8), y: Math.max(0, hr.y - 8), width: Math.min(1200, hr.w + 16), height: Math.min(700, hr.h + 16), scale: 2 } })).data;
  await ev(cdp, ENTER);
  const afterEnter = await ev(cdp, MEASURE);
  const heroSession = await ev(cdp, HERO);
  let heroSessionShot = null;
  const sr = await ev(cdp, `(()=>{const e=document.querySelector('#usage-session .usage-hero');if(!e)return null;const q=e.getBoundingClientRect();return {x:q.x,y:q.y,w:q.width,h:q.height};})()`);
  if (sr && sr.w) heroSessionShot = (await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, sr.x - 8), y: Math.max(0, sr.y - 8), width: Math.min(1200, sr.w + 16), height: Math.min(400, sr.h + 16), scale: 2 } })).data;
  const geom = await ev(cdp, GEOM);
  const cardsRect = await ev(cdp, SHOT_CARDS);
  let cardsShot = null;
  if (cardsRect && cardsRect.w) {
    cardsShot = (await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, cardsRect.x - 6), y: Math.max(0, cardsRect.y - 6), width: Math.min(1200, cardsRect.w + 12), height: Math.min(880, cardsRect.h + 12), scale: 1.4 } })).data;
  }
  const modal = await ev(cdp, OPEN_MODAL);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  // 详情图底部一条带：看滚动条是不是贴着 x 轴标签下方
  let band = null;
  const rect = modal && modal.scrollRect;
  if (rect) {
    const clip = { x: Math.max(0, rect.x - 6), y: Math.max(0, rect.bottom - 20), width: Math.min(1200, rect.w + 12), height: 34, scale: 3 };
    band = (await cdp.send("Page.captureScreenshot", { format: "png", clip })).data;
  }
  let modalShot = null;
  const cr = modal && modal.cardRect;
  if (cr) {
    const clip = { x: Math.max(0, cr.x - 10), y: Math.max(0, cr.y - 10), width: Math.min(1200, cr.w + 20), height: Math.min(1500, cr.h + 20), scale: 1.5 };
    modalShot = (await cdp.send("Page.captureScreenshot", { format: "png", clip })).data;
  }
  // 自刷新链路：先把详情关掉（开着时是故意不刷的）→ 改指纹 → 等一轮轮询 → 页面应该自己 reload
  await ev(cdp, `(()=>{const b=document.querySelector('[data-detail-close]');if(b)b.click();return true;})()`);
  await sleep(500);
  const routeProbe = await ev(cdp, `fetch("/api/apps/session-insight-v2/routes/api/build-stamp").then(r=>r.text()).then(t=>t.slice(0,140)).catch(e=>"ERR "+String(e))`);
  const t0 = await ev(cdp, "performance.timeOrigin");
  STAMP.value = "probe-2-" + Date.now();
  await sleep(15000);
  const t1 = await ev(cdp, "performance.timeOrigin");
  const selfReload = { before: t0, after: t1, reloaded: t0 !== t1, hits: BS_HITS.value, routeProbe };
  return { tag, atBoot, afterEnter, geom, cardsRect, modal, rect, shot: shot.data, band, cardsShot, modalShot, heroShot, heroSessionShot, fonts, heroBoot, heroSession, selfReload };
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-chartw-"));
  const newJs = path.join(TMP, "panel-new.js");
  const newCss = path.join(TMP, "panel-new.css");
  const oldJs = path.join(TMP, "panel-old.js");
  const oldCss = path.join(TMP, "panel-old.css");
  fs.copyFileSync(PANEL, newJs);
  fs.copyFileSync(CSS, newCss);
  // 对比基线：默认 HEAD；HEAD 已包含本次改动时用 --rev <commit> 指向改动前那一版
  const revIdx = process.argv.indexOf("--rev");
  const BASE_REV = revIdx > -1 ? process.argv[revIdx + 1] : "HEAD";
  fs.writeFileSync(oldJs, execSync(`git show ${BASE_REV}:ui/assets/panel-v2.js`, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }));
  fs.writeFileSync(oldCss, execSync(`git show ${BASE_REV}:ui/assets/panel-v2.css`, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }));

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
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 1500, deviceScaleFactor: 1, mobile: false });

    const out = {};
    out.baseline = await runSide(cdp, 8802, `${BASE_REV}`);
    out.current = await runSide(cdp, 8801, "worktree");
    for (const k of ["baseline", "current"]) {
      const s = out[k].shot; delete out[k].shot;
      const f = path.join(SELF, `probe-chart-width-${k}.png`);
      fs.writeFileSync(f, Buffer.from(s, "base64"));
      out[k].shotFile = f;
      if (out[k].band) { const bf = path.join(SELF, `probe-bar-${k}.png`); fs.writeFileSync(bf, Buffer.from(out[k].band, "base64")); out[k].bandFile = bf; delete out[k].band; }
      if (out[k].cardsShot) { const cf = path.join(SELF, `probe-cards-${k}.png`); fs.writeFileSync(cf, Buffer.from(out[k].cardsShot, "base64")); out[k].cardsFile = cf; delete out[k].cardsShot; }
      if (out[k].modalShot) { const mf = path.join(SELF, `probe-modal-${k}.png`); fs.writeFileSync(mf, Buffer.from(out[k].modalShot, "base64")); out[k].modalFile = mf; delete out[k].modalShot; }
      if (out[k].heroShot) { const hf = path.join(SELF, `probe-hero-${k}.png`); fs.writeFileSync(hf, Buffer.from(out[k].heroShot, "base64")); out[k].heroFile = hf; delete out[k].heroShot; }
      if (out[k].heroSessionShot) { const sf = path.join(SELF, `probe-hero-session-${k}.png`); fs.writeFileSync(sf, Buffer.from(out[k].heroSessionShot, "base64")); out[k].heroSessionFile = sf; delete out[k].heroSessionShot; }
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
