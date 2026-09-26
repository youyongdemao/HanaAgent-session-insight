// probe-home-view.cjs —— 「工作台首页」设置回归探针
// 场景：设置里把工作台首页选成「API 管理」，重新打开面板应直接落在 API 管理页。
// 用法：node scripts/probe-home-view.cjs
//   本地 mock server + 无头 Chrome：先看设置页读写是否落到 /api/panel-prefs，
//   再按保存后的值打开面板，验证落页。
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
// 探针里没有真宿主：settings.js 顶部就会调 hana.ready()，一抛就整模块不执行。
// 于是把 sdk.js 换成最小 shim，只验证设置页自己的读写逻辑。
const SDK_STUB = `export const hana = {
  ready(){}, 
  resources:{ pick: async()=>({resources:[]}) },
  external:{ open(){return true;} },
  api:{ fetch: (...a)=>fetch(...a) },
};\n`;
const SHIM_CSS = `:root{--text:#e6e8ea;--text-light:#cfd4d8;--text-muted:#8b9298;--bg-card:#1b1f22;--accent:#5b8def;--font-ui:system-ui,"Segoe UI",sans-serif;}\n`;
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
    // 设置页与其静态资源
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
      if (api === "panel-prefs") {
        if (req.method === "POST") {
          return readBody((d) => {
            let body = null;
            try { body = JSON.parse(d || "{}"); } catch {}
            POSTS.push({ api, body });
            PREF.homeView = body && body.homeView === "api" ? "api" : "usage";
            json({ ok: true, homeView: PREF.homeView });
          });
        }
        POSTS.push({ api, body: null });
        return json({ homeView: PREF.homeView });
      }
      if (api === "live-config") return json({ items: [], order: [], on: [] });
      if (api === "widget-config") return json({ blocks: [], on: [] });
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

const SETTINGS_VIEW = `(()=>{const s=document.getElementById('stHomeView');const a=s?s.querySelector('[data-v].active'):null;return {active:a?a.dataset.v:'none',saveDisabled:!!(document.getElementById('stSave')||{}).disabled,status:((document.getElementById('stStatus')||{}).textContent||'').trim()};})()`;
const PANEL_VIEW = `(()=>{const tab=document.querySelector('.nav [data-view].active');const view=document.querySelector('.view.active');return {tab:tab?tab.dataset.view:'none',view:view?view.id:'none'};})()`;

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
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1100, deviceScaleFactor: 1, mobile: false });

    const out = {};
    // 1) 设置页：默认值 + 改动 + 保存
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:8821/settings.html" }); await sleep(2200);
    out.settingsBoot = await ev(cdp, SETTINGS_VIEW);
    out.settingsImport = await ev(cdp, `(async()=>{try{await import('/assets/settings.js');return 'ok';}catch(e){return 'ERR '+String(e&&e.message||e);}})()`);
    out.clickApi = await ev(cdp, `(()=>{const b=document.querySelector('#stHomeView [data-v="api"]');if(!b)return 'missing';b.click();return 'ok';})()`);
    await sleep(250);
    out.settingsAfterClick = await ev(cdp, SETTINGS_VIEW);
    await ev(cdp, `(()=>{const s=document.getElementById('stSave');if(s)s.click();return 'ok';})()`);
    await sleep(1200);
    out.settingsAfterSave = await ev(cdp, SETTINGS_VIEW);
    out.postsAfterSave = POSTS.slice(-3);
    const shotS = await cdp.send("Page.captureScreenshot", { format: "png" });
    out.settingsShot = path.join(SELF, "probe-home-view-settings.png");
    fs.writeFileSync(out.settingsShot, Buffer.from(shotS.data, "base64"));
    // 2) 面板：首页=api 时应直接落在 API 管理页
    out.prefNow = PREF.homeView;
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:8821/api/plugins/${ID}/page?hana-theme=midnight` }); await sleep(2600);
    out.panelWhenApi = await ev(cdp, PANEL_VIEW);
    // 3) 改回用量，再进应回落用量页
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
