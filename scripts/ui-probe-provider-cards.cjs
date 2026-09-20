// ui-probe-provider-cards.cjs —— 供应商卡片与宿主配置一致性回归探针
//
// 验证两件事：
//   1. 卡片集合严格等于 /api/providers 返回的配置集合（不多不少，硬编码能力表里的供应商不再凭空冒卡）
//   2. 宿主配置增删供应商后，卡片在「供应商哨兵轮询」（4s）内跟着增删，
//      场景里只等 5.2 秒，短于整页 10 秒轮询 → 变化只能来自哨兵
//
// 用法: node scripts/ui-probe-provider-cards.cjs
// 只读 repo 源码，mock 数据全部本地生成，不碰生产文件。
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const CSS = path.join(REPO, "assets", "panel-v2.css");
const PANEL = path.join(REPO, "assets", "panel-v2.js");
const ID = "session-insight";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 宿主配置的四种状态：A 初始三家 / B 删掉 ollama / C 新增 freetoken / D 四色分诊（本地+错误+无接口混合）
const CONFIG = {
  A: ["deepseek", "moonshot", "ollama"],
  B: ["deepseek", "moonshot"],
  C: ["deepseek", "moonshot", "freetoken"],
  D: ["deepseek", "ollama", "zhipu", "openai", "freetoken"],
};
let mode = "A";

const BASE_URL = {
  deepseek: "https://api.deepseek.com",
  moonshot: "https://api.moonshot.cn/v1",
  ollama: "http://localhost:11434/v1",
  freetoken: "http://127.0.0.1:1919/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  openai: "https://api.openai.com/v1",
};

const BALANCE = {
  deepseek: { provider: "deepseek", name: "DeepSeek", status: "ok", kind: "balance", label: "可用余额", summary: "¥42.50", total: 42.5, currency: "CNY" },
  moonshot: { provider: "moonshot", name: "Moonshot", status: "ok", kind: "balance", label: "可用余额", summary: "¥88.80", total: 88.8, currency: "CNY" },
  zhipu: { provider: "zhipu", name: "智谱", status: "http_502", detail: "bad gateway" },
};
const UNSUPPORTED = { ollama: { provider: "ollama", note: "无官方余额接口" }, openai: { provider: "openai", note: "需配置 OpenAI Admin Key" } };
const LOCAL_IDS = new Set(["ollama", "freetoken"]);

const A = { file: "20260914-a.jsonl", title: "会话 A", model: "deepseek-flash", turns: 3, sessionTokens: 1000, sessionCostCny: 1, contextPercent: 10, sumInput: 700, sumOutput: 300, sumCacheRead: 200, sumReasoning: 0, series: [{ turn: 1, total: 1000, cost: 0.01, input: 700, output: 300, cacheHit: 200, cacheMiss: 100, reasoning: 0, hitRate: 0.6, latencyMs: 900 }], providers: [{ provider: "deepseek", tokens: 1000 }] };

const HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/api/plugins/${ID}/assets/panel-v2.css"></head><body data-hana-theme="dark" data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/api/plugins/${ID}/assets/panel-v2.js"></script></body></html>`;

function startServer(port, jsPath) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
    const json = (o) => send("application/json", JSON.stringify(o));
    const cur = () => CONFIG[mode] || [];
    const base = `/api/plugins/${ID}`;

    // 测试控制面：切换「宿主配置」
    if (p === `${base}/control`) { mode = u.searchParams.get("mode") || mode; return json({ ok: true, mode, config: cur() }); }
    if (p === `${base}/page`) return send("text/html; charset=utf-8", HTML);
    if (p === `${base}/assets/panel-v2.css`) return send("text/css", fs.readFileSync(CSS));
    if (p === `${base}/assets/panel-v2.js`) return send("text/javascript", fs.readFileSync(jsPath));

    // 配置集合：等价于宿主的 provider-catalog + models.json + auth.json 求交后的结果
    if (p === `${base}/api/providers`) return json({ providers: cur().map((id) => ({ id, name: null, baseUrl: BASE_URL[id] || null, local: LOCAL_IDS.has(id), models: [] })) });
    // 余额：只有插件写了适配器的供应商才有真实状态，其余靠前端标「已配置」
    if (p === `${base}/api/balance`) return json({
      balances: cur().filter((id) => BALANCE[id]).map((id) => BALANCE[id]),
      unsupported: cur().filter((id) => UNSUPPORTED[id]).map((id) => UNSUPPORTED[id]),
      updatedAt: Date.now(),
    });

    if (p === `${base}/api/stats`) return json(A);
    if (p === `${base}/api/active`) return json({ dir: "mock", file: null });
    if (p === `${base}/api/resolve-entry`) return json({ file: null });
    if (p === `${base}/api/sessions`) return json({ dir: "mock", sessions: [{ name: A.file, title: A.title, model: A.model, size: 1, mtime: Date.now(), turns: A.turns }] });
    if (p === `${base}/api/ledger-stats`) return json({ days: { "2026-09-14": { tokens: 1000, cost: 1 } }, calls: 3, errors: 0, tokens: { input: 700, output: 300, cacheHit: 200, cacheMiss: 100, hitRate: 0.6 } });
    if (p === `${base}/api/total-cost`) return json({ totalCost: 1.23 });
    if (p === `${base}/api/rules`) return json({});
    if (p === `${base}/api/events`) return json({ events: [] });
    if (p === `${base}/api/pricing`) return json({ models: [], updatedAt: Date.now() });
    if (p === "/api/sessions/messages") return setTimeout(() => json({ messages: [] }), 300);
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

const SCENARIO = `(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const cards=()=>[...document.querySelectorAll('#providerList .provider-item')].map(el=>({
    name:(el.querySelector('.pv-name strong')||{}).textContent||'',
    desc:(el.querySelector('.pv-state-desc')||{}).textContent||'',
    dot:((el.querySelector('.pv-dot')||{}).className||'').replace('pv-dot ','').trim(),
  }));
  const setMode=async(m)=>{const r=await fetch('/api/plugins/${ID}/control?mode='+m,{cache:'no-store'});return await r.json();};
  const tab=document.querySelector('.tab[data-view="api"]');
  if(!tab)return {__error:'找不到 API 管理标签'};
  const ctlA=await setMode('A');
  tab.click();
  await sleep(1600);
  const snapA=cards();
  const ctlB=await setMode('B');
  await sleep(5200);            // < 整页 10s 轮询，变化只能来自 4s 供应商哨兵
  const snapB=cards();
  const ctlC=await setMode('C');
  await sleep(5200);
  const snapC=cards();
  const ctlD=await setMode('D');
  await sleep(5200);
  const snapD=cards();
  return {A:{config:ctlA.config,count:snapA.length,cards:snapA},
          B:{before:ctlB.config,count:snapB.length,cards:snapB},
          C:{after:ctlC.config,count:snapC.length,cards:snapC},
          D:{config:ctlD.config,count:snapD.length,cards:snapD}};
})()`;

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-provcards-"));
  const srv = await startServer(8795, PANEL);
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (!fs.existsSync(chromePath)) { console.error("找不到 Chrome: " + chromePath); srv.close(); return; }
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--remote-debugging-port=9337", "--user-data-dir=" + path.join(TMP, "profile"), "about:blank"], { stdio: "ignore" });
  try {
    await waitChrome(9337);
    const list = await httpJson("http://127.0.0.1:9337/json/list");
    const page = list.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const c = new CDP(ws);
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Page.navigate", { url: `http://127.0.0.1:8795/api/plugins/${ID}/page` });
    await sleep(2600);
    const out = await ev(c, SCENARIO);
    ws.close();
    if (out && out.__exception) { console.error("脚本异常:", out.__exception); }
    else if (out && out.__error) { console.error("场景错误:", out.__error); }
    else {
      const say = (tag, o) => {
        console.log(`\n[${tag}] 宿主配置 = ${JSON.stringify(o.config || o.before || o.after)}`);
        console.log(`        卡片数 = ${o.count}`);
        for (const k of o.cards) console.log(`          · ${k.name} | ${k.desc} | 灯=${k.dot}`);
      };
      say("场景A 初始", out.A);
      say("场景B 删掉 ollama 后 5.2s", out.B);
      say("场景C 新增 freetoken 后 5.2s", out.C);
      if (out.D) say("场景D 四色分诊与排序", out.D);
      const names = (o) => o.cards.map((x) => x.name).sort().join(",");
      const expectA = "DeepSeek,Moonshot,Ollama";
      const expectB = "DeepSeek,Moonshot";
      const expectC = "DeepSeek,FreeToken,Moonshot";
      console.log("\n判定:");
      console.log("  A 卡片集合 ==" + expectA + " ? " + (names(out.A) === expectA));
      console.log("  B 卡片集合 ==" + expectB + " ? " + (names(out.B) === expectB));
      console.log("  C 卡片集合 ==" + expectC + " ? " + (names(out.C) === expectC));
      if (out.D) {
        const seq = out.D.cards.map((x) => x.name + ":" + x.dot).join(" → ");
        const expectD = "DeepSeek:ok → Ollama:local → FreeToken:local → 智谱:err → OpenAI:muted";
        console.log("  D 灯色与顺序 = " + seq);
        console.log("  D 期望顺序   = " + expectD);
        console.log("  D 判定 ? " + (seq === expectD));
      }
    }
  } catch (e) {
    console.error("PROBE ERROR:", (e && e.stack) || e);
  } finally {
    proc.kill(); srv.close();
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
