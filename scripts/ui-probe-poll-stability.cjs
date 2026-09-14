// probe-poll-layout.cjs 鈥斺€?瀵圭収楠岃瘉涓や欢浜嬶細
//   L 鏁板€煎彉闀匡紙楼99.90 鈫?楼12345.67锛夋椂锛宧ero/鍗＄墖鍑犱綍鏄惁绋冲畾锛堜笉鎹㈣銆佷笉鎾戝垪锛?//   P 鏁版嵁涓嶅彉鏃讹紝10s 杞鏄惁杩樹細閲嶅缓 DOM锛堥潤榛樺埛鏂帮級
// 瀵圭収锛欻EAD(涓婁竴杞慨澶? vs 褰撳墠宸ヤ綔鍖?const http = require("http");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let costCalls = 0;
const COST_SHORT = 99.90;
const COST_LONG = 12345.67;

function mkStats(short) {
  return {
    file: FILE_A, title: "浼氳瘽 A 鏈€鏂?, model: "deepseek-v3.2", turns: 18,
    sessionTokens: 2015900000, sessionCostCny: short ? COST_SHORT : COST_LONG, contextPercent: 42.5,
    sumInput: 1e9, sumOutput: 4e8, sumCacheRead: 6e8, sumReasoning: 0,
    series: Array.from({ length: 12 }, (_, i) => ({ turn: i + 1, total: 60000 + i * 4000, cost: 1.2, input: 40000, output: 20000, cacheHit: 30000, cacheMiss: 10000, reasoning: 0, hitRate: 0.72, latencyMs: 1200 })),
    providers: [{ provider: "deepseek", tokens: 1e9 }],
  };
}
const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

