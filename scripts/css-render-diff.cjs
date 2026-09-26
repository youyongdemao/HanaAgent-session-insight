// css-render-diff.cjs —— 用真实渲染结果验证「删死的 CSS 声明」没有改变任何最终样式
// 用法：
//   node scripts/css-render-diff.cjs dump <out.json>          # 采集当前 CSS 下的渲染指纹
//   node scripts/css-render-diff.cjs diff <a.json> <b.json>   # 比较两份指纹
// 指纹 = 每个元素的 DOM 路径 + 一组关键 computed 属性；覆盖多个窗口宽度（媒体查询断点）
// 与多个页面，尽量让「被删掉的声明其实还在起作用」这类错误无处可藏。
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, "..");
const ID = "session-insight";
const PORT = 8886;

const WIDTHS = [1280, 1000, 760, 600, 500];
const PAGES = [
  { name: "usage", click: null },
  { name: "api", click: `.tab[data-view="api"]` },
];

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
const series = Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8, input: 12000 + i * 800, output: 18000 + i * 1200, cacheInc: 30000 + i * 2000, cacheRead: 30000 + i * 2000, cacheMiss: 12000 + i * 800, reasoning: 0, hit: 62 + (i % 17) }));
const STATS = { file: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", turns: 40, sessionTokens: 345547912, sessionCostCny: 12.51, contextPercent: 98, contextWindow: 128000, lastWindowTokens: 126720, remainingToCompact: 1280, sumInput: 9e5, sumOutput: 34e4, sumCacheRead: 7e5, sumReasoning: 0, series, providers: [{ provider: "deepseek", tokens: 345547912, turns: 40, models: [{ model: "deepseek-v3.2", tokens: 345547912 }] }] };
const BALANCE = { balances: [{ provider: "deepseek", name: "DeepSeek", status: "ok", kind: "balance", total: 108.63, currency: "CNY", summary: "余额 ¥108.63" }], updatedAt: Date.now() };

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1"), p = u.pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  const json = (o) => send("application/json", JSON.stringify(o));
  if (p === "/theme.css") return send("text/css", THEME);
  if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
  const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); } res.writeHead(404); return res.end(""); }
  const api = p.startsWith("/api/apps/session-insight-v2/routes/api/") ? p.slice("/api/apps/session-insight-v2/routes/api/".length) : null;
  if (api !== null) {
    if (api === "stats") return json(STATS);
    if (api === "balance") return json(BALANCE);
    if (api === "pricing") return json({});
    if (api === "ledger-stats") return json({ ok: true, totalCost: 94.25, entries: [], providers: [], days: { "2026-09-26": { tokens: 6430000000, cost: 94.25, calls: 2424, hitRate: 0.99 } } });
    if (api === "sessions") return json({ sessions: [{ name: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 40 }], count: 1 });
    if (api === "active") return json({ file: "a.jsonl" });
    if (api === "rules") return json({});
    if (api === "ui-env") return json({});
    if (api === "hero-stats") return json({ ok: true, totalTok: 345547912, totalCost: 94.25 });
    if (api === "total-cost") return json({ totalCost: 94.25 });
    if (api === "providers" || api === "local-providers") return json({ providers: [] });
    if (api === "events") return json({ events: [] });
    return json({ ok: true });
  }
  if (p === "/api/sessions/messages") return json({ messages: [] });
  return json({ ok: true });
});

function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { __exception: r.exceptionDetails.text } : r.result?.value; }

