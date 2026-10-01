// scripts/probe-rpc-coalescing.mjs
// 离线探针：量「宿主的全量列会话被并发请求各打一遍」这件事，改前改后差多少。
//
// 模型（数值都取自实测）：
//   · session:list 一次 ENUM_MS（本机慢路径日志里 resolve=2200ms；插件注释里「偶发 4~5 秒」
//     是另一台机器上的量级，两边都跑一遍）
//   · 宿主对枚举是串行的：同一时刻只服务一次全量枚举，后来的排队。这是「整批 8 秒超时」的成因。
//   · 别的步骤按 0 计，要对比的就是枚举这一项
//   · 请求预算按前端的 8 秒算
//
// 每个场景用带 query 的 import 取一份全新模块实例，避免模块级缓存串味。
//
// 用法：
//   node scripts/probe-rpc-coalescing.mjs --module lib/host-data.js --mode after  --enum-ms 4500 --window-s 120
//   node scripts/probe-rpc-coalescing.mjs --module lib/.baseline.js   --mode before --enum-ms 4500 --window-s 120

import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const MODULE_PATH = argOf("--module", "lib/host-data.js");
const MODULE_URL = new URL(MODULE_PATH, pathToFileURL(process.cwd() + "/")).href;
const MODE = argOf("--mode", "after"); // before = /api/sessions 绕过缓存、缓存无单飞无宽限；after = 合并
const ENUM_MS = Number(argOf("--enum-ms", "4500"));
const BUDGET_MS = Number(argOf("--budget-ms", "8000"));
const WINDOW_S = Number(argOf("--window-s", "120"));
const GATE = MODE === "after" ? 2 : Infinity; // 前端重接口的并发闸门

let loadSeq = 0;
const freshModule = async () => {
  loadSeq += 1;
  const url = MODULE_URL + (MODULE_URL.includes("?") ? "&" : "?") + "probe=" + loadSeq;
  return await import(url);
};

const SESSION_FILE = "2026-09-27T03-42-26-927Z_01a0e0ff-aaaa-7000-8000-000000000001.jsonl";

/** 假宿主：全量枚举串行 + 计数 */
function makeSdk() {
  const stat = { enums: 0, enumMsTotal: 0, peakQueue: 0 };
  let busy = false;
  const queue = [];
  const pump = () => {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    stat.enums += 1;
    const t0 = Date.now();
    setTimeout(() => {
      busy = false;
      stat.enumMsTotal += Date.now() - t0;
      job({ sessions: [{ sessionId: "sess_fixed", name: SESSION_FILE, path: "D:/x/" + SESSION_FILE, lifecycle: "active" }] });
      pump();
    }, ENUM_MS);
  };
  return {
    stat,
    sdk: {
      sessions: {
        list: () =>
          new Promise((resolve) => {
            queue.push(resolve);
            stat.peakQueue = Math.max(stat.peakQueue, queue.length + (busy ? 1 : 0));
            pump();
          }),
      },
      usage: { list: async () => ({ entries: [] }) },
    },
  };
}

/** 前端重接口的并发闸门（与 panel-v2.js 里的 heavyGate 同构） */
function makeGate(limit) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= limit || !queue.length) return;
    const job = queue.shift();
    active += 1;
    Promise.resolve()
      .then(job.fn)
      .then(job.ok, job.no)
      .then(() => {
        active -= 1;
        pump();
      });
  };
  return (fn) => new Promise((ok, no) => { queue.push({ fn, ok, no }); pump(); });
}
const gate = makeGate(GATE);

function tracked(name, fn, rec) {
  const t0 = Date.now();
  return Promise.resolve()
    .then(fn)
    .then(
      (v) => { const ms = Date.now() - t0; rec.push({ name, ms, over: ms > BUDGET_MS }); return v; },
      () => { const ms = Date.now() - t0; rec.push({ name, ms, over: ms > BUDGET_MS }); return null; }
    );
}

