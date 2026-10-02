// probe-odometer-fade.cjs —— 盘一遍「所有会滚动的数字」上下渐隐（遮罩）还在不在
// 用法：
//   node scripts/probe-odometer-fade.cjs                        # 面板页 surface=page（默认）
//   SURFACE=widget node scripts/probe-odometer-fade.cjs         # 实时用量卡 surface=widget
//   REPO_DIR=...                                                # 换成安装目录，验证装上去的那份
// 原理：转轮的上下渐隐是 odometer() 写在 .od 内联样式里的 linear-gradient 遮罩；
//       CSS 里若有 !important 的 mask-image:none 会把它压掉（比如圆环中心那批），
//       于是滚动时就没有渐隐。本探针把每个转轮宿主的内联遮罩、计算遮罩、是否已静止
//       都列出来，并在页/各子页/各放大详情里巡一遍，最后点名「滚动时没有渐隐」的。
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = process.env.REPO_DIR || "D:/AI/Hanako/OH-WorkSpace/HanaApp-Dev/session-insight/repo";
const ID = "session-insight";
const SURFACE = process.env.SURFACE || "page";
const THEME_CSS = (() => { try { const base = "D:/AI/Hanako/artifacts/renderer"; for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, "themes", "midnight.css"); if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } } catch {} return ""; })();
const HTML = `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="${SURFACE}"><div id="root" data-surface="${SURFACE}"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
let tick = 0;
const stats = () => ({
  file: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", turns: 40 + tick,
  sessionTokens: 5707644736 + tick * 1000, sessionCostCny: 128.4 + tick,
  contextPercent: 60 + (tick % 20), contextWindow: 128000, lastWindowTokens: 126720, remainingToCompact: 1280,
  sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0,
  series: [{ turn: 1, total: 1000, cost: 1e-6, input: 500, output: 400, cacheRead: 100, cacheInc: 0, hit: 90 }],
  providers: [{ provider: "deepseek", tokens: 5707644736, turns: 40, models: [{ model: "deepseek-v3.2", tokens: 5707644736 }] }],
});
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://127.0.0.1").pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  const json = (o) => { tick++; send("application/json", JSON.stringify(o)); };
  if (p === "/theme.css") return send("text/css", THEME_CSS);
  if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
  const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); } res.writeHead(404); return res.end(""); }
  const api = p.startsWith("/api/apps/session-insight-v2/routes/api/") ? p.slice("/api/apps/session-insight-v2/routes/api/".length) : null;
  if (api !== null) {
    if (api === "stats") return json(stats());
    if (api === "hero-stats") return json({ tokens: 5707644736 + tick * 999, totalCost: 128.4 + tick, calls: 4211 + tick, errors: tick % 5, hitRate: 0.9 + (tick % 9) / 100, firstDay: "2026-08-01" });
    if (api === "ledger-stats") return json({ ok: true, totalCost: 128.4 + tick, totalTokens: 5707644736 + tick * 999, calls: 4211 + tick, hitAvg: 90 + (tick % 9), cacheHitAvg: 88 + (tick % 7), errCount: tick % 3, since: "2026-08-01", days: [{ day: "2026-09-25", tokens: 5707644736 + tick * 999, cost: 128, calls: 4211, hitAvg: 91 }], providers: [{ provider: "deepseek", tokens: 5707644736 + tick * 999, cost: 128, calls: 4211, models: [{ model: "deepseek-v3.2", tokens: 1, calls: 2 }] }], entries: [] });
    if (api === "total-cost") return json({ totalCost: 128.4 + tick });
    if (api === "sessions") return json({ dir: "mock", sessions: [{ name: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 40 }, { name: "b.jsonl", title: "会话 B", model: "deepseek-v3.2", size: 1, mtime: Date.now() - 9e5, turns: 12 }] });
    if (api === "providers") return json({ ok: true, providers: [{ id: "deepseek", label: "DeepSeek", ok: true, balances: [{ currency: "CNY", amount: 108.63 - tick }] }] });
    if (api === "balance") return json({ ok: true, balances: [{ provider: "deepseek", currency: "CNY", amount: 108.63 - tick, windows: [{ name: "5 小时窗口", used: 20 + tick, limit: 100, resetAt: Date.now() + 36e5 }] }], unsupported: [], steps: [] });
    if (api === "rules") return json({ ok: true, rules: { warn: 60, crit: 90 } });
    if (api === "pricing") return json({ ok: true, models: { "deepseek-v3.2": { input: 1, output: 2 } } });
    if (api === "events") return json({ ok: true, events: [] });
    if (api === "widget-config") return json({});
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
const SNAP = `(()=>{
  const round=n=>Math.round(n*10)/10;
  const HOSTS=[...document.querySelectorAll('b,strong')].filter(el=>el.querySelector(':scope > .od'));
  const rows=[];
  for(const el of HOSTS){
    const ods=[...el.querySelectorAll(':scope > .od')];
    const od=ods[0];
    const box=od.getBoundingClientRect();
    if(!(box.width>0&&box.height>0)) continue;
    // 把 od-done 暂时摘下 = 假装它正在滚动，看这时候还有没有渐隐
    const had=ods.map(o=>o.classList.contains('od-done'));
    ods.forEach(o=>o.classList.remove('od-done'));
    const cs=getComputedStyle(od);
    const mask=(cs.maskImage||cs.webkitMaskImage||'none');
    const fadeWould=mask!=='none';
    ods.forEach((o,i)=>{if(had[i])o.classList.add('od-done');});
    const elcs=getComputedStyle(el);
    rows.push({
      id: el.id||el.className||el.tagName,
      page: (el.closest('.page')||{}).id || (el.closest('#wDetail')?'wDetail':'卡片'),
      area: el.closest('.w-detail-overlay') ? '放大详情' : (el.closest('.widget') ? '卡片' : '页'),
      fs: elcs.fontSize,
      settled: od.classList.contains('od-done'),
      fadeWould,
      inlineMask: (od.style.maskImage||od.style.webkitMaskImage) ? 'yes' : 'no',
      inRing: !!od.closest('.ring-core,.sprov-ring-core,.model-donut-main,.td-ring-main,.tc-ring-main,.ring-state,.w-share-donut'),
      fadePx: round(box.height*0.06),
      parentDisplay: elcs.display,
    });
  }
  return rows;
})()`;
(async () => {
  await new Promise((r) => srv.listen(8887, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-odf-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9379", "--user-data-dir=" + path.join(TMP, "p"), "--window-size=1200,1000", "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9379/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1100, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:8887/api/plugins/${ID}/page` });
    await sleep(3000);

    const acc = new Map();
    const sample = async () => {
      const rows = await ev(cdp, SNAP);
      if (Array.isArray(rows)) for (const r of rows) {
        const key = r.area + "|" + r.page + "|" + r.id + "|" + r.fs;
        if (!acc.has(key)) acc.set(key, r);
        else { const cur = acc.get(key); cur.fadeWould = cur.fadeWould || r.fadeWould; }
      }
      await sleep(150);
    };
    await sample();
    const pages = await ev(cdp, `[...document.querySelectorAll('.subtab[data-page]')].map(b=>({page:b.dataset.page,view:b.dataset.view||(b.closest('.view')||{}).id}))`);
    for (const pg of pages || []) {
      const ok = await ev(cdp, `(()=>{const vt=document.querySelector('.tab[data-view="'+String('${pg.view}').replace('view-','')+'"]');if(vt)vt.click();const b=document.querySelector('.subtab[data-page="${pg.page}"]');if(!b)return false;b.click();return true;})()`);
      if (!ok) continue;
      await sleep(500); await sample();
    }
    const details = await ev(cdp, `[...document.querySelectorAll('[data-detail]')].map(d=>d.dataset.detail)`);
    for (const d of [...new Set(details || [])]) {
      const ok = await ev(cdp, `(()=>{const el=document.querySelector('[data-detail="${d}"]');if(!el)return false;el.click();return true;})()`);
      if (!ok) continue;
      await sleep(700); await sample();
      await ev(cdp, `(()=>{const c=document.querySelector('[data-detail-close]');if(c)c.click();const ov=document.getElementById('wDetail');if(ov)ov.classList.remove('open');return true;})()`);
      await sleep(250);
    }
    const rows = [...acc.values()];
    console.log(`surface=${SURFACE}  可见转轮 ${rows.length} 处`);
    console.log("区域 / 页 / 环内 / 若滚动会有渐隐 / 静止 / 内联遮罩 / 宿主 / 字号 / 渐隐区px / 父display");
    for (const r of rows.sort((a, b) => (a.area + a.page + a.id).localeCompare(b.area + b.page + b.id))) {
      console.log([r.area, String(r.page).slice(0, 16), r.inRing ? "环" : " ", r.fadeWould ? "渐隐✓" : "渐隐✗", r.settled ? "已静" : "滚中", r.inlineMask, String(r.id).slice(0, 20), r.fs, r.fadePx, r.parentDisplay].join("  "));
    }
    const bad = rows.filter((r) => !r.fadeWould && r.inlineMask === "yes");
    console.log(`\n【滚动时拿不到渐隐的】：${bad.length} 处 -> ${bad.map((r) => `${r.id}(${r.fs})`).join(", ") || "无"}`);
    const noInline = rows.filter((r) => r.inlineMask === "no");
    console.log(`【连内联遮罩都没有的】：${noInline.length} 处 -> ${noInline.map((r) => r.id).join(", ") || "无"}`);
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(200); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