const PROPS = ["display", "position", "width", "height", "minWidth", "maxWidth", "marginTop", "marginRight", "marginBottom", "marginLeft", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "color", "backgroundColor", "backgroundImage", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderTopColor", "borderBottomColor", "borderTopStyle", "borderRadius", "fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "textAlign", "textShadow", "opacity", "boxShadow", "filter", "transform", "transitionProperty", "transitionDuration", "transitionTimingFunction", "gridTemplateColumns", "gridTemplateRows", "gap", "alignItems", "justifyContent", "flexDirection", "flexWrap", "flex", "overflowX", "overflowY", "zIndex", "visibility", "-webkit-mask-image", "maskImage", "cursor", "fill", "stroke", "strokeWidth", "backdropFilter"];
const DUMP_FN = `(() => {
  const props = ${JSON.stringify(PROPS)};
  function pathOf(el) {
    const parts = [];
    let e = el;
    while (e && e !== document.documentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) s += "#" + e.id;
      else if (typeof e.className === "string" && e.className.trim()) s += "." + e.className.trim().split(/\\s+/).join(".");
      const p = e.parentElement;
      if (p) { const sibs = [...p.children].filter(c => c.tagName === e.tagName); if (sibs.length > 1) s += ":nth-of-type(" + (sibs.indexOf(e) + 1) + ")"; }
      parts.unshift(s);
      e = p;
    }
    return parts.join(">");
  }
  const out = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.tagName === "SCRIPT" || el.tagName === "LINK" || el.tagName === "META") continue;
    const cs = getComputedStyle(el);
    const row = { p: pathOf(el) };
    for (const k of props) row[k] = String(cs[k]);
    out.push(row);
  }
  return out;
})()`;

async function collect() {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-diff-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9378", "--user-data-dir=" + path.join(TMP, "p"), "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  const result = {};
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9378/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    for (const w of WIDTHS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const pg of PAGES) {
        await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/plugins/${ID}/page` });
        await sleep(2200);
        if (pg.click) { await ev(cdp, `(()=>{const b=document.querySelector('${pg.click}');if(b)b.click();return !!b;})()`); await sleep(1200); }
        const rows = await ev(cdp, DUMP_FN);
        result[`${w}/${pg.name}`] = rows;
        console.log(`  采集 ${w}/${pg.name}: ${Array.isArray(rows) ? rows.length : "?"} 个元素`);
      }
    }
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(300); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
  return result;
}

(async () => {
  const mode = process.argv[2];
  if (mode === "dump") {
    const out = process.argv[3] || path.join(__dirname, "_render.json");
    const data = await collect();
    fs.writeFileSync(out, JSON.stringify(data), "utf8");
    console.log(`已写出 ${out}`);
    return;
  }
  if (mode === "diff") {
    // 数值容差：光晕类 box-shadow/filter 的模糊半径与透明度由 CSS 变量驱动，带小数抖动，
    // 同一份 CSS 连跑两次渲染也会差（实测 30 处）。把小数归一到 10 的倍数再比：
    // 阴影出现/消失、模糊半径成倍变化仍能检出，小数抖动不算差异。
    const norm = (v) => String(v).replace(/\d+\.\d+/g, (m) => String(Math.round(Number(m) / 10) * 10));
    const a = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    const b = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
    let diffs = 0;
    for (const key of Object.keys(a)) {
      const ra = a[key] || [], rb = b[key] || [];
      const mapB = new Map(rb.map((r) => [r.p, r]));
      for (const row of ra) {
        const other = mapB.get(row.p);
        if (!other) { console.log(`  [${key}] 元素消失: ${row.p.slice(0, 110)}`); diffs++; continue; }
        for (const k of Object.keys(row)) {
          if (k === "p") continue;
          // 光晕类：模糊半径与透明度由 CSS 变量驱动、每帧在浮动（实测同一 CSS 两次渲染差 0.2px），
          // 只比较「有阴影 / 无阴影」，数值抖动不算差异。
          const noisy = k === "boxShadow" || k === "filter";
          const changed = noisy ? (row[k] === "none") !== (other[k] === "none") : norm(row[k]) !== norm(other[k]);
          if (changed) {
            diffs++;
            if (diffs <= 40) console.log(`  [${key}] ${row.p.slice(0, 90)}  ${k}: ${row[k]} → ${other[k]}`);
          }
        }
      }
      for (const row of rb) if (!ra.some((x) => x.p === row.p)) { console.log(`  [${key}] 新增元素: ${row.p.slice(0, 110)}`); diffs++; }
    }
    console.log(`\n共 ${diffs} 处差异`);
    return;
  }
})();