/** 路由等价物：与 index.js 的实际取数方式保持一致（含 resolve 失败后的 fresh 重查） */
function makeRoutes(mod, sdk) {
  const { listSessions, listSessionsCached, resolveSessionId } = mod;
  return {
    stats: async () => {
      let id = MODE === "before"
        ? await resolveSessionId(sdk, SESSION_FILE)
        : await Promise.race([resolveSessionId(sdk, SESSION_FILE), new Promise((r) => setTimeout(() => r(null), 2500))]);
      if (!id) id = await resolveSessionId(sdk, SESSION_FILE, { fresh: true }); // computeStats 里的 fresh 重查
      const sess = MODE === "before"
        ? await listSessionsCached(sdk, { ttlMs: 120000 }).catch(() => [])
        : await listSessionsCached(sdk, { ttlMs: 120000, staleMs: 600000 }).catch(() => []);
      return { id, n: sess.length };
    },
    sessions: async () =>
      MODE === "before"
        ? listSessions(sdk, { lifecycle: "active" })
        : listSessionsCached(sdk, { lifecycle: "active", ttlMs: 30000, staleMs: 120000 }),
    light: async () => ({ ok: true }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const banner = (t) => console.log(`\n===== ${t} =====`);

console.log(`模块 ${MODULE_PATH} ｜ 模式 ${MODE} ｜ 单次枚举 ${ENUM_MS}ms ｜ 预算 ${BUDGET_MS}ms ｜ 闸门 ${GATE === Infinity ? "无" : GATE}`);

// ── 场景 1：一次冷加载，7 条接口同时发出（loadPage 的 fast 组） ────────────────
{
  const mod = await freshModule();
  const { sdk, stat } = makeSdk();
  const routes = makeRoutes(mod, sdk);
  const rec = [];
  const wave = [
    ["/api/stats", routes.stats, true],
    ["/api/sessions", routes.sessions, true],
    ["/api/ledger-stats", routes.light, true],
    ["/api/total-cost", routes.light, true],
    ["/api/events", routes.light, true],
    ["/api/rules", routes.light, false],
    ["/api/providers", routes.light, false],
  ];
  await Promise.all(wave.map(([name, fn, heavy]) => tracked(name, () => (heavy ? gate(fn) : fn()), rec)));
  const over = rec.filter((r) => r.over);
  banner("场景 1 · 冷加载一次 7 并发");
  console.log(`全量枚举次数        ${stat.enums}`);
  console.log(`宿主被枚举占住      ${stat.enumMsTotal}ms`);
  console.log(`撞穿 ${BUDGET_MS}ms 预算   ${over.length}/${rec.length} 条  ${over.map((r) => r.name + " " + r.ms + "ms").join(", ")}`);
  console.log(`单条最长等待        ${Math.max(...rec.map((r) => r.ms))}ms`);
}

// ── 场景 2：面板开着 WINDOW_S 秒（10 秒一轮 loadPage + 2 秒一轮快通道） ─────────
{
  const mod = await freshModule();
  const { sdk, stat } = makeSdk();
  const routes = makeRoutes(mod, sdk);
  const rec = [];
  const t0 = Date.now();
  let nextPage = 0;
  let nextFast = 0;
  while (Date.now() - t0 < WINDOW_S * 1000) {
    const t = Date.now() - t0;
    if (t >= nextPage) {
      nextPage += 10000;
      await Promise.all([
        tracked("/api/stats", () => gate(routes.stats), rec),
        tracked("/api/sessions", () => gate(routes.sessions), rec),
      ]);
    }
    if (t >= nextFast) {
      nextFast += 2000;
      await tracked("/api/stats?fast=1", async () => ({ ok: true }), rec); // 带 sess_ 前缀，不碰列表
    }
    await sleep(30);
  }
  const over = rec.filter((r) => r.over);
  const scale = 600 / WINDOW_S;
  banner(`场景 2 · 面板开 ${WINDOW_S} 秒`);
  console.log(`全量枚举次数        ${stat.enums}（10 分钟约 ${Math.round(stat.enums * scale)} 次）`);
  console.log(`宿主被枚举占住      ${stat.enumMsTotal}ms`);
  console.log(`请求总数            ${rec.length}`);
  console.log(`撞穿 ${BUDGET_MS}ms 预算   ${over.length} 条`);
  console.log(`全部请求等时合计    ${rec.reduce((n, r) => n + r.ms, 0)}ms`);
}

// ── 场景 3：缓存语义（宽限期内不阻塞 / 越界后阻塞 / 并发 miss 合并 / 结果正确） ──
{
  const mod = await freshModule();
  const { sdk, stat } = makeSdk();
  const { listSessionsCached, resolveSessionId } = mod;
  banner("场景 3 · 缓存语义");

  const burstRec = [];
  await Promise.all(
    Array.from({ length: 5 }, (_, i) => tracked("并发#" + i, () => listSessionsCached(sdk, { ttlMs: 15000 }), burstRec))
  );
  console.log(`5 条并发冷请求 → 枚举次数 ${stat.enums}，单条等待 ${burstRec.map((r) => r.ms).join("/")}ms`);

  const before = stat.enums;
  const t1 = Date.now();
  const stale = await listSessionsCached(sdk, { ttlMs: 40, staleMs: 8000 }).catch(() => null);
  const staleMs = Date.now() - t1;
  console.log(`TTL 过期但仍在宽限期（40ms/8s）：${staleMs}ms 返回 ${Array.isArray(stale) ? stale.length + " 条" : stale}，枚举次数增加 ${stat.enums - before}`);

  const t2 = Date.now();
  await listSessionsCached(sdk, { ttlMs: 40, staleMs: 0 }).catch(() => null);
  console.log(`超出宽限期（40ms/0）：等待 ${Date.now() - t2}ms 后重算`);

  const r1 = await resolveSessionId(sdk, SESSION_FILE);
  const r2 = await resolveSessionId(sdk, SESSION_FILE, { fresh: true });
  console.log(`文件名解析：${r1} / fresh ${r2} → ${r1 && r2 ? "一致" : "不一致"}`);
  console.log(`累计枚举次数 ${stat.enums}`);
}
