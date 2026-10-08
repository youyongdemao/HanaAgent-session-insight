// scripts/_probe-share-flip.cjs —— 验证组件面板「本会话供应商」份额卡的横竖切换与 FLIP 动画
// 用法：node scripts/_probe-share-flip.cjs
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO = path.resolve(__dirname, "..");
const ID = "session-insight";
const PORT = 8911;
const CDP_PORT = 9411;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-sf-"));

const now = Date.now();
const PROVIDERS = { providers: [{ id: "volcengine-coding", name: "火山方舟 Coding", baseUrl: null, local: false, links: [], launch: null, view: "token", models: [] }] };
const BALANCE = { balances: [{ provider: "volcengine-coding", name: "火山方舟 Coding", status: "ok", kind: "quota", label: "套餐剩余", summary: "5h 37% · 周 92% · 月 96%", remainingPercent: 37, resetAt: now + 2 * 3600e3 }], unsupported: [], updatedAt: now };
const THEME = (() => {
  try { const base = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "themes", "warm-paper.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {}
  return "";
})();
const HTML = `<!doctype html><html data-theme="warm-paper"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="warm-paper" data-surface="widget"><div id="root" data-surface="widget"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

const send = (res, t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
const json = (res, o) => send(res, "application/json", JSON.stringify(o));

const srv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://127.0.0.1").pathname;
  if (p === "/theme.css") return send(res, "text/css", THEME);
  if (p === `/api/plugins/${ID}/page` || p === `/api/plugins/${ID}/widget`) return send(res, "text/html; charset=utf-8", HTML);
  const asset = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (asset) { const f = path.join(REPO, "ui", "assets", asset[1]); if (fs.existsSync(f)) return send(res, path.extname(f).toLowerCase() === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); res.writeHead(404); return res.end(""); }
  const api = p.startsWith(`/api/apps/session-insight/routes/api/`) ? p.slice(`/api/apps/session-insight/routes/api/`.length) : null;
  if (api === null) return json(res, { ok: true });
  switch (api) {
    case "providers": return json(res, PROVIDERS);
    case "balance": return json(res, BALANCE);
    case "stats":
      return json(res, {
        file: "a.jsonl", title: "会话 A", model: "deepseek-flash", turns: 3, sessionTokens: 120000,
        series: [], providers: [{ provider: "deepseek", tokens: 4060000, turns: 2, cost: 0 }, { provider: "magpie", tokens: 120000, turns: 1, cost: 0 }],
      });
    case "active": return json(res, { file: "a.jsonl" });
    case "sessions": return json(res, { sessions: [], count: 0 });
    case "events": return json(res, { events: [] });
    case "ledger-stats": return json(res, { days: {}, tokens: {}, models: {}, billingModes: {}, providerWindows: {} });
    case "widget-config": return json(res, {});
    default: return json(res, { ok: true });
  }
});

function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); } send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); } }
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { __exception: r.exceptionDetails.text } : r.result?.value; }
const probe = `(()=>{const body=document.querySelector('#wProviderShare .w-share-card .w-share-body');if(!body)return {__error:'没有份额卡的 body'};const d=body.querySelector('.w-share-donut'),l=body.querySelector('.w-share-legend');const dr=d.getBoundingClientRect(),lr=l.getBoundingClientRect();return {stacked:body.dataset.stacked||'',init:body.dataset.siShareInit||'',flips:window.__hanakoShareFlips||0,dir:getComputedStyle(body).flexDirection,bodyW:Math.round(body.clientWidth),donutW:Math.round(dr.width),below:(lr.top>dr.top+4)};})()`;

(async () => {
  const WATCH = setTimeout(() => { console.log("WATCHDOG-TIMEOUT"); process.exit(2); }, 120000);
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  console.log("SERVER UP");
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${CDP_PORT}`, "--user-data-dir=" + path.join(TMP, "p"), "--window-size=720,900", "about:blank"], { stdio: "ignore" });
  proc.on("error", (e) => { console.log("SPAWN ERROR " + e.message); process.exit(3); });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    console.log("CDP TARGET " + (t ? "found" : "MISSING"));
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    console.log("CDP CONNECTED");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 900, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/plugins/${ID}/widget` });
    await sleep(4000);
    const measure = `(()=>{const body=document.querySelector('#wProviderShare .w-share-card .w-share-body');if(!body)return {__error:'no body'};const d=body.querySelector('.w-share-donut'),l=body.querySelector('.w-share-legend');const br=body.getBoundingClientRect(),dr=d.getBoundingClientRect(),lr=l.getBoundingClientRect();const cs=getComputedStyle(body);const ls=getComputedStyle(l);return {bodyW:Math.round(br.width),bodyX:Math.round(br.left),stacked:body.dataset.stacked||'',dir:cs.flexDirection,ai:cs.alignItems,jc:cs.justifyContent,display:cs.display,donutX:Math.round(dr.left-br.left),donutW:Math.round(dr.width),donutCenterOffset:Math.round((dr.left-br.left+dr.width/2)-br.width/2),legendX:Math.round(lr.left-br.left),legendW:Math.round(lr.width),legendCenterOffset:Math.round((lr.left-br.left+lr.width/2)-br.width/2),legendDisplay:ls.display,legendJustifyItems:ls.justifyItems};})()`;
    const SHOTDIR = path.resolve(REPO, "..", "_shots");
    fs.mkdirSync(SHOTDIR, { recursive: true });
    for (const w of [720, 300]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 2, mobile: false });
      await sleep(1600);
      const m = await ev(cdp, measure);
      console.log("W=" + w + " " + JSON.stringify(m));
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const out = path.join(SHOTDIR, "share-" + (m.stacked === "1" ? "narrow" : "wide") + ".png");
      fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
      console.log("SHOT " + out);
    }
    console.log("FLIPS-TOTAL " + JSON.stringify(await ev(cdp, "window.__hanakoShareFlips||0")));
    const narrow = { skip: true };
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(1200);
    const wide = await ev(cdp, probe);
    console.log("WIDE(720)   " + JSON.stringify(wide));
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 200, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(1200);
    const back = await ev(cdp, probe);
    console.log("BACK(200)   " + JSON.stringify(back));
    clearTimeout(WATCH);
    ws.close();
  } catch (e) { console.error("PROBE ERROR:", (e && e.stack) || e); }
  finally { try { proc.kill(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(0), 300); }
})();
