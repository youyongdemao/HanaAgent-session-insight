// scripts/_probe-balance-pills.cjs —— 渲染「总余额」胶囊区并截图（预览用，不连真机）
// 用法：node scripts/_probe-balance-pills.cjs --out=<out.png>
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO = path.resolve(__dirname, "..");
const ID = "session-insight";
const ARGV = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const OUT = ARGV.out ? path.resolve(ARGV.out) : path.join(REPO, "_shots", "balance-pills.png");
const OUT2 = ARGV.out2 ? path.resolve(ARGV.out2) : null;
const PORT = Number(ARGV.port || 8899);
const CDP_PORT = Number(ARGV.cdp || 9399);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-pills-"));

const PROVIDERS = {
  providers: [
    { id: "deepseek", name: "DeepSeek", baseUrl: null, local: false, links: [], launch: null, view: "money", models: [] },
    { id: "moonshot", name: "Moonshot", baseUrl: null, local: false, links: [], launch: null, view: "money", models: [] },
    { id: "volcengine", name: "火山方舟", baseUrl: null, local: false, links: [], launch: null, view: "money", models: [] },
    { id: "volcengine-coding", name: "火山方舟 Coding", baseUrl: null, local: false, links: [], launch: null, view: "token", models: [] },
  ],
};
const BALANCE = {
  balances: [
    { provider: "deepseek", name: "DeepSeek", status: "ok", kind: "balance", label: "可用余额", summary: "¥34.63", total: 34.63, currency: "CNY" },
    { provider: "moonshot", name: "Moonshot", status: "ok", kind: "balance", label: "可用余额", summary: "¥41.14", total: 41.14, currency: "CNY" },
    { provider: "volcengine", name: "火山方舟", status: "ok", kind: "balance", label: "云账户余额", summary: "¥1,234.56", total: 1234.56, currency: "CNY" },
    {
      provider: "volcengine-coding", name: "火山方舟 Coding", status: "ok", kind: "quota", label: "套餐剩余",
      summary: "5h 37% · 周 92% · 月 96%", remainingPercent: 37, resetAt: null,
      windows: [
        { type: "five_hour", label: "5 小时窗口", short: "5h", remainingPercent: 37 },
        { type: "weekly", label: "周窗口", short: "周", remainingPercent: 92 },
        { type: "monthly", label: "月窗口", short: "月", remainingPercent: 96 },
      ],
    },
  ],
  unsupported: [],
  updatedAt: Date.now(),
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
const HTML = `<!doctype html><html data-theme="warm-paper"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="warm-paper" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

const send = (res, t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
const json = (res, o) => send(res, "application/json", JSON.stringify(o));

const srv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://127.0.0.1").pathname;
  if (p === "/theme.css") return send(res, "text/css", THEME);
  if (p === `/api/plugins/${ID}/page`) return send(res, "text/html; charset=utf-8", HTML);
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
    case "pricing": return json(res, { rows: [], db: { ok: true } });
    case "total-cost": return json(res, { totalCost: 165.96 });
    case "hero-stats": return json(res, { ok: true, tokens: 5630000000, totalCost: 165.96, calls: 120, errors: 0, hitRate: 0.62, firstDay: "2026-08-01" });
    case "rules": return json(res, {});
    case "panel-prefs": return json(res, { homeView: "api" });
    case "ledger-stats":
      return json(res, {
        days: { "2026-10-07": { tokens: 1200000, cost: 1.2 } }, calls: 3, errors: 0,
        tokens: { input: 700, output: 300, cacheHit: 200, cacheMiss: 100, hitRate: 0.6 },
        timeBuckets: { hour: [0, 1, 2], day: [1, 2, 3] }, tokenBuckets: { hour: [10, 20, 30], day: [100, 200, 300] },
        billingModes: { "volcengine-coding": "subscription" }, providerWindows: {},
      });
    case "stats": return json(res, { file: "a.jsonl", title: "会话 A", model: "deepseek-flash", turns: 1, series: [], providers: [] });
    case "active": return json(res, { file: "a.jsonl" });
    case "sessions": return json(res, { sessions: [], count: 0 });
    case "events": return json(res, { events: [] });
    case "widget-config": return json(res, {});
    case "local-providers": return json(res, { providers: [] });
    default: return json(res, { ok: true });
  }
});

function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { __exception: r.exceptionDetails.text } : r.result?.value; }

const PROBE = `(()=>{const el=document.querySelector('.api-hero')||document.getElementById('tBalSub');
  if(!el)return {__error:'没找到余额区'};
  const pills=[...document.querySelectorAll('#tBalSub .bl-row')];
  const h=el.getBoundingClientRect();
  return {rect:h.toJSON(),pills:pills.map(p=>{const b=p.querySelector('b');const br=b?b.getBoundingClientRect():null;return {text:p.textContent,wide:p.classList.contains('bl-wide'),w:Math.round(p.getBoundingClientRect().width),left:Math.round(p.getBoundingClientRect().left),right:Math.round(p.getBoundingClientRect().right),bLeft:br?Math.round(br.left):null,bRight:br?Math.round(br.right):null};})};})()`;

(async () => {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run",
    `--remote-debugging-port=${CDP_PORT}`, "--user-data-dir=" + path.join(TMP, "p"), "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/plugins/${ID}/page` });
    await sleep(3000);
    await ev(cdp, `(()=>{const a=document.querySelector('.tab[data-view="api"]');if(a)a.click();return !!a;})()`);
    await sleep(1200);
    await ev(cdp, `(()=>{const b=document.querySelector('[data-page="api-overview"]');if(b)b.click();return !!b;})()`);
    await sleep(7000);
    const info = await ev(cdp, PROBE);
    if (info && !info.__error) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      const pad = 10, r = info.rect;
      const box = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.min(1240, r.width + pad * 2), height: Math.min(820, r.height + pad * 2) };
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 2 } });
      fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
      console.log(`[pills] 胶囊数=${info.pills.length}`);
      for (const p of info.pills) console.log(`  wide=${p.wide ? "Y" : "n"} w=${p.w} right=${p.right} bLeft=${p.bLeft} bRight=${p.bRight}  "${p.text}"`);
      console.log(`SHOT: ${OUT}`);
    } else {
      console.log("PROBE FAILED:", JSON.stringify(info));
    }
    if (OUT2) {
      await ev(cdp, `(()=>{const el=[...document.querySelectorAll('#providerList .provider-item')].find(x=>x.dataset.provider==='volcengine-coding');if(el)el.click();return !!el;})()`);
      await sleep(3200);
      const det = await ev(cdp, `(()=>{const el=document.getElementById('api-detail');if(!el)return null;const h=el.getBoundingClientRect();return h.toJSON();})()`);
      if (det) {
        const s2 = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, det.x - 6), y: Math.max(0, det.y - 6), width: Math.min(1240, det.width + 12), height: Math.min(880, det.height + 12), scale: 2 } });
        fs.writeFileSync(OUT2, Buffer.from(s2.data, "base64"));
        console.log(`SHOT2: ${OUT2}`);
      } else {
        console.log("SHOT2 skipped: 没找到 api-detail");
      }
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
