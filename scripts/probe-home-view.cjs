// probe-home-view.cjs —— 设置页「每块各自保存 / 恢复默认」与「工作台首页」回归探针
// 场景：
//   ① 本轮速览、实时用量各自有保存与恢复默认，互不牵连（改了一块不会点亮另一块）；
//   ② 工作台首页只有保存，没有恢复默认；
//   ③ 首页选成 API 管理后，打开工作台直接落在 API 管理页。
// 用法：node scripts/probe-home-view.cjs
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const SELF = __dirname;
const REPO = path.resolve(SELF, "..");
const ID = "session-insight";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PREF = { homeView: "usage" };
const POSTS = [];
const LIVE_ITEMS = [{ id: "hit", label: "缓存命中率", group: "本轮", desc: "本轮请求的缓存命中比例" }];
const WB = [
  { id: "overview", label: "会话信息总览", group: null, desc: "上下文环与本会话总 Token" },
  { id: "turnTokens", label: "当前轮 Token", group: "当前轮信息卡片", desc: "本轮的 Token 消耗总量" },
  { id: "turnHit", label: "当前轮缓存命中", group: "当前轮信息卡片", desc: "本轮的缓存命中率" },
];
// 探针里没有真宿主：settings.js 顶部就会调 hana.ready()，一抛就整模块不执行。
// 于是把 sdk.js 换成最小 shim，只验证设置页自己的读写逻辑。
const SDK_STUB = `export const hana = {\n  ready(){}, \n  resources:{ pick: async()=>({resources:[]}) },\n  external:{ open(){return true;} },\n  api:{ fetch: (...a)=>fetch(...a) },\n};\n`;
const SHIM_CSS = `:root{--text:#e6e8ea;--text-light:#cfd4d8;--text-muted:#9aa1a8;--bg:#0f1113;--bg-card:#1b1f22;--accent:#5b8def;--accent-hover:#6f9bf2;--font-ui:system-ui,"Segoe UI",sans-serif;}\nbody{background:var(--bg);}\n`;

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
const PANEL_HTML = `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

function startServer(port) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === "/theme.css") return send("text/css", THEME_CSS);
    if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", PANEL_HTML);
    if (p === "/settings.html") {
      const html = fs.readFileSync(path.join(REPO, "ui", "settings.html"), "utf8")
        .replace("</head>", `<style>${SHIM_CSS}</style></head>`);
      return send("text/html; charset=utf-8", html);
    }
    if (p.startsWith("/assets/")) {
      const name = p.slice("/assets/".length);
      if (name === "sdk.js") return send("text/javascript", SDK_STUB);
      if (name === "theme-sync.js" || name === "update-notice.js") return send("text/javascript", "export function initHostThemeSync(){}\nexport function initUpdateNotice(){}\nexport function openUpdateNotice(){}\n");
      const file = path.join(REPO, "ui", "assets", name);
      if (fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase();
        const t = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : ext === ".webp" ? "image/webp" : "application/octet-stream";
        return send(t, fs.readFileSync(file));
      }
      res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found");
    }
    const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
    if (m) {
      const file = path.join(REPO, "ui", "assets", m[1]);
      if (fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase();
        const t = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : ext === ".webp" ? "image/webp" : "application/octet-stream";
        return send(t, fs.readFileSync(file));
      }
      res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found");
    }
    const PREFIXES = [`/api/apps/session-insight-v2/routes/api/`, `/api/plugins/${ID}/api/`];
    let api = null;
    for (const pre of PREFIXES) if (p.startsWith(pre)) api = p.slice(pre.length);
    if (api !== null) {
      const readBody = (cb) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => cb(d)); };
      const isPost = req.method === "POST";
      if (api === "panel-prefs") {
        if (isPost) return readBody((d) => {
          let body = null;
          try { body = JSON.parse(d || "{}"); } catch {}
          POSTS.push({ api, body });
          PREF.homeView = body && body.homeView === "api" ? "api" : "usage";
          json({ ok: true, homeView: PREF.homeView });
        });
        return json({ homeView: PREF.homeView });
      }
      if (api === "live-config") {
        if (isPost) return readBody((d) => {
          let body = null;
          try { body = JSON.parse(d || "{}"); } catch {}
          POSTS.push({ api, body });
          json({ ok: true, items: LIVE_ITEMS, order: ["hit"], on: body && Array.isArray(body.on) ? body.on : [] });
        });
        return json({ items: LIVE_ITEMS, order: ["hit"], on: ["hit"] });
      }
      if (api === "widget-config") {
        if (isPost) return readBody((d) => {
          let body = null;
          try { body = JSON.parse(d || "{}"); } catch {}
          POSTS.push({ api, body });
          json({ ok: true, blocks: WB, on: body && Array.isArray(body.on) ? body.on : WB.map((b) => b.id) });
        });
        return json({ blocks: WB, on: WB.map((b) => b.id) });
      }
      if (api === "version") return json({ version: "0.0.0-probe" });
      if (api === "stats") return json({ file: "probe.jsonl", turns: 1, series: [], providers: [] });
      if (api === "ledger-stats") return json({ days: {}, tokens: {}, coverage: {}, latency: { buckets: {} }, timeBuckets: {}, tokenBuckets: {}, cacheRateBuckets: {}, models: {}, providers: {} });
      if (api === "sessions") return json({ dir: "mock", sessions: [] });
      if (api === "active") return json({ dir: "mock", file: null });
      if (api === "providers" || api === "local-providers") return json({ providers: [] });
      if (api === "balance") return json({ balances: [], updatedAt: Date.now() });
      if (api === "pricing") return json({ rows: [], updatedAt: Date.now() });
      if (api === "events") return json({ events: [], entries: [], diags: [] });
      if (api === "hero-stats") return json({ at: Date.now(), tokens: 0, calls: 0, errors: 0, hitRate: 0, totalCost: 0 });
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

const UI_STATE = `(()=>{
  const btn=id=>{const e=document.getElementById(id);return e?(e.disabled?'disabled':'enabled'):'missing';};
  const tx=id=>{const e=document.getElementById(id);return e?e.textContent.trim():null;};
  const ck=id=>{const e=document.getElementById(id);return e?e.checked:'missing';};
  return {
    live:{save:btn('stSaveLive'),reset:btn('stResetLive'),status:tx('stStatusLive'),firstToggle:ck('stList')},
    widget:{save:btn('stSaveWidget'),reset:btn('stResetWidget'),status:tx('stStatusWidget')},
    home:{save:btn('stSaveHome'),reset:btn('stResetHome'),status:tx('stStatusHome'),picked:(()=>{const r=document.querySelector('#stHomeView input[name="homeView"]:checked');return r?r.value:'none';})()}
  };})()`;
const PANEL_VIEW = `(()=>{const tab=document.querySelector('.nav [data-view].active');const view=document.querySelector('.view.active');return {tab:tab?tab.dataset.view:'none',view:view?view.id:'none'};})()`;
const clickToggle = (sel) => `(()=>{const e=document.querySelector('${sel}');if(!e)return 'missing';e.click();return 'ok';})()`;

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-home-"));
  const srv = await startServer(8821);
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const udd = path.join(TMP, "chrome-profile");
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--remote-debugging-port=9341", "--user-data-dir=" + udd, "about:blank"], { stdio: "ignore" });
  try {
    if (!fs.existsSync(chromePath)) throw new Error("找不到 Chrome: " + chromePath);
    await waitChrome(9341);
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      const list = await httpJson("http://127.0.0.1:9341/json/list").catch(() => null);
      target = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (!target) await sleep(250);
    }
    if (!target) throw new Error("找不到 page target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1300, deviceScaleFactor: 1, mobile: false });

    const out = {};
    // ① 设置页：三块按钮初见
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:8821/settings.html" }); await sleep(2200);
    out.boot = await ev(cdp, UI_STATE);
    // ② 只动实时用量里的开关：速览的保存按钮不该被点亮
    out.toggleWidget = await ev(cdp, clickToggle('#wTableBody input[type="checkbox"]')); await sleep(200);
    out.afterWidgetToggle = await ev(cdp, UI_STATE);
    // ③ 实时用量：保存 → 恢复默认
    await ev(cdp, `(()=>{document.getElementById('stSaveWidget').click();return 'ok';})()`); await sleep(900);
    out.afterWidgetSave = await ev(cdp, UI_STATE);
    await ev(cdp, `(()=>{document.getElementById('stResetWidget').click();return 'ok';})()`); await sleep(900);
    out.afterWidgetReset = await ev(cdp, UI_STATE);
    // ④ 只动本轮速览的开关：实时用量的保存按钮不该被点亮
    out.toggleLive = await ev(cdp, clickToggle('#stList input[type="checkbox"]')); await sleep(200);
    out.afterLiveToggle = await ev(cdp, UI_STATE);
    await ev(cdp, `(()=>{document.getElementById('stSaveLive').click();return 'ok';})()`); await sleep(900);
    out.afterLiveSave = await ev(cdp, UI_STATE);
    // ⑤ 工作台首页：选 API 管理并保存，再恢复默认按钮应该压根不存在
    await ev(cdp, `(()=>{const i=document.querySelector('#stHomeView .st-form[data-v="api"] input');if(i)i.click();return 'ok';})()`); await sleep(200);
    out.afterHomePick = await ev(cdp, UI_STATE);
    await ev(cdp, `(()=>{document.getElementById('stSaveHome').click();return 'ok';})()`); await sleep(900);
    out.afterHomeSave = await ev(cdp, UI_STATE);
    out.posts = POSTS.slice();
    const shotS = await cdp.send("Page.captureScreenshot", { format: "png" });
    out.settingsShot = path.join(SELF, "probe-home-view-settings.png");
    fs.writeFileSync(out.settingsShot, Buffer.from(shotS.data, "base64"));
    // ⑥ 打开工作台：应按保存的首页落页
    out.prefNow = PREF.homeView;
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:8821/api/plugins/${ID}/page?hana-theme=midnight` }); await sleep(2600);
    out.panelWhenApi = await ev(cdp, PANEL_VIEW);
    PREF.homeView = "usage";
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:8821/api/plugins/${ID}/page?hana-theme=midnight` }); await sleep(2600);
    out.panelWhenUsage = await ev(cdp, PANEL_VIEW);

    console.log(JSON.stringify(out, null, 2));
    ws.close();
  } finally {
    proc.kill(); srv.close(); await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
