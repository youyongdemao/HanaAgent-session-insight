// probe-poll-jump.mjs — 验证「10s 轮询跳动」与「滚动渐隐」两项
//
// 对照两组：
//   BEFORE = git HEAD 版本（修复前）
//   AFTER  = 工作区版本（修复后）
// mock 数据全程恒定，只测「轮询会不会自己闹出重绘」这一件事，不受真实数据变化干扰。
//
// 同时采样首屏滚动期间 .od 的遮罩状态，验证：
//   滚动进行中应有上下渐隐（mask=gradient、无 .od-done），滚动结束才摘掉。
//
// 用法：node scripts/probe-poll-jump.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SELF, "..");
const CSS = fs.readFileSync(path.join(REPO, "assets", "panel-v2.css"));
const AFTER = fs.readFileSync(path.join(REPO, "assets", "panel-v2.js"));
let BEFORE = null;
try { BEFORE = execSync("git show HEAD:assets/panel-v2.js", { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }); } catch (e) { BEFORE = AFTER; }

const ID = "session-insight";
const FILE_A = "20260920-231300-deepseek-v3.2.jsonl";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

const mkStats = () => ({
  file: FILE_A, title: "会话 A", model: "deepseek-v3.2", turns: 18,
  sessionTokens: 2015900, sessionCostCny: 12.34, contextPercent: 42.5,
  sumInput: 1e9, sumOutput: 4e8, sumCacheRead: 6e8, sumReasoning: 0,
  series: Array.from({ length: 12 }, (_, i) => ({ turn: i + 1, total: 60000 + i * 4000, cost: 1.2, input: 40000, output: 20000, cacheHit: 30000, cacheMiss: 10000, reasoning: 0, hitRate: 0.72, latencyMs: 1200 })),
  providers: [{ provider: "deepseek", tokens: 1e9 }],
});

function makeServer(port, panelJs) {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, "http://127.0.0.1").pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
    if (p === `/api/plugins/${ID}/assets/panel-v2.css`) return send("text/css", Buffer.from(CSS));
    if (p === `/api/plugins/${ID}/assets/panel-v2.js`) return send("text/javascript", panelJs);
    if (p.endsWith("/api/stats")) return json(mkStats());
    if (p.endsWith("/api/active")) return json({ dir: "mock", file: FILE_A });
    if (p.endsWith("/api/sessions")) return json({ dir: "mock", sessions: [{ name: FILE_A, size: 1048576, mtime: 1757000000000, model: "deepseek-v3.2", title: "会话 A" }] });
    if (p.endsWith("/api/ledger-stats")) return json({ days: { "2026-09-19": { tokens: 1215000000, cost: 12.3 }, "2026-09-20": { tokens: 980000000, cost: 8.7 } }, calls: 1245, errors: 3, tokens: { input: 1e9, output: 4e8, cacheHit: 1.1e9, cacheMiss: 2e8, hitRate: 0.846 } });
    if (p.endsWith("/api/total-cost")) return json({ totalCost: 21.03 });
    if (p.endsWith("/api/rules")) return json({});
    if (p.endsWith("/api/providers")) return json({ providers: [] });
    if (p.endsWith("/api/events")) return json({ events: [] });
    if (p.endsWith("/api/balance")) return json({ balances: [], updatedAt: 1757000000000 });
    if (p.endsWith("/api/pricing")) return json({ models: [], updatedAt: 1757000000000 });
    if (p.endsWith("/api/appearance")) return json({ theme: "midnight" });
    if (p === "/api/sessions/messages") return json({ messages: [] });
    return json({ ok: true });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

const httpJson = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); });
async function waitChrome(port, tries = 80) { for (let i = 0; i < tries; i++) { try { return await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exception: JSON.stringify(r.exceptionDetails).slice(0, 800) };
  return r.result?.value;
}

const SCRIPT = `(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const t0=performance.now();
  const root=document.querySelector('#root')||document.body;
  let child=0,attr=0;
  const obs=new MutationObserver(ms=>{for(const m of ms){if(m.type==='childList')child++;else attr++;}});
  obs.observe(root,{childList:true,subtree:true,attributes:true});
  // 首屏滚动期：采样第一个 .od 的遮罩状态
  const masks=[];
  for(let i=0;i<28;i++){
    const od=document.querySelector('#usage-overview .od');
    if(od){const cs=getComputedStyle(od);
      masks.push({t:Math.round(performance.now()-t0),done:od.classList.contains('od-done'),
        mask:((cs.webkitMaskImage||cs.maskImage||'none')==='none')?'none':'gradient'});}
    await sleep(100);
  }
  const shot=()=>{const q=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();
      return [Math.round(b.y*10)/10,Math.round(b.height*10)/10];};
    return JSON.stringify([q('#usage-overview .usage-hero'),q('#usage-overview .uh-mini'),q('#usage-overview .uh-block')]);};
  const geos=[];for(let i=0;i<44;i++){geos.push({t:Math.round(performance.now()-t0),g:shot()});await sleep(250);}
  obs.disconnect();
  const uniq=[];let prev=null;for(const x of geos){if(x.g!==prev){uniq.push(x);prev=x.g;}}
  return {child,attr,masks,geoChanges:uniq,odCount:document.querySelectorAll('#usage-overview .od').length};
})()`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "si-pj-"));
  const results = [];
  try {
    const srvB = await makeServer(8861, BEFORE);
    const srvA = await makeServer(8862, AFTER);
    const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--remote-debugging-port=9391", "--user-data-dir=" + path.join(tmp, "chrome"), "about:blank"], { stdio: "ignore" });
    try {
      await waitChrome(9391);
      const list = await httpJson("http://127.0.0.1:9391/json/list");
      const page = list.find((t) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r2, j) => { ws.addEventListener("open", r2); ws.addEventListener("error", j); });
      const c = new CDP(ws);
      await c.send("Page.enable"); await c.send("Runtime.enable");
      await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const [tag, port] of [["BEFORE(HEAD 修复前)", 8861], ["AFTER(工作区 修复后)", 8862]]) {
        await c.send("Page.navigate", { url: `http://127.0.0.1:${port}/api/plugins/${ID}/page` });
        await sleep(400);
        const r = await ev(c, SCRIPT);
        results.push([tag, r]);
      }
      ws.close();
    } finally { proc.kill(); srvB.close(); srvA.close(); }
  } catch (e) { console.error("ERR", (e && e.stack) || e); }
  finally { await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }

  for (const [tag, r] of results) {
    console.log(`\n================ ${tag} ================`);
    if (!r || r.__exception) { console.log("EXC", r && r.__exception); continue; }
    console.log("  13.5s 内 DOM 变更: childList=" + r.child + "  attributes=" + r.attr + "   .od 数=" + r.odCount);
    console.log("  几何变化点:");
    for (const g of r.geoChanges) console.log("     t=" + g.t + "ms  " + g.g);
    console.log("  首屏滚动期遮罩采样（t / 是否已 done / mask）:");
    const line = r.masks.map((m) => m.t + (m.done ? "·done" : "·live") + "·" + m.mask);
    console.log("     " + line.join("  "));
  }
})();
