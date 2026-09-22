// probe-theme-sync.cjs —— 「跟随宿主窗口主题」这条路径的回归探针
// 用法: node scripts/probe-theme-sync.cjs
// 造一个同源的 父页面 + iframe 场景（就是宿主窗口 + 设置页 iframe 的结构），
// 父页面的 :root 上写主题变量，看子页面能不能：① 抄到变量 ② 标出 color-mode
// ③ 父页面换主题后跟着变。全程真实无头 Chrome + CDP，只读 repo 源码。
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const THEME_SYNC = path.join(REPO, "ui", "assets", "theme-sync.js");
const PORT = 8793;

const DARK = { theme: "midnight", bg: "#1b1c1e", card: "#232427", text: "#e8e6e1", accent: "#6fa8c7", font: '"Segoe UI", sans-serif' };
const LIGHT = { theme: "warm-paper", bg: "#F8F4ED", card: "#FCFAF5", text: "#3B3D3F", accent: "#537D96", font: '"Microsoft YaHei", sans-serif' };

const varsCss = (p) =>
  `:root{--bg:${p.bg};--bg-card:${p.card};--text:${p.text};--text-light:${p.text};` +
  `--text-muted:${p.text};--accent:${p.accent};--border:rgba(0,0,0,.1);--green:#4a6b4a;` +
  `--danger:#b5484a;--font-ui:${p.font};--font-mono:Consolas,monospace}`;

const PARENT = `<!doctype html><html data-theme="${DARK.theme}"><head><meta charset="utf-8">
<style>${varsCss(DARK)}</style></head>
<body style="margin:0;background:${DARK.bg}">
<iframe id="f" src="/child.html" style="width:520px;height:320px;border:0"></iframe>
</body></html>`;

const CHILD = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
import { initHostThemeSync } from "/theme-sync.js";
window.__cancel = initHostThemeSync();
</script>
</body></html>`;

// sdk 只作为兜底路径的探针：host-window 生效时它不该被调用
const SDK = `export const hana = { theme: { subscribe(){ window.__sdkSubscribed = true; } } };`;

const READ = `(()=>{
  const f = document.getElementById('f');
  const d = f && f.contentDocument; const r = d && d.documentElement;
  if (!r) return { error: 'no child document' };
  const g = (n) => r.style.getPropertyValue(n);
  return {
    source: r.dataset.themeSource || '',
    theme: r.dataset.theme || '',
    colorMode: r.dataset.colorMode || '',
    diag: f.contentWindow.__themeDiag || '',
    sdkSubscribed: !!f.contentWindow.__sdkSubscribed,
    vars: { bg: g('--bg'), card: g('--bg-card'), text: g('--text'), accent: g('--accent'), font: g('--font-ui'), mono: g('--font-mono') },
  };
})()`;

const SWITCH = `(()=>{
  const r = document.documentElement;
  r.dataset.theme = ${JSON.stringify(LIGHT.theme)};
  r.style.setProperty('--bg', ${JSON.stringify(LIGHT.bg)});
  r.style.setProperty('--bg-card', ${JSON.stringify(LIGHT.card)});
  r.style.setProperty('--text', ${JSON.stringify(LIGHT.text)});
  r.style.setProperty('--accent', ${JSON.stringify(LIGHT.accent)});
  r.style.setProperty('--font-ui', ${JSON.stringify(LIGHT.font)});
  document.body.style.background = ${JSON.stringify(LIGHT.bg)};
  return 'switched';
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, "http://127.0.0.1").pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    if (p === "/parent.html") return send("text/html; charset=utf-8", PARENT);
    if (p === "/child.html") return send("text/html; charset=utf-8", CHILD);
    if (p === "/theme-sync.js") return send("text/javascript", fs.readFileSync(THEME_SYNC));
    if (p === "/sdk.js") return send("text/javascript", SDK);
    res.writeHead(404).end("no");
  });
  return new Promise((r) => srv.listen(PORT, "127.0.0.1", () => r(srv)));
}

function httpJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej);
  });
}
async function waitChrome(port, tries = 80) {
  for (let i = 0; i < tries; i++) { try { return await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { await sleep(300); } }
  throw new Error("chrome 未就绪");
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pend = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    });
  }
  send(m, p = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); });
  }
}
async function ev(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.text };
  return r.result?.value;
}

function check(step, got, want) {
  const ok = got === want;
  console.log(`  ${ok ? "✅" : "❌"} ${step}: ${JSON.stringify(got)}${ok ? "" : "  (期望 " + JSON.stringify(want) + ")"}`);
  return ok;
}

(async () => {
  const srv = await startServer();
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-themeprobe-"));
  if (!fs.existsSync(chromePath)) { console.error("找不到 Chrome: " + chromePath); srv.close(); return; }
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--remote-debugging-port=9337", "--user-data-dir=" + path.join(TMP, "profile"), "about:blank"], { stdio: "ignore" });
  let pass = 0, fail = 0;
  try {
    await waitChrome(9337);
    const list = await httpJson("http://127.0.0.1:9337/json/list");
    const page = list.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const c = new CDP(ws);
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/parent.html` });
    await sleep(1500);

    console.log("\n[第一档] 宿主窗口变量是否被抄过来（初始 = midnight）");
    const a = await ev(c, READ);
    console.log("    diag:", JSON.stringify(a.diag));
    if (check("themeSource", a.source, "host-window")) pass++; else fail++;
    if (check("主题名", a.theme, DARK.theme)) pass++; else fail++;
    if (check("color-mode", a.colorMode, "dark")) pass++; else fail++;
    for (const [k, want] of Object.entries({ bg: DARK.bg, card: DARK.card, text: DARK.text, accent: DARK.accent, font: DARK.font, mono: "Consolas,monospace" })) {
      if (check("--" + k, a.vars[k], want)) pass++; else fail++;
    }
    if (check("host-window 生效时不去订阅 SDK", a.sdkSubscribed, false)) pass++; else fail++;

    console.log("\n[第二档] 宿主换主题后是否跟着变（切到 warm-paper）");
    await ev(c, SWITCH);
    await sleep(1400);
    const b = await ev(c, READ);
    console.log("    diag:", JSON.stringify(b.diag));
    if (check("themeSource", b.source, "host-window")) pass++; else fail++;
    if (check("主题名", b.theme, LIGHT.theme)) pass++; else fail++;
    if (check("color-mode", b.colorMode, "light")) pass++; else fail++;
    for (const [k, want] of Object.entries({ bg: LIGHT.bg, card: LIGHT.card, text: LIGHT.text, accent: LIGHT.accent, font: LIGHT.font })) {
      if (check("--" + k, b.vars[k], want)) pass++; else fail++;
    }

    ws.close();
  } catch (e) {
    console.error("PROBE ERROR:", (e && e.stack) || e);
    fail++;
  } finally {
    proc.kill(); srv.close();
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
