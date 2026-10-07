// probe-launch-dedupe.cjs —— 本地供应商「启动」按钮重复堆积的回归探针
//
// 复现的毛病：详情页每重绘一次就会异步问一次 /api/local-providers，回调自己去往
// #pdQuick 里 append 按钮。短时间内多次重绘（同一帧里连点 8 次供应商卡就够），
// 每个回调都往容器里塞一个，头部就堆出一排同样的「启动 Ollama」。
//
// 判定：连点 8 次后，#pdQuick 里的 .pd-launch 必须恰好 1 个；同时后端被问到的次数
//       也不该随重绘次数线性上涨（前端有 TTL 缓存 + 单飞）。
//
// 用法：
//   node scripts/probe-launch-dedupe.cjs                       # 测当前工作区源码
//   node scripts/probe-launch-dedupe.cjs --rev=HEAD            # 测某个 git 版本（对比修复前）
//   node scripts/probe-launch-dedupe.cjs --js=<path/to.js>     # 测指定文件
//   node scripts/probe-launch-dedupe.cjs --shot=<out.png>      # 顺手截详情页头部
//   node scripts/probe-launch-dedupe.cjs --zoom=<out.png>      # 头部左侧一截放大截图（对比用）
//   node scripts/probe-launch-dedupe.cjs --frame=<out.png>     # 从头部往下取一块区域截图（含下方内容，比例正常）
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO = path.resolve(__dirname, "..");
const ID = "session-insight";
const ARGV = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
// 指定 git 版本时，把那一版的 panel-v2.js 拉到临时目录再喂给页面（对比修复前后用）
const PANEL_OVERRIDE = ARGV.js ? path.resolve(ARGV.js) : (ARGV.rev
  ? (() => {
      const f = path.join(require("os").tmpdir(), `si-panel-${String(ARGV.rev).replace(/[^0-9a-zA-Z_.-]/g, "")}.js`);
      require("child_process").execFileSync("git", ["show", `${ARGV.rev}:ui/assets/panel-v2.js`], { cwd: path.resolve(__dirname, ".."), maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", require("fs").openSync(f, "w"), "inherit"] });
      return f;
    })()
  : null);
const SHOT = ARGV.shot ? path.resolve(ARGV.shot) : null;
const PORT = Number(ARGV.port || 8893);
const CDP_PORT = Number(ARGV.cdp || 9373);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-launch-"));

const LOCAL_PROVIDERS = {
  providers: [{
    id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1",
    program: "C:\\Users\\Tester\\AppData\\Local\\Programs\\Ollama\\ollama app.exe", source: "preset",
  }],
};
const PROVIDERS = {
  providers: [{
    id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", local: true,
    links: [], launch: { label: "启动 Ollama", port: 11434 }, view: "token", models: [],
  }],
};
const BALANCE = {
  balances: [],
  unsupported: [{ provider: "ollama", note: "无官方余额接口", reachable: false }],
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

let listHits = 0;                  // 后端 /api/local-providers 被问到的次数
const send = (res, t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
const json = (res, o) => send(res, "application/json", JSON.stringify(o));

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1"), p = u.pathname;
  if (p === "/theme.css") return send(res, "text/css", THEME);
  if (p === `/api/plugins/${ID}/page`) return send(res, "text/html; charset=utf-8", HTML);
  const asset = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (asset) {
    const f = PANEL_OVERRIDE && asset[1] === "panel-v2.js" ? PANEL_OVERRIDE : path.join(REPO, "ui", "assets", asset[1]);
    if (fs.existsSync(f)) return send(res, path.extname(f).toLowerCase() === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f));
    res.writeHead(404); return res.end("");
  }
  const api = p.startsWith(`/api/apps/session-insight/routes/api/`) ? p.slice(`/api/apps/session-insight/routes/api/`.length) : null;
  if (api === null) return json(res, { ok: true });
  switch (api) {
    case "providers": return json(res, PROVIDERS);
    case "balance": return json(res, BALANCE);
    case "pricing": return json(res, { rows: [], db: { ok: true } });
    case "total-cost": return json(res, { totalCost: 0 });
    case "rules": return json(res, {});
    case "panel-prefs": return json(res, { homeView: "api" });
    case "local-providers":
      // 真机这条要探安装目录、解析 exe，本来就不是瞬时的；这里把延时固定成 600ms，
      // 保证「重绘引发的多次请求」全部落在同一个窗口里，问题才可复现。
      listHits++;
      return setTimeout(() => json(res, LOCAL_PROVIDERS), 600);
    case "launch-provider": return json(res, { running: false, started: false });
    case "ledger-stats":
      return json(res, {
        days: { "2026-10-07": { tokens: 120000, cost: 1.2 } }, calls: 3, errors: 0,
        tokens: { input: 700, output: 300, cacheHit: 200, cacheMiss: 100, hitRate: 0.6 },
        timeBuckets: { hour: [0, 1, 2], day: [1, 2, 3] }, tokenBuckets: { hour: [10, 20, 30], day: [100, 200, 300] },
      });
    case "stats": return json(res, { file: "a.jsonl", title: "会话 A", model: "deepseek-flash", turns: 1, series: [], providers: [] });
    case "active": return json(res, { file: "a.jsonl" });
    case "sessions": return json(res, { sessions: [], count: 0 });
    case "events": return json(res, { events: [] });
    default: return json(res, { ok: true });
  }
});

function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) { const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { __exception: r.exceptionDetails.text } : r.result?.value; }

