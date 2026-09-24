// css-rule-audit.cjs —— CSS「死规则」体检：文件里写了的规则，浏览器里是不是真的存在
// 用法：node scripts/css-rule-audit.cjs
// 为什么要它：CSS 里多一个右花括号，Blink 会把紧跟着的下一条规则整条吞掉，
// 而这条规则在文件里看着好好的，肉眼和 diff 都发现不了。2026-09-25 的
// 「总消耗 Token 大数字没上提」就是这么来的（多了一个 }，#usage-overview .uh-primary b 的
// 那条 transform 从未生效）。顺手也给整份文件做花括号配平检查。
// 输出：花括号配平结果、命中 .uh-primary 的规则、文件里有但 CSSOM 里找不到的选择器。
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, "..");
const ID = "session-insight";
const CSS_PATH = path.join(REPO, "ui", "assets", "panel-v2.css");
const HTML = `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, "http://127.0.0.1").pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
  const m = p.match(new RegExp(`^/api/plugins/${ID}/assets/(.+)$`));
  if (m) { const f = path.join(REPO, "ui", "assets", m[1]); if (fs.existsSync(f)) { const e = path.extname(f).toLowerCase(); return send(e === ".css" ? "text/css" : "text/javascript", fs.readFileSync(f)); } res.writeHead(404); return res.end(""); }
  send("application/json", JSON.stringify({ ok: true }));
});
const httpJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); } send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); } }
(async () => {
  const cssText = fs.readFileSync(CSS_PATH, "utf8");
  const open = (cssText.match(/\{/g) || []).length, close = (cssText.match(/\}/g) || []).length;
  const balance = open - close;
  // 逐行深度：找出深度降到 0 以下的第一行 —— 多出来的右花括号就在这里
  let depth = 0, firstBad = null;
  cssText.split(/\r?\n/).forEach((l, i) => { depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length; if (depth < 0 && firstBad == null) firstBad = i + 1; });
  console.log(`花括号  open=${open} close=${close} 差=${balance}` + (firstBad ? `（第 ${firstBad} 行起出现多余的 }）` : "（配平）"));

  await new Promise((r) => srv.listen(8883, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-css-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9375", "--user-data-dir=" + path.join(TMP, "p"), "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9375/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:8883/api/plugins/${ID}/page` });
    await sleep(2500);
    const expr = `(()=>{
      const out={ruleCount:0, sels:[]};
      for(const ss of document.styleSheets){let rs;try{rs=ss.cssRules}catch{continue}for(const r of rs){
        if(r.selectorText){ out.ruleCount++; out.sels.push(r.selectorText.replace(/\\s+/g,'')); }
        else if(r.cssRules){ for(const r2 of r.cssRules){ if(r2.selectorText){ out.ruleCount++; out.sels.push(r2.selectorText.replace(/\\s+/g,'')); } } }
      }}
      return out;
    })()`;
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    const v = r.result?.value || { sels: [], ruleCount: 0 };
    // Chrome 规范化时会把通配符去掉：`>*:not(...)` 变成 `>:not(...)`，`*::x` 变成 `::x`
    const norm = (s) => s.replace(/\s+/g, "").replace(/>\*/g, ">").replace(/\+\*/g, "+").replace(/~\*/g, "~").replace(/^\*/, "").trim();
    const cssomBlob = (v.sels || []).map(norm).join(",");
    // 用「子串命中」判定存在：CSS 里带括号的复杂选择器列表经 Chrome 规范化后
    // 可能与文件里的写法分段不同，精确相等会产生假阳性。
    const inCssom = (key) => cssomBlob.indexOf(key) >= 0;
    const missing = [];
    const fileSels = [];
    // 先把注释去掉，再按字符扫「{」收集选择器：这样跨行写的选择器也能完整拿到
    const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
    let buf = "";
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === "{") {
        const sel = buf.trim();
        if (sel && !sel.startsWith("@")) {
          for (const one of sel.split(",")) {
            const key = norm(one);
            if (!key) continue;
            // @keyframes 里的 from / to / 50% 不是选择器，CSSOM 也不当规则报，跳过
            if (/^(from|to|\d+(?:\.\d+)?%)$/.test(key)) continue;
            fileSels.push(key);
            if (!inCssom(key)) missing.push(key);
          }
        }
        buf = "";
        continue;
      }
      if (ch === "}") { buf = ""; continue; }
      buf += ch;
    }
    console.log(`CSSOM 里共 ${v.ruleCount} 条规则；文件里有、CSSOM 里没有的选择器：${missing.length} 条`);
    if (process.env.DEBUG) {
      console.log("CSSOM 前 8 条：" + JSON.stringify(v.sels.slice(0, 8)));
      console.log("文件侧前 8 条：" + JSON.stringify(fileSels.slice(0, 8)));
      console.log("CSSOM 含 html 的：" + JSON.stringify(v.sels.filter((s) => s.indexOf("html") >= 0).slice(0, 5)));
    }
    missing.slice(0, 25).forEach((s) => console.log("  ✗ " + s.slice(0, 120)));
    const probe = process.argv[2];
    if (probe) {
      console.log(`\nCSSOM 里含「${probe}」的选择器：`);
      v.sels.filter((s) => s.indexOf(probe) >= 0).forEach((s) => console.log("  · " + s.slice(0, 140)));
    }
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(200); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
