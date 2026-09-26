// probe-widget-stale.cjs —— 宿主停顿期间，侧栏卡片会不会被清空（回归探针）
//
// 背景：宿主一边跑模型一边接 RPC，usage:list / session:context 实测单次 6～63 秒，
//       面板的请求预算只有 4～8 秒；失败后前端还会熔断几秒。
//       旧写法把结果无条件写成 null，渲染层于是把整块画成「0% / 0.0% / 已用 –」，
//       看着像数据坏了，其实只是这一轮宿主没答。表现就是「时好时坏」。
//
// 这个探针：先喂一份好数据让卡片渲染出来，然后让 /api/stats* 永久挂住（模拟宿主停顿），
//   过十几秒再量一次卡片上的数字。
//     改前：数字变成 – / 0.0%     → 探针 FAIL
//     改后：数字保持上一次的值，右上角由「实时」变「数据滞后」 → 探针 PASS
//
// 用法：
//   node scripts/probe-widget-stale.cjs            # 量当前工作区（改后）
//   node scripts/probe-widget-stale.cjs --old      # 量 git HEAD 里的旧版（改前对照）
//   node scripts/probe-widget-stale.cjs --shot     # 顺带存两张对照图到 scripts/
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const APP_ID = "session-insight-v2";
const OLD = process.argv.includes("--old");
const SHOT = process.argv.includes("--shot");
const PORT = 8881;
const DBG = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 旧版直接从 git 里取，不用手工备份文件
function readVariant(rel) {
  if (!OLD) return fs.readFileSync(path.join(REPO, rel));
  return execFileSync("git", ["show", `HEAD:${rel.replace(/\\/g, "/")}`], { cwd: REPO, maxBuffer: 1 << 26 });
}
const THEME_CSS = (() => {
  try {
    const base = "D:/AI/Hanako/artifacts/renderer";
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const p = path.join(base, d, "themes", "midnight.css");
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
  } catch {}
  return "";
})();

const page = (extra = "") =>
  `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="./assets/panel-v2.css"></head><body data-hana-theme="midnight" data-surface="widget"><div id="root" data-surface="widget"></div><script type="module" src="./assets/panel-v2.js"></script>${extra}</body></html>`;

const series = Array.from({ length: 55 }, (_, i) => ({
  turn: i + 1, total: 62000 + i * 4200, cost: (62000 + i * 4200) * 3e-8,
  input: 12000 + i * 800, output: 18000 + i * 1200, cacheInc: 30000 + i * 2000,
  cacheRead: 30000 + i * 2000, cacheMiss: 12000 + i * 800, reasoning: 0, hit: 62 + (i % 17),
}));
const STATS = {
  file: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", turns: 55,
  sessionTokens: 304537347, sessionCostCny: 12.51, contextPercent: 42,
  contextWindow: 128000, lastWindowTokens: 53760, remainingToCompact: 48640,
  sumInput: 900000, sumOutput: 340000, sumCacheRead: 700000, sumReasoning: 0,
  lastTurnTokens: 68000, lastCostCny: 0.21, avgHitPercent: 68.4,
  providers: [{ provider: "deepseek", tokens: 304537347, turns: 55, models: [{ model: "deepseek-v3.2", tokens: 304537347 }] }],
  series,
};
const BALANCE = { balances: [{ provider: "deepseek", name: "DeepSeek", status: "ok", kind: "money", summary: "¥94.59", remainingPercent: 94 }] };

