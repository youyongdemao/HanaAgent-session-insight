// ui-probe-session-page.cjs —— 会话页回归探针（真实无头 Chrome + mock 插件 API 对照）
// 用法: node scripts/ui-probe-session-page.cjs [--baseline <git-rev>]
//   默认 baseline = 4d2b68e（2.0.4 发行版），对照组取当前工作区 assets/panel-v2.js
// 三个场景:
//   A 竞态   进入会话页后探测未返回时手选会话 → 最终显示谁
//   B 轮询   手选会话后跨过一次 10s 轮询 → 内容是否被换回默认最新会话、滚动结构是否被破坏
//   C 撞车   让轮询正好落进 1s 滚动窗口 → 滚动是否被打断（硬切）
// 只读 repo 源码，不改任何生产文件；临时副本写在系统临时目录，跑完删除。
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const SELF = __dirname;
const REPO = path.resolve(SELF, "..");
const CSS = path.join(REPO, "assets", "panel-v2.css");
const PANEL = path.join(REPO, "assets", "panel-v2.js");
const ID = "session-insight";
const FILE_A = "20260914-a.jsonl";
const FILE_B = "20260913-b.jsonl";
const HOST_DELAY = 2500; // 模拟宿主 /api/sessions/messages 慢，逼出探测竞态窗口

const argIdx = process.argv.indexOf("--baseline");
const BASELINE_REV = argIdx > -1 ? process.argv[argIdx + 1] : "4d2b68e";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkSeries(n, base) {
  return Array.from({ length: n }, (_, i) => ({
    turn: i + 1, total: base + i * 4200, cost: (base + i * 4200) * 3e-8,
    input: Math.round((base + i * 4200) * 0.7), output: Math.round((base + i * 4200) * 0.3),
    cacheHit: Math.round((base + i * 4200) * 0.55), cacheMiss: Math.round((base + i * 4200) * 0.15),
    reasoning: 0, hitRate: 0.72, latencyMs: 1100,
  }));
}
const A = { file: FILE_A, title: "会话 A 最新", model: "deepseek-v3.2", turns: 18, sessionTokens: 1240000, sessionCostCny: 12.34, contextPercent: 42.5, sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0, series: mkSeries(18, 62000), providers: [{ provider: "deepseek", tokens: 1240000 }] };
const B = { file: FILE_B, title: "会话 B 手选", model: "mimo-v2.5", turns: 9, sessionTokens: 856300, sessionCostCny: 3.07, contextPercent: 18.2, sumInput: 610000, sumOutput: 246300, sumCacheRead: 410000, sumReasoning: 0, series: mkSeries(9, 95000), providers: [{ provider: "mimo", tokens: 856300 }] };
const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="dark" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

function startServer(port, jsPath) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
    if (p === `/api/plugins/${ID}/assets/panel-v2.css`) return send("text/css", fs.readFileSync(CSS));
    if (p === `/api/plugins/${ID}/assets/panel-v2.js`) return send("text/javascript", fs.readFileSync(jsPath));
    if (p === `/api/plugins/${ID}/api/stats`) { const f = u.searchParams.get("file"); return json(!f ? A : f === B.file ? B : A); }
    if (p === `/api/plugins/${ID}/api/active`) return json({ dir: "mock", file: null });
    if (p === `/api/plugins/${ID}/api/resolve-entry`) return json({ file: null });
    if (p === `/api/plugins/${ID}/api/sessions`) return json({ dir: "mock", sessions: [
      { name: A.file, title: A.title, model: A.model, size: 1, mtime: Date.now(), turns: A.turns },
      { name: B.file, title: B.title, model: B.model, size: 1, mtime: Date.now() - 86400000, turns: B.turns },
    ] });
    if (p === `/api/plugins/${ID}/api/ledger-stats`) return json({ days: { "2026-09-14": { tokens: 1240000, cost: 12.34 } }, calls: 120, errors: 1, tokens: { input: 1810000, output: 696300, cacheHit: 1310000, cacheMiss: 500000, hitRate: 0.72 } });
    if (p === `/api/plugins/${ID}/api/total-cost`) return json({ totalCost: 16.62 });
    if (p === `/api/plugins/${ID}/api/rules`) return json({});
    if (p === `/api/plugins/${ID}/api/providers`) return json({ providers: [] });
    if (p === `/api/plugins/${ID}/api/events`) return json({ events: [] });
    if (p === `/api/plugins/${ID}/api/balance`) return json({ balances: [], updatedAt: Date.now() });
    if (p === `/api/plugins/${ID}/api/pricing`) return json({ models: [], updatedAt: Date.now() });
    if (p === "/api/sessions/messages") return setTimeout(() => json({ messages: [] }), HOST_DELAY);
    return json({ ok: true });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
