// probe-poll-anim.mjs — 临时探针：轮询触发重绘时，页面上到底有没有动画在播
// 用法：node scripts/probe-poll-anim.mjs   （用完即删）

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SELF, "..");
const CSS = fs.readFileSync(path.join(REPO, "assets", "panel-v2.css"));
const PANEL = fs.readFileSync(path.join(REPO, "assets", "panel-v2.js"));
const ID = "session-insight";
const FILE_A = "20260920-231300-deepseek-v3.2.jsonl";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

function makeServer(port) {
  let tick = 0;
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, "http://127.0.0.1").pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
    if (p === `/api/plugins/${ID}/assets/panel-v2.css`) return send("text/css", Buffer.from(CSS));
    if (p === `/api/plugins/${ID}/assets/panel-v2.js`) return send("text/javascript", Buffer.from(PANEL));
    if (p.endsWith("/api/stats")) return json({
      file: FILE_A, title: "会话 A", model: "deepseek-v3.2", turns: 18,
      sessionTokens: 2015900, sessionCostCny: 12.34, contextPercent: 42.5,
      sumInput: 1e9, sumOutput: 4e8, sumCacheRead: 6e8, sumReasoning: 0,
      series: Array.from({ length: 12 }, (_, i) => ({ turn: i + 1, total: 60000 + i * 4000, cost: 1.2, input: 40000, output: 20000, cacheHit: 30000, cacheMiss: 10000, reasoning: 0, hitRate: 0.72, latencyMs: 1200 })),
      providers: [{ provider: "deepseek", tokens: 1e9 }],
    });
    if (p.endsWith("/api/active")) return json({ dir: "mock", file: FILE_A });
    if (p.endsWith("/api/sessions")) return json({ dir: "mock", sessions: [{ name: FILE_A, size: 1048576, mtime: 1757000000000, model: "deepseek-v3.2", title: "会话 A" }] });
    if (p.endsWith("/api/ledger-stats")) {
      tick++;
      return json({ days: { "2026-09-19": { tokens: 1215000000, cost: 12.3 }, "2026-09-20": { tokens: 980000000 + tick * 1000, cost: 8.7 + tick * 0.01 } }, calls: 1245 + tick, errors: 3, tokens: { input: 1e9, output: 4e8, cacheHit: 1.1e9, cacheMiss: 2e8, hitRate: 0.846 } });
    }
    if (p.endsWith("/api/total-cost")) return json({ totalCost: 21.03 + tick * 0.01 });
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
  if (r.exceptionDetails) return { __exception: JSON.stringify(r.exceptionDetails).slice(0, 600) };
  return r.result?.value;
}

const SCRIPT = `(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const t0=performance.now();
  const root=document.querySelector('#root')||document.body;
  const samples=[];
  for(let i=0;i<150;i++){
    const anims=document.getAnimations().filter(a=>a.playState==='running').map(a=>{
      const tg=a.effect&&a.effect.target;
      const cls=tg&&typeof tg.className==='string'?tg.className.split(/\\s+/).slice(0,3).join('.'):'';
      return (a.animationName||'?')+'@'+((tg&&tg.tagName)||'?').toLowerCase()+(cls?'.'+cls:'');
    });
    samples.push({t:Math.round(performance.now()-t0),
      quiet:root.classList.contains('si-quiet'),
      rootCls:root.className,
      running:anims.length, names:[...new Set(anims)].slice(0,6),
      bodyOpacity:getComputedStyle(document.body).opacity,
      shellOpacity:(()=>{const s=document.querySelector('.shell');return s?getComputedStyle(s).opacity:'-';})()});
    await sleep(160);
  }
  // 只保留「有动画」或「si-quiet/shell 透明度变化」的采样点
  const out=[];let prev=null;
  for(const s of samples){
    const k=JSON.stringify([s.running,s.names,s.quiet,s.shellOpacity,s.bodyOpacity]);
    if(k!==prev){out.push(s);prev=k;}
  }
  return {total:samples.length, points:out, maxRunning:Math.max(...samples.map(s=>s.running)),
    quietFrames:samples.filter(s=>s.quiet).length};
})()`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "si-an-"));
  let r = null;
  try {
    const srv = await makeServer(8881);
    const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--remote-debugging-port=9411", "--user-data-dir=" + path.join(tmp, "chrome"), "about:blank"], { stdio: "ignore" });
    try {
      await waitChrome(9411);
      const list = await httpJson("http://127.0.0.1:9411/json/list");
      const page = list.find((t) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r2, j) => { ws.addEventListener("open", r2); ws.addEventListener("error", j); });
      const c = new CDP(ws);
      await c.send("Page.enable"); await c.send("Runtime.enable");
      await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
      await c.send("Page.navigate", { url: `http://127.0.0.1:8881/api/plugins/${ID}/page` });
      await sleep(400);
      r = await ev(c, SCRIPT);
      ws.close();
    } finally { proc.kill(); srv.close(); }
  } catch (e) { console.error("ERR", (e && e.stack) || e); }
  finally { await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }

  if (!r) return;
  if (r.__exception) return console.log("EXC", r.__exception);
  console.log("采样点:", r.total, " 同时运行动画峰值:", r.maxRunning, " si-quiet 帧数:", r.quietFrames);
  console.log("--- 变化点 ---");
  for (const p of r.points) {
    console.log(`t=${String(p.t).padStart(5)}ms  running=${p.running}  quiet=${p.quiet}  shellOpacity=${p.shellOpacity}  names=${JSON.stringify(p.names)}`);
  }
})();