let mode = "ok"; // ok | stall
const hanging = [];

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;
  const send = (t, b) => { res.writeHead(200, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); };
  const json = (o) => send("application/json", JSON.stringify(o));
  const stall = () => { hanging.push(res); }; // 不写任何响应头：让客户端的 AbortSignal.timeout 自己超时

  if (p === "/theme.css") return send("text/css", THEME_CSS);
  if (p === `/api/apps/${APP_ID}/ui/widget`) return send("text/html; charset=utf-8", page());

  const asset = new RegExp(`^/api/apps/${APP_ID}/ui/assets/(.+)$`).exec(p);
  if (asset) {
    let buf;
    try { buf = readVariant(path.join("ui", "assets", asset[1])); } catch { res.writeHead(404); return res.end(); }
    const e = path.extname(asset[1]).toLowerCase();
    return send(e === ".css" ? "text/css" : e === ".js" ? "text/javascript" : "application/octet-stream", buf);
  }

  const route = new RegExp(`^/api/apps/${APP_ID}/routes/(.+)$`).exec(p);
  if (route) {
    if (mode === "stall" && /^api\/stats/.test(route[1])) return stall();
    const api = route[1].replace(/^api\//, "").split("?")[0];
    if (api === "stats") return json(STATS);
    if (api === "balance") return json(BALANCE);
    if (api === "active") return json({ dir: "mock", file: "a.jsonl" });
    if (api === "resolve-entry") return json({ file: "a.jsonl" });
    if (api === "ui-env") return json({ overlappingWindowButtons: false });
    if (api === "build-stamp") return json({ build: "probe" });
    if (api === "sessions" || api === "sessions/messages")
      return json({ dir: "mock", messages: [], sessions: [{ name: "a.jsonl", title: "会话 A", model: "deepseek-v3.2", size: 1, mtime: Date.now(), turns: 55 }] });
    if (api === "ledger-stats") return json({ days: {}, tokens: {}, models: {}, providers: {}, calls: 0, errors: 0 });
    if (api === "total-cost") return json({ totalCost: 12.51, perModel: {} });
    if (api === "rules") return json({ rules: [] });
    if (api === "providers") return json({ providers: [] });
    if (api === "events") return json({ entries: [], diags: [] });
    if (api === "update-check") return json({ hasUpdate: false });
    return json({ ok: true });
  }
  if (p === "/api/sessions/messages") return json({ messages: [] });
  return json({ ok: true });
});

function httpJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej);
  });
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
async function ev(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
}
const READ = `(() => { const t = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
  const live = document.querySelector('.widget .live');
  return { ring: t('#wRingVal'), tok: t('#wTokTotal'), cost: t('#wCost'), hit: t('#wHitAvg'),
    inPct: t('#wCompInputPct'), missPct: t('#wCompMissPct'), used: t('#wUsed'), win: t('#wWindow'),
    turns: t('#wTurnsRound'), live: live ? live.textContent.trim() : null,
    liveStale: live ? live.classList.contains('stale') : null }; })()`;

(async () => {
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-stale-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ["--headless=new", "--disable-gpu", "--no-first-run", "--window-size=420,900",
      "--remote-debugging-port=" + DBG, "--user-data-dir=" + path.join(TMP, "p"), "about:blank"], { stdio: "ignore" });
  const done = (code) => { try { proc.kill(); } catch {} while (hanging.length) { try { hanging.pop().destroy(); } catch {} } try { srv.close(); } catch {} process.exit(code); };
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson(`http://127.0.0.1:${DBG}/json/list`).catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    if (!t) throw new Error("chrome 没起来");
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/api/apps/${APP_ID}/ui/widget?appSurfaceSession=probe` });

    await sleep(2200);
    const before = await ev(cdp, READ);
    if (SHOT) { const s = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(__dirname, `stale-before-${OLD ? "old" : "new"}.png`), Buffer.from(s.data, "base64")); }

    mode = "stall"; // 宿主从这一刻起不答 /api/stats*
    await sleep(16000);
    const after = await ev(cdp, READ);
    if (SHOT) { const s = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(__dirname, `stale-after-${OLD ? "old" : "new"}.png`), Buffer.from(s.data, "base64")); }

    const blanked = (v) => v == null || v === "" || /^[–—-]$/.test(v) || v === "0.0%";
    const kept = before.ring === after.ring && before.tok === after.tok && before.cost === after.cost && !blanked(after.ring);
    const bad = ["ring", "tok", "cost", "hit", "inPct", "used"].filter((k) => blanked(after[k]));

    console.log(`\n变体：${OLD ? "旧版（git HEAD，改前）" : "当前工作区（改后）"}`);
    console.log("  停顿前：", JSON.stringify(before));
    console.log("  停顿后：", JSON.stringify(after));
    if (kept) {
      console.log(`  判定：PASS —— 数值全部保留，右上角标记 = 「${after.live}」(stale=${after.liveStale})`);
      done(after.liveStale ? 0 : 2);
    } else {
      console.log(`  判定：FAIL —— 被清空的字段：${bad.join(", ") || "（数值发生了变化）"}`);
      done(1);
    }
  } catch (e) {
    console.error("探针出错：", e.message);
    done(3);
  }
})();
