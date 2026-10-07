// _shot-settings-fx.cjs —— 设置页截图（给「高级视觉效果」这块出真实预览）
// mock 掉设置页需要的全部接口，加载 settings.html，分别截「开关都关」与「开关都开」两张。
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const SELF = __dirname, REPO = path.resolve(SELF, ".."), ID = "session-insight", APP = "session-insight";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9051, CDP_PORT = 9551;

const LIVE_ITEMS = [
  { id: "tokens", label: "本轮 Token", group: "turn", desc: "输入 / 输出 / 缓存命中" },
  { id: "cost", label: "本轮费用", group: "turn" },
  { id: "hit", label: "缓存命中率", group: "turn" },
  { id: "tps", label: "输出吞吐", group: "" },
  { id: "duration", label: "本轮耗时", group: "" },
];
const WIDGET_BLOCKS = [
  { id: "wTokTotal", label: "总 Token", group: "totals" },
  { id: "wCostTotal", label: "总费用", group: "totals" },
  { id: "wCtx", label: "上下文占用", group: "" },
  { id: "wHit", label: "缓存命中率", group: "" },
];
const THEME_CSS = (() => { try { const b = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(b).sort().reverse()) { const p = path.join(b, d, "themes", "midnight.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {} return ""; })();
let FX = { glass: false, glow: true };
const readBody = (req) => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { res(JSON.parse(d || "{}")); } catch { res({}); } }); });

function startServer(port) {
  const srv = http.createServer(async (req, res) => {
    const p = new URL(req.url, "http://127.0.0.1").pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === "/theme.css") return send("text/css", THEME_CSS);
    if (p === `/api/apps/${APP}/ui/settings.html`) return send("text/html; charset=utf-8", fs.readFileSync(path.join(REPO, "ui", "settings.html")));
    const m = p.match(new RegExp(`^/api/apps/${APP}/ui/(assets/.+)$`));
    if (m) { const f = path.join(REPO, "ui", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : e === ".js" ? "text/javascript" : "application/octet-stream", fs.readFileSync(f)); } res.writeHead(404); return res.end("nf"); }
    const PRE = [`/api/apps/${APP}/routes/`];
    let api = null; for (const x of PRE) if (p.startsWith(x)) api = p.slice(x.length);
    if (api !== null) {
      if (api === "fx-config") { if (req.method === "POST") { const b = await readBody(req); if (typeof b.glass === "boolean") FX.glass = b.glass; if (typeof b.glow === "boolean") FX.glow = b.glow; } return json(FX); }
      if (api === "live-config") return json({ items: LIVE_ITEMS, order: LIVE_ITEMS.map((x) => x.id), on: LIVE_ITEMS.filter((x) => x.id !== "tps").map((x) => x.id) });
      if (api === "widget-config") return json({ blocks: WIDGET_BLOCKS, on: WIDGET_BLOCKS.map((x) => x.id), rev: 2 });
      if (api === "panel-prefs") return json({ homeView: "usage" });
      if (api === "local-providers" || api === "providers") return json({ providers: [] });
      if (api === "query-credentials") return json({ providers: [] });
      if (api === "version") return json({ version: "2.1.0", latest: "2.1.0" });
      return json({ ok: true });
    }
    return json({ ok: true });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
function httpJson(u) { return new Promise((s, j) => { http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { s(JSON.parse(d)); } catch (e) { j(e); } }); }).on("error", j); }); }
async function waitChrome(p) { for (let i = 0; i < 80; i++) { try { return await httpJson(`http://127.0.0.1:${p}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); } send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); } }
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return { __exception: r.exceptionDetails.text }; return r.result?.value; }

async function shoot(cdp, tag) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 900, height: 1100, scale: 2 } });
  const f = path.join(SELF, `_settings-fx-${tag}.png`);
  fs.writeFileSync(f, Buffer.from(r.data, "base64"));
  return f;
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-setfx-"));
  const srv = await startServer(PORT);
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=" + CDP_PORT, "--user-data-dir=" + path.join(TMP, "p"), "about:blank"], { stdio: "ignore" });
  try {
    await waitChrome(CDP_PORT);
    let target = null;
    for (let i = 0; i < 40 && !target; i++) { const l = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null); target = (l || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (!target) await sleep(250); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__err=[];window.addEventListener('error',e=>window.__err.push(String(e.message)+' @'+(e.filename||'')+':'+(e.lineno||'')));window.addEventListener('unhandledrejection',e=>window.__err.push('rej: '+String(e.reason&&e.reason.message||e.reason)));document.addEventListener('DOMContentLoaded',()=>{try{const l=document.createElement('link');l.rel='stylesheet';l.href='/theme.css';document.head.appendChild(l);}catch(e){}});" });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1100, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/apps/${APP}/ui/settings.html?hana-theme=midnight` });
    await sleep(3000);
    const out = { defaultState: await ev(cdp, `(()=>{const l=document.getElementById('stFxList');return {exists:!!l,rows:l?l.querySelectorAll('.st-item').length:0,checked:[...document.querySelectorAll('#stFxList input[type=checkbox]')].map(c=>c.checked),labels:[...document.querySelectorAll('#stFxList .st-item-title')].map(e=>e.textContent)};})()`) };
    out.earlyDiag = await ev(cdp, `(()=>({err:window.__err||null,liveRows:document.querySelectorAll('#stList .st-item').length,wRows:document.querySelectorAll('#wTableBody .st-item').length}))()`);
    out.fileDefault = await shoot(cdp, "default");
    // 把两个都打开，再截一张
    await ev(cdp, `(()=>{document.querySelectorAll('#stFxList input[type=checkbox]').forEach(c=>{if(!c.checked){c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));}});return true;})()`);
    await sleep(900);
    out.fileAllOn = await shoot(cdp, "allon");
    out.allOnState = await ev(cdp, `(()=>[...document.querySelectorAll('#stFxList input[type=checkbox]')].map(c=>c.checked))()`);
    out.serverFx = FX;
    console.log(JSON.stringify(out, null, 2));
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(400); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