async function waitChrome(port, tries = 80) { for (let i = 0; i < tries; i++) { try { return await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.text };
  return r.result?.value;
}

const HELPERS = `
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const q=s=>document.querySelector(s);
  const info=()=>{const el=q('#sTok');if(!el)return{missing:true};const strip=el.querySelector('.od-strip');return{txt:el.textContent,kids:el.children.length,od:!!el.querySelector(':scope > .od'),tf:strip?strip.style.transform:null};};
  const enterSessionPage=async()=>{const t=q('.subtab[data-page="usage-session"]');t.click();await sleep(100);};
  const pickB=async()=>{q('#sessionTrigger').click();await sleep(120);const it=[...document.querySelectorAll('.session-item')].find(x=>x.dataset.file==='${FILE_B}');if(it)it.click();return !!it;};
`;

const SCENARIO_A = `(async()=>{${HELPERS}
  await enterSessionPage();
  await sleep(900);
  await pickB();
  await sleep(500);
  const rightAfterPick=info();
  await sleep(4000);
  return {scenario:'A 竞态：探测未返回时手选',rightAfterPick,final:{label:q('#sessionTriggerLabel')?.textContent,...info()},expect:'final 应停在 会话 B 手选 / 856.3K'};
})()`;

const SCENARIO_B = `(async()=>{${HELPERS}
  const events=[];
  await enterSessionPage();
  await sleep(4500);
  const settled={label:q('#sessionTriggerLabel')?.textContent,...info()};
  const el0=q('#sTok');
  const obs=new MutationObserver(ms=>{for(const m of ms)events.push({t:Math.round(performance.now()),add:m.addedNodes.length,rm:m.removedNodes.length});});
  if(el0)obs.observe(el0,{childList:true,subtree:true});
  const tPick=Math.round(performance.now());
  await pickB();
  await sleep(200); const m200=info();
  await sleep(300); const m500=info();
  await sleep(600); const m1100=info();
  const rolling=(m200.tf&&m500.tf&&m200.tf!==m500.tf)||(m500.tf&&m1100.tf&&m500.tf!==m1100.tf);
  await sleep(9500);
  const afterPoll={label:q('#sessionTriggerLabel')?.textContent,...info()};
  obs.disconnect();
  return {scenario:'B 轮询：手选后跨过一次轮询',settled,m200,m500,m1100,rolling,afterPoll,
    mutationsDuringAnimation:events.filter(e=>e.t>tPick&&e.t<tPick+1500),
    mutationsAfterAnimation:events.filter(e=>e.t>=tPick+1500),
    expect:'afterPoll 应仍是 会话 B 手选 / 856.3K'};
})()`;

const SCENARIO_C = `(async()=>{${HELPERS}
  const waitUntil=t=>new Promise(r=>{const f=()=>{if(performance.now()>=t)r();else setTimeout(f,20);};f();});
  await enterSessionPage();
  const marks=[];
  try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(String(e.name).includes('/api/stats'))marks.push(e.startTime);}).observe({type:'resource',buffered:true});}catch(e){}
  await sleep(3200);
  const last=marks.length?marks[marks.length-1]:performance.now();
  let target=last+10000-650;
  while(target<performance.now()+900) target+=10000;
  await waitUntil(target);
  const tPick=Math.round(performance.now());
  const el=q('#sTok');
  const evs=[];
  const obs=new MutationObserver(ms=>{for(const m of ms)evs.push({t:Math.round(performance.now()),add:m.addedNodes.length,rm:m.removedNodes.length});});
  obs.observe(el,{childList:true,subtree:true});
  await pickB();
  const samples=[];
  for(let i=0;i<12;i++){await sleep(150);samples.push({dt:Math.round(performance.now())-tPick,od:info().od,tf:info().tf});}
  obs.disconnect();
  return {scenario:'C 轮询撞进 1s 滚动窗口',tPick,expectedPoll:tPick+650,samples,evs:evs.slice(0,20),
    expect:'轮询时刻（约 +650ms）后滚动结构应仍在、变换继续推进到 -8em'};
})()`;

async function run(cdpUrl, ports) {
  const ws = new WebSocket(cdpUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  const c = new CDP(ws);
  await c.send("Page.enable"); await c.send("Runtime.enable");
  const out = {};
  for (const [tag, port] of ports) {
    const res = {};
    for (const [name, script] of [["A", SCENARIO_A], ["B", SCENARIO_B], ["C", SCENARIO_C]]) {
      await c.send("Page.navigate", { url: `http://127.0.0.1:${port}/api/plugins/${ID}/page` });
      await sleep(2600);
      res[name] = await ev(c, script);
    }
    out[tag] = res;
  }
  ws.close();
  return out;
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-uiprobe-"));
  const newJs = path.join(TMP, "panel-new.js");
  const oldJs = path.join(TMP, "panel-baseline.js");
  fs.copyFileSync(PANEL, newJs);
  fs.writeFileSync(oldJs, execSync(`git show ${BASELINE_REV}:assets/panel-v2.js`, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }));

  const srvNew = await startServer(8791, newJs);
  const srvOld = await startServer(8792, oldJs);
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const udd = path.join(TMP, "chrome-profile");
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--remote-debugging-port=9336", "--user-data-dir=" + udd, "about:blank"], { stdio: "ignore" });
  try {
    if (!fs.existsSync(chromePath)) throw new Error("找不到 Chrome: " + chromePath);
    await waitChrome(9336);
    const list = await httpJson("http://127.0.0.1:9336/json/list");
    const page = list.find((t) => t.type === "page");
    const out = await run(page.webSocketDebuggerUrl, [
      [`BASELINE(${BASELINE_REV})`, 8792],
      ["WORKTREE(fixed)", 8791],
    ]);
    for (const [tag, res] of Object.entries(out)) {
      console.log("\n================= " + tag + " =================");
      console.log("  [A 竞态] 点选后立刻:", JSON.stringify(res.A?.rightAfterPick));
      console.log("  [A 竞态] 最终      :", JSON.stringify(res.A?.final));
      console.log("  [B 轮询] 稳定态    :", JSON.stringify(res.B?.settled));
      console.log("  [B 轮询] 200/500/1.1s:", res.B?.m200?.tf, "|", res.B?.m500?.tf, "|", res.B?.m1100?.tf, " rolling=" + res.B?.rolling);
      console.log("  [B 轮询] 轮询后    :", JSON.stringify(res.B?.afterPoll));
      console.log("  [B 轮询] 动画后DOM :", JSON.stringify(res.B?.mutationsAfterAnimation));
      console.log("  [C 撞车] 点选:", res.C?.tPick, "预计轮询:", res.C?.expectedPoll);
      for (const s of (res.C?.samples || [])) console.log("     +" + s.dt + "ms od=" + s.od + " tf=" + s.tf);
      console.log("  [C 撞车] DOM变化:", JSON.stringify(res.C?.evs));
    }
  } catch (e) {
    console.error("PROBE ERROR:", (e && e.stack) || e);
  } finally {
    proc.kill(); srvNew.close(); srvOld.close();
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