// 同一帧里连点 8 次供应商卡：每次 showProvider 都会重绘详情页，
// 修复前 = 8 次重绘 × 各自异步回调 append；修复后 = 只剩最新一代能落笔。
const BURST = `(()=>{const el=[...document.querySelectorAll('#providerList .provider-item[data-provider]')].find(x=>x.dataset.provider==='ollama');
  if(!el)return {__error:'找不到 ollama 卡片'};
  for(let i=0;i<8;i++)el.click();
  return {clicked:8};})()`;
const COUNT = `(()=>{const host=document.getElementById('pdQuick');
  if(!host)return {__error:'没有 #pdQuick'};
  const btn=[...host.querySelectorAll('.pd-launch')];
  return {count:btn.length,texts:btn.map(b=>b.textContent),labels:btn.map(b=>b.dataset.launch),
    quick:host.textContent, head:document.querySelector('#api-detail .d-head')?document.querySelector('#api-detail .d-head').getBoundingClientRect().toJSON():null,
    diag:(document.getElementById('si-diag')||{}).textContent||null};})()`;

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
    if (process.env.SI_PROBE_VERBOSE) console.log("[probe] chrome 已连上");
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/plugins/${ID}/page` });
    await sleep(2600);
    if (process.env.SI_PROBE_VERBOSE) console.log("[probe] 页面已加载，点 API 标签");
    await ev(cdp, `(()=>{const a=document.querySelector('.tab[data-view="api"]');if(a)a.click();return !!a;})()`);
    await sleep(1200);
    await ev(cdp, `(()=>{const b=document.querySelector('[data-page="api-overview"]');if(b)b.click();return !!b;})()`);
    await sleep(1500);
    if (process.env.SI_PROBE_VERBOSE) console.log("[probe] 连点供应商卡");
    const burst = await ev(cdp, BURST);
    await sleep(2600);
    const after = await ev(cdp, COUNT);
    if (process.env.SI_PROBE_VERBOSE) console.log("[probe] 第一轮计数完成", JSON.stringify(after && after.count));
    if (process.env.SI_PROBE_DEADLINE && Date.now() > Number(process.env.SI_PROBE_DEADLINE)) throw new Error("超过内部时限");
    const hitsAfterBurst = listHits;
    // 再点一次，确认新鲜渲染也只落一个按钮
    await ev(cdp, BURST.replace("for(let i=0;i<8;i++)", "for(let i=0;i<3;i++)"));
    await sleep(2000);
    const second = await ev(cdp, COUNT);
    if (SHOT && after && after.head) {
      const pad = 12, h = after.head;
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, h.x - pad), y: Math.max(0, h.y - pad), width: h.width + pad * 2, height: h.height + pad * 2, scale: 2 } });
      fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
    }
    // 取景截图：从头部左上角往下取一块固定区域（含头部行 + 下方详情内容）。
    // 只用 d-head 本身的话，那是一条 21:1 的细条，放进卡片里几乎看不清。
    if (ARGV.frame && after && after.head) {
      const h = after.head;
      const box = { x: Math.max(0, h.x - 8), y: Math.max(0, h.y - 10), width: h.width + 16, height: 0 };
      box.height = Math.max(120, Math.min(360, 900 - box.y));
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 2 } });
      fs.writeFileSync(path.resolve(ARGV.frame), Buffer.from(shot.data, "base64"));
      if (process.env.SI_PROBE_VERBOSE) console.log(`[probe] 取景截图 = ${ARGV.frame} (${Math.round(box.width)}×${Math.round(box.height)} css)`);
    }
    // 放大截图：只取头部左侧一截并放大，按钮上的字才看得清
    if (ARGV.zoom && after && after.head) {
      const h = after.head, w = Math.min(Number(ARGV.zoomWidth || 1000), Math.max(200, h.width));
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, h.x), y: Math.max(0, h.y), width: w, height: h.height, scale: 2.5 } });
      fs.writeFileSync(path.resolve(ARGV.zoom), Buffer.from(shot.data, "base64"));
      if (process.env.SI_PROBE_VERBOSE) console.log(`[probe] 放大截图 = ${ARGV.zoom} (${w}×${Math.round(h.height)} css @2.5x)`);
    }
    console.log(`源文件 = ${PANEL_OVERRIDE || path.join(REPO, "ui", "assets", "panel-v2.js")}`);
    console.log(`连点 = ${JSON.stringify(burst)}`);
    console.log(`连点 8 次后 .pd-launch 数量 = ${after && after.count}   文案 = ${JSON.stringify(after && after.texts)}`);
    console.log(`再连点 3 次后 .pd-launch 数量 = ${second && second.count}`);
    console.log(`后端 /api/local-providers 累计被问 = ${listHits}（连点 8 次那轮结束时 = ${hitsAfterBurst}）`);
    if (after && after.diag) console.log(`页面诊断 = ${after.diag}`);
    const ok = after && after.count === 1 && second && second.count === 1;
    console.log(`判定：${ok ? "PASS（头部只有一个启动按钮）" : "FAIL（按钮数量不为 1）"}`);
    if (SHOT) console.log(`SHOT: ${SHOT}`);
    ws.close();
  } catch (e) {
    console.error("PROBE ERROR:", (e && e.stack) || e);
  } finally {
    proc.kill(); srv.close(); await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
