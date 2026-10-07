// scripts/_probe-widget-detail.cjs —— 渲染「实时用量」卡片的额度详情并截图
// 用法：node scripts/_probe-widget-detail.cjs --out=<out.png>
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO = path.resolve(__dirname, "..");
const ID = "session-insight";
const ARGV = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const OUT = ARGV.out ? path.resolve(ARGV.out) : path.join(REPO, "_shots", "widget-detail.png");
const PORT = Number(ARGV.port || 8901);
const W = Number(ARGV.width || 520);
const CDP_PORT = Number(ARGV.cdp || 9401);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-wd-"));

const now = Date.now();
const PROVIDERS = {
  providers: [{ id: "volcengine-coding", name: "火山方舟 Coding", baseUrl: null, local: false, links: [], launch: null, view: "token", models: [] }],
};
const BALANCE = {
  balances: [{
    provider: "volcengine-coding", name: "火山方舟 Coding", status: "ok", kind: "quota", label: "套餐剩余",
    summary: "5h 37% · 周 92% · 月 96%", remainingPercent: 37, resetAt: now + 2 * 3600e3 + 25 * 60e3,
    windows: [
      { type: "five_hour", label: "5 小时窗口", short: "5h", remainingPercent: 37, resetAt: now + 2 * 3600e3 + 25 * 60e3 },
      { type: "weekly", label: "周窗口", short: "周", remainingPercent: 92, resetAt: now + 3 * 86400e3 + 4 * 3600e3 },
      { type: "monthly", label: "月窗口", short: "月", remainingPercent: 96, resetAt: now + 27 * 86400e3 },
    ],
  }],
  unsupported: [], updatedAt: now,
};
const THEME = (() => {
  try {
    const base = "D:/AI/Hanako/artifacts/renderer";
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const p = path.join(base, d, "themes", "warm-paper.css");
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
  } catch {}
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
  if (asset) {
    const f = path.join(REPO, "ui", "assets", asset[1]);
    if (fs.existsSync(f)) return send(res, path.extname(f).toLowerCase() === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f));
    res.writeHead(404); return res.end("");
  }
  const api = p.startsWith(`/api/apps/session-insight/routes/api/`) ? p.slice(`/api/apps/session-insight/routes/api/`.length) : null;
  if (api === null) return json(res, { ok: true });
  switch (api) {
    case "providers": return json(res, PROVIDERS);
    case "balance": return json(res, BALANCE);
    case "stats":
      return json(res, {
        file: "a.jsonl", title: "会话 A", model: "deepseek-flash", turns: 3, sessionTokens: 120000,
        series: [], providers: [{ provider: "volcengine-coding", tokens: 51390000, turns: 3, cost: 0 }, { provider: "volcengine", tokens: 8540000, turns: 1, cost: 0 }],
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
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { __exception: r.exceptionDetails.text } : r.result?.value; }

(async () => {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run",
    `--remote-debugging-port=${CDP_PORT}`, "--user-data-dir=" + path.join(TMP, "p"), `--window-size=${W},900`, "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: 900, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/plugins/${ID}/widget` });
    await sleep(4000);
    const card = await ev(cdp, `(()=>{const list=[...document.querySelectorAll('.widget [data-detail]')].map(x=>x.dataset.detail);const el=[...document.querySelectorAll('.widget [data-detail="providers"]')][0]||document.querySelector('.w-quota-item');if(el)el.click();return {list,clicked:el?(el.dataset.detail||'quota-item'):null};})()`);
    if (!card || card.__error) { console.log("CARD FAIL:", JSON.stringify(card)); }
    await sleep(3000);
    // 先窄后宽：横竖切换时到底有没有补上过渡（读 panel-v2.js 里的翻转计数）
    const t0 = await ev(cdp, "({flips:window.__hanakoDonutFlips||0,calls:window.__hanakoDonutLayoutCalls||0,w:window.innerWidth,box:(()=>{const dl=document.querySelector('.w-donut-layout');return dl?Math.round(dl.clientWidth):null;})()})");
    const wideW = Math.max(W, 680);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: wideW, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(1000);
    const t1 = await ev(cdp, "({flips:window.__hanakoDonutFlips||0,calls:window.__hanakoDonutLayoutCalls||0,w:window.innerWidth,box:(()=>{const dl=document.querySelector('.w-donut-layout');return dl?Math.round(dl.clientWidth):null;})(),detail:(()=>{const dl=document.querySelector('.w-donut-layout');if(!dl)return null;const copy=dl.querySelector('.w-donut-copy');let subW=0;for(const s of copy.querySelectorAll('.w-donut-legend>span')){const rr=document.createRange();rr.selectNodeContents(s);subW=Math.max(subW,rr.getBoundingClientRect().width);}return {stacked:dl.dataset.stacked||'',subW:Math.round(subW),ml:copy.style.marginLeft||''};})(),wrapped:(()=>{const dl=document.querySelector('.w-donut-layout');if(!dl)return null;const r=dl.querySelector('.w-donut-ring').getBoundingClientRect(),c=dl.querySelector('.w-donut-copy').getBoundingClientRect();return c.top>r.top+4;})()})");
    console.log("RESIZE " + JSON.stringify(t0) + " -> " + JSON.stringify(t1));
    // 再拉窄一次，确认反向也走一遍
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(1000);
    const t2 = await ev(cdp, "({flips:window.__hanakoDonutFlips||0,w:window.innerWidth,wrapped:(()=>{const dl=document.querySelector('.w-donut-layout');if(!dl)return null;const r=dl.querySelector('.w-donut-ring').getBoundingClientRect(),c=dl.querySelector('.w-donut-copy').getBoundingClientRect();return c.top>r.top+4;})()})");
    console.log("RESIZE-BACK " + JSON.stringify(t2));
    const det = await ev(cdp, `(()=>{const el=document.getElementById('wDetail');if(!el)return {__error:'没有详情层'};const h=el.getBoundingClientRect();const dl=el.querySelector('.w-donut-layout');let wrapped=null;let need=null;if(dl){const r=dl.querySelector('.w-donut-ring').getBoundingClientRect(),c=dl.querySelector('.w-donut-copy').getBoundingClientRect();wrapped=c.top>r.top+4;need={box:Math.round(dl.clientWidth),stacked:dl.dataset.stacked||'',ring:Math.round(r.width),copy:Math.round(c.width)};}return {rect:h.toJSON(),wrapped,need,text:el.textContent.replace(/\\s+/g,' ').slice(0,160)};})()`);
    if (det && !det.__error) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      const r = det.rect;
      const box = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(W, r.width || W), height: Math.min(880, r.height || 800) };
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 2 } });
      fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
      console.log("WRAPPED=" + det.wrapped + " NEED=" + JSON.stringify(det.need));
      console.log("TEXT: " + det.text);
      console.log(`SHOT: ${OUT}`);
    } else {
      console.log("DETAIL FAIL:", JSON.stringify(det));
    }
    ws.close();
  } catch (e) {
    console.error("PROBE ERROR:", (e && e.stack) || e);
  } finally {
    try { proc.kill(); } catch {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    setTimeout(() => process.exit(0), 300);
  }
})();