function startServer(port, jsPath) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1"); const p = u.pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    if (p === `/api/plugins/${ID}/page`) return send("text/html; charset=utf-8", HTML);
    if (p === `/api/plugins/${ID}/assets/panel-v2.css`) return send("text/css", fs.readFileSync(CSS));
    if (p === `/api/plugins/${ID}/assets/panel-v2.js`) return send("text/javascript", fs.readFileSync(jsPath));
    if (p === `/api/plugins/${ID}/api/stats`) return json(mkStats(true));
    if (p === `/api/plugins/${ID}/api/active`) return json({ dir: "mock", file: FILE_A });
    if (p === `/api/plugins/${ID}/api/sessions`) return json({ dir: "mock", sessions: [{ name: FILE_A, title: "浼氳瘽 A 鏈€鏂?, model: "deepseek-v3.2", size: 1, mtime: 1757000000000, turns: 18 }] });
    if (p === `/api/plugins/${ID}/api/ledger-stats`) return json({ days: { "2026-09-14": { tokens: 2015900000, cost: 99.9 } }, calls: 12111, errors: 0, tokens: { input: 1e9, output: 4e8, cacheHit: 1.3e9, cacheMiss: 5e8, hitRate: 0.996 } });
    if (p === `/api/plugins/${ID}/api/total-cost`) { costCalls++; return json({ totalCost: costCalls >= 2 ? COST_LONG : COST_SHORT }); }
    if (p === `/api/plugins/${ID}/api/rules`) return json({});
    if (p === `/api/plugins/${ID}/api/providers`) return json({ providers: [] });
    if (p === `/api/plugins/${ID}/api/events`) return json({ events: [] });
    if (p === `/api/plugins/${ID}/api/balance`) return json({ balances: [], updatedAt: 1757000000000 });
    if (p === `/api/plugins/${ID}/api/pricing`) return json({ models: [], updatedAt: 1757000000000 });
    if (p === "/api/sessions/messages") return json({ messages: [] });
    return json({ ok: true });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
async function waitChrome(port, tries = 80) { for (let i = 0; i < tries; i++) { try { return await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 鏈氨缁?); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.text };
  return r.result?.value;
}

const SCRIPT = `(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const q=s=>document.querySelector(s);
  const R=e=>{if(!e)return null;const b=e.getBoundingClientRect();return[Math.round(b.x*10)/10,Math.round(b.y*10)/10,Math.round(b.width*10)/10,Math.round(b.height*10)/10];};
  const geo=()=>{const cards=[...document.querySelectorAll('#usage-overview .mini-card')];
    return {hero:R(q('#usage-overview .usage-hero')),mini:R(q('#usage-overview .uh-mini')),
      card1:R(cards[0]),card2:R(cards[1]),card3:R(cards[2]),
      kCostTxt:q('#kCost')?q('#kCost').textContent:null,kCost:R(q('#kCost')),
      kCostOd:!!(q('#kCost')&&q('#kCost').querySelector(':scope > .od')),
      miniW:q('#usage-overview .uh-mini')?Math.round(q('#usage-overview .uh-mini').getBoundingClientRect().width*10)/10:null};};
  let childMut=0,attrMut=0;const evs=[];
  const obs=new MutationObserver(ms=>{for(const m of ms){if(m.type==='childList')childMut++;else attrMut++;evs.push({t:Math.round(performance.now()),kind:m.type,add:m.addedNodes.length,rm:m.removedNodes.length,cls:m.attributeName||''});}});
  obs.observe(q('#root')||document.body,{childList:true,subtree:true,attributes:true});
  const anims=()=>({running:document.getAnimations().filter(a=>a.playState==='running').length,rise:document.querySelectorAll('.si-rise').length});
  const g0=geo();const c0=childMut,a0=attrMut,an0=anims();
  await sleep(10000); // 璺ㄨ繃涓€娆?10s 杞
  const g1=geo();const c1=childMut,a1=attrMut,an1=anims();
  await sleep(2200);
  const g2=geo();const an2=anims();
  obs.disconnect();
  return {g0,g1,g2,childBefore:c0,childAfter:c1,attrBefore:a0,attrAfter:a1,animsBefore:an0,animsAfter:an1,animsEnd:an2,events:evs.slice(0,14)};
})()`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "si-pl-"));
  const before = path.join(tmp, "panel-before.js");
  const after = path.join(tmp, "panel-after.js");
  fs.writeFileSync(before, execSync(`git show ${process.argv[2] || "HEAD"}:assets/panel-v2.js`, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }));
  fs.copyFileSync(PANEL, after);

  const srvBefore = await startServer(8796, before);
  const srvAfter = await startServer(8797, after);
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const udd = path.join(tmp, "chrome");
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--remote-debugging-port=9339", "--user-data-dir=" + udd, "about:blank"], { stdio: "ignore" });
  try {
    await waitChrome(9339);
    const list = await httpJson("http://127.0.0.1:9339/json/list");
    const page = list.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const c = new CDP(ws);
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [tag, port] of [["BEFORE(HEAD)", 8796], ["AFTER(worktree)", 8797]]) {
      for (const round of ["L-鏁板€煎彉鍖?, "S-鏁板€兼亽瀹?]) {
        if (round === "L-鏁板€煎彉鍖?) costCalls = 0; // 棣栧睆杩斿洖鐭€硷紝绗竴娆¤疆璇㈣捣杩斿洖闀垮€?        await c.send("Page.navigate", { url: `http://127.0.0.1:${port}/api/plugins/${ID}/page` });
        await sleep(2600);
        const r = await ev(c, SCRIPT);
        console.log(`\n============ ${tag} 路 ${round} ============`);
        if (r && r.__exception) { console.log("EXC", r.__exception); continue; }
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        console.log("  棣栧睆绋冲畾  :", JSON.stringify(r.g0));
        console.log("  杞涔嬪悗  :", JSON.stringify(r.g1));
        console.log("  鍑犱綍鏄惁鍙?:", same(r.g0.hero, r.g1.hero) && same(r.g0.mini, r.g1.mini) && same(r.g0.card1, r.g1.card1) ? "鍚︼紙绋冲畾锛? : "鏄紙璺冲姩锛?);
        console.log("  杞鏈?DOM 閲嶅缓(childList) :", r.childAfter - r.childBefore, " 灞炴€у啓鍏?:", r.attrAfter - r.attrBefore);
        console.log("  杩愯涓殑鍔ㄧ敾 杞鍓?鈫?鍚?鈫?2.2s鍚?:", JSON.stringify(r.animsBefore), "鈫?, JSON.stringify(r.animsAfter), "鈫?, JSON.stringify(r.animsEnd));
        console.log("  si-quiet 鍐欏叆(root class) :", r.events.slice(0, 6).some((e) => e.kind === "attributes" && e.cls === "class"));
      }
    }
    ws.close();
  } catch (e) { console.error("ERR", (e && e.stack) || e); }
  finally { proc.kill(); srvBefore.close(); srvAfter.close(); await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
})();
