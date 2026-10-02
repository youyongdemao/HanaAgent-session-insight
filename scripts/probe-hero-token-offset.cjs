// probe-hero-token-offset.cjs —— 用量总览页「总消耗 Token」大数字的垂直位置实测
// 用法：
//   node scripts/probe-hero-token-offset.cjs <标签> [宽度列表，默认 420,520,760,1100]
//   DPR=1 ...    截图像素与 CSS 像素 1:1，便于跟 ink-scan.cjs 的行号直接对齐（默认 2）
//   BEFORE=1 ... 注入 #kTok{transform:none!important}，重现「那条上提规则被吞掉」的旧状态，做 A/B
// 输出：每个宽度下 b 的 rect、计算 transform、od 盒位移、字形墨迹相对上下两行的净空档；
//      hero 区截图（标签行 → 命中率行）存到 scripts/_shots/。
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = process.env.REPO_DIR || "D:/AI/Hanako/OH-WorkSpace/HanaApp-Dev/session-insight/repo";
const ID = "session-insight";
const OUT = path.join(REPO, "scripts", "_shots");
fs.mkdirSync(OUT, { recursive: true });
const THEME_CSS = (() => { try { const base = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "themes", "midnight.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {} return ""; })();
const HTML = `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
const STATS = { file: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", turns: 40, sessionTokens: 5707644736, sessionCostCny: 128.4, contextPercent: 98, contextWindow: 128000, lastWindowTokens: 126720, remainingToCompact: 1280, sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0, avgHitPercent: 91.2, lastHitPercent: 88.4, series: [], providers: [] };
const LEDGER = {
  ok: true, totalCost: 128.4, totalTokens: 5707644736, calls: 4211, hitAvg: 91.2, errCount: 0,
  days: [{ day: "2026-09-25", tokens: 5707644736, cost: 128.4, calls: 4211, hitAvg: 91.2 }],
  providers: [{ provider: "deepseek", tokens: 5707644736, cost: 128.4, calls: 4211, models: [{ model: "deepseek-v3.2", tokens: 5707644736, calls: 4211 }] }],
  entries: [],
};
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1"), p = u.pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  const json = (o) => send("application/json", JSON.stringify(o));
  if (p === "/theme.css") return send("text/css", THEME_CSS);
  if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
  const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); } res.writeHead(404); return res.end(""); }
  const api = p.startsWith("/api/apps/session-insight-v2/routes/api/") ? p.slice("/api/apps/session-insight-v2/routes/api/".length) : null;
  if (api !== null) {
    if (api === "stats") return json(STATS);
    if (api === "hero-stats") return json({ tokens: 5707644736, totalCost: 128.4, calls: 4211, errors: 0, hitRate: 0.912, firstDay: "2026-08-01" });
    if (api === "ledger-stats") return json(LEDGER);
    if (api === "total-cost") return json({ totalCost: 128.4 });
    if (api === "sessions") return json({ dir: "mock", sessions: [{ name: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 40 }] });
    if (api === "providers") return json({ ok: true, providers: [] });
    if (api === "balance") return json({ ok: true, balances: [], unsupported: [] });
    if (api === "rules") return json({ ok: true });
    if (api === "events") return json({ ok: true, events: [] });
    if (api === "widget-config") return json({ ok: true, on: [], order: [] });
    if (api === "active") return json({ dir: "mock", file: "a.jsonl" });
    return json({ ok: true });
  }
  return json({ ok: true });
});
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { __exception: r.exceptionDetails.text } : r.result?.value; }
const Q = `(()=>{
  const round=n=>Math.round(n*10)/10;
  const b=document.querySelector('#kTok');
  if(!b) return {err:'no #kTok'};
  const cs=getComputedStyle(b);
  const box=b.getBoundingClientRect();
  const probe=document.createElement('span');
  probe.style.cssText='display:inline-block;width:0;height:0;vertical-align:baseline';
  b.appendChild(probe);
  const baseline=probe.getBoundingClientRect().top;
  probe.remove();
  const cv=document.createElement('canvas').getContext('2d');
  cv.font=cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily;
  const mm=cv.measureText('0');
  const label=b.closest('.uh-block')?.querySelector('.uh-label');
  const lr=label?.getBoundingClientRect();
  const hit=document.querySelector('#usage-overview .uh-hit .uh-label');
  const hr=hit?.getBoundingClientRect();
  const ods=[...b.querySelectorAll('.od')];
  let rules=[];
  try{for(const ss of document.styleSheets){let rs;try{rs=ss.cssRules}catch{continue}for(const r of rs){if(r.selectorText&&r.selectorText.indexOf('uh-primary')>=0)rules.push(r.selectorText+'::'+r.style.cssText.slice(0,120));}}}catch{}
  return {
    fs: cs.fontSize, family: cs.fontFamily.slice(0,36), digits: b.style.getPropertyValue('--digits'),
    bTransform: cs.transform, bRect: {t:round(box.top), b:round(box.bottom), h:round(box.height)},
    odCount: ods.length, odH: ods[0]?round(ods[0].getBoundingClientRect().height):null,
    odTransform: ods[0]?ods[0].style.transform:null, odRect0: ods[0]?{t:round(ods[0].getBoundingClientRect().top),b:round(ods[0].getBoundingClientRect().bottom)}:null,
    bClass: b.className, baseline: round(baseline),
    fontAsc: round(mm.fontBoundingBoxAscent), fontDesc: round(mm.fontBoundingBoxDescent),
    inkAsc: round(mm.actualBoundingBoxAscent), inkDesc: round(mm.actualBoundingBoxDescent),
    labelBottom: lr?round(lr.bottom):null, labelTop: lr?round(lr.top):null,
    hitTop: hr?round(hr.top):null, hitBottom: hr?round(hr.bottom):null,
    gapAbove: lr?round(baseline-mm.actualBoundingBoxAscent-lr.bottom):null,
    gapBelow: hr?round(hr.top-(baseline+mm.actualBoundingBoxDescent)):null,
    rules,
  };
})()`;
(async () => {
  await new Promise((r) => srv.listen(8881, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-htok-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9368", "--user-data-dir=" + path.join(TMP, "p"), "--window-size=1400,1200", "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9368/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    const tag = process.argv[2] || "before";
    const DPR = Number(process.env.DPR || 2);
    const widths = (process.argv[3] || "420,520,760,1100").split(",").map(Number);
    for (const w of widths) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 1100, deviceScaleFactor: DPR, mobile: false });
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:8881/api/plugins/${ID}/page` });
      await sleep(2600);
      if (process.env.BEFORE === "1") { await ev(cdp, `(()=>{const st=document.createElement('style');st.textContent='#kTok{transform:none!important}';document.head.appendChild(st);return true;})()`); await sleep(400); }
      const g = await ev(cdp, Q);
      console.log(w + "px  " + JSON.stringify(g));
      const clip = await ev(cdp, `(()=>{const l=document.querySelector('#usage-overview .uh-tok .uh-label'),h=document.querySelector('#usage-overview .uh-hit .uh-label'),hr=document.querySelector('#usage-overview .usage-hero');if(!l||!h||!hr)return null;const a=l.getBoundingClientRect(),c=h.getBoundingClientRect(),d=hr.getBoundingClientRect();return {x:Math.max(0,d.x-6),y:Math.max(0,a.top-8),w:d.width+12,h:(c.bottom-a.top)+16};})()`);
      if (clip && clip.w) {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: DPR } });
        fs.writeFileSync(path.join(OUT, `hero-${tag}-${w}.png`), Buffer.from(shot.data, "base64"));
        fs.writeFileSync(path.join(OUT, `hero-${tag}-${w}.clip.json`), JSON.stringify(clip));
      }
    }
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(300); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
