// shot-model-detail.cjs —— 用真实 CSS 渲染「本会话模型」详情卡（供应商为主项、模型为子项）并截图
// 用法: node scripts/shot-model-detail.cjs [输出png路径]
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const CSS = path.join(REPO, "ui", "assets", "panel-v2.css");
const OUT = process.argv[2] || path.join(REPO, "..", "_model-detail.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8801;

// 与 renderSessionModelDetail 输出同构的示例数据
const PROVS = [
  { provider: "deepseek", tokens: 14_200_000, models: [{ model: "deepseek-v4-pro", tokens: 12_800_000 }, { model: "deepseek-chat", tokens: 1_400_000 }] },
  { provider: "moonshot", tokens: 3_900_000, models: [{ model: "kimi-k3", tokens: 3_900_000 }] },
  { provider: "openai-codex", tokens: 1_200_000, models: [{ model: "gpt-5.2-codex", tokens: 1_200_000 }] },
];

const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const NAME_CN = { deepseek: "DeepSeek", moonshot: "Moonshot", "openai-codex": "ChatGPT Plus / Pro" };
const colors = ["var(--accent)", "#9d5f4d", "#4a6b4a", "#8a78a8", "#b58b4b"];

const total = PROVS.reduce((a, p) => a + p.tokens, 0) || 1;
const rows = PROVS.map((p, i) => {
  const pt = Number(p.tokens) || 0, pct = (pt / total) * 100, color = colors[i % colors.length];
  const models = p.models.slice().sort((a, b) => b.tokens - a.tokens);
  const sub = models.length
    ? `<div class="w-detail-sub">${models.map((m) => { const mt = Number(m.tokens) || 0, mp = (mt / total) * 100; return `<div class="w-detail-sub-row"><i style="--bar:${color}"></i><span>${esc(m.model)}</span><em>${fmtTokens(mt)}</em><b>${mp.toFixed(1)}%</b></div>`; }).join("")}</div>`
    : "";
  return `<div class="card w-detail-item w-detail-provider-item si-rise"><div class="w-detail-item-head"><span>${esc(NAME_CN[p.provider] || p.provider)}</span><b>${pct.toFixed(1)}%</b></div><div class="w-detail-provider-bar"><i style="--pct:${pct.toFixed(2)}%;--bar:${color}"></i></div>${sub}</div>`;
}).join("");

const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/panel-v2.css">
<style>
  /* 模拟宿主主题变量，否则 --accent 等取不到值，颜色对比失真 */
  :root{--accent:#5b8cff;--green:#22c55e;--text:#e6e6e6;--text-light:#f5f5f5;--text-muted:#9aa3ad;--bg:#14161a;--bg-card:#1c1f25;--si-glow:rgba(91,140,255,.25);--si-glass-hi:rgba(255,255,255,.06)}
</style>
</head>
<body data-hana-theme="dark" data-surface="page" style="padding:24px;background:var(--bg)">
<div class="w-detail-overlay open" style="position:static;opacity:1;pointer-events:auto"><div class="w-detail-card card" style="transform:none">
  <div class="w-detail-head"><b>本会话模型</b></div>
  <div class="w-detail-block">${rows}</div>
</div></div>
</body></html>`;

function startServer() {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, "http://127.0.0.1").pathname;
    if (p === "/" || p === "/index.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(HTML); }
    if (p === "/panel-v2.css") { res.writeHead(200, { "Content-Type": "text/css" }); return res.end(fs.readFileSync(CSS)); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(PORT, "127.0.0.1", () => r(srv)));
}
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
async function waitChrome(port, tries = 80) { for (let i = 0; i < tries; i++) { try { return await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-detail-"));
  const srv = await startServer();
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (!fs.existsSync(chromePath)) { console.error("找不到 Chrome"); srv.close(); return; }
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--window-size=1000,900", "--remote-debugging-port=9341", "--user-data-dir=" + path.join(TMP, "profile"), "about:blank"], { stdio: "ignore" });
  try {
    await waitChrome(9341);
    const list = await httpJson("http://127.0.0.1:9341/json/list");
    const page = list.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const c = new CDP(ws);
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    await sleep(1000);
    const clip = (await c.send("Runtime.evaluate", { expression: `(()=>{const b=document.querySelector('.w-detail-card').getBoundingClientRect();return {x:0,y:0,width:Math.min(1000,b.width+48),height:Math.min(900,b.height+48),scale:2}})()`, returnByValue: true })).result.value;
    const shot = await c.send("Page.captureScreenshot", { format: "png", clip });
    fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
    console.log("已保存: " + OUT + " (" + fs.statSync(OUT).size + " bytes)");
    ws.close();
  } catch (e) {
    console.error("SHOT ERROR:", (e && e.stack) || e);
  } finally {
    proc.kill(); srv.close();
    await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
