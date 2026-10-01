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
const ONLY = Number(argOf("--only", "0")); // 0 = 全部场景；只跑某一个场景可传 1/2/3
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
  const stat = { enums: 0, enumMsTotal: 0, peakQueue: 0, starts: [] };
  const T0 = Date.now();
  let busy = false;
  const queue = [];
  const pump = () => {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    stat.enums += 1;
    stat.starts.push(Date.now() - T0);
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
      const t0 = Date.now(); // 与 computeStats 的 _t0 对应
      let id = MODE === "before"
        ? await resolveSessionId(sdk, SESSION_FILE)
        : await Promise.race([resolveSessionId(sdk, SESSION_FILE), new Promise((r) => setTimeout(() => r(null), 2500))]);
      if (!id) id = await resolveSessionId(sdk, SESSION_FILE, { fresh: true, since: t0 }); // computeStats 里的 fresh 重查
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
// 一轮请求的自身上限（当前没挂上：保留给以后慢机器上的对照跑）
const capRound = (ms, ps) => Promise.race([Promise.all(ps), sleep(ms)]);
void capRound;

console.log(`模块 ${MODULE_PATH} ｜ 模式 ${MODE} ｜ 单次枚举 ${ENUM_MS}ms ｜ 预算 ${BUDGET_MS}ms ｜ 闸门 ${GATE === Infinity ? "无" : GATE}`);

// ── 场景 1：一次冷加载，7 条接口同时发出（loadPage 的 fast 组） ────────────────
if (ONLY === 0 || ONLY === 1) {
  const mod = await freshModule();
  const { sdk, stat } = makeSdk();
  const routes = makeRoutes(mod, sdk);
  const rec = [];
  const wave = [
    ["/api/stats", routes.stats, true],
    ["/api/sessions", routes.sessions, true],
    ["/api/ledger-stats", routes.light, false],
    ["/api/total-cost", routes.light, false],
    ["/api/events", routes.light, false],
    ["/api/rules", routes.light, false],
    ["/api/providers", routes.light, false],
  ];
  await Promise.all(wave.map(([name, fn, heavy]) => tracked(name, () => (heavy ? gate(fn) : fn()), rec)));
  const over = rec.filter((r) => r.over);
  banner("场景 1 · 冷加载一次 7 并发");
  console.log(`全量枚举次数        ${stat.enums}，起跑时刻(ms) ${stat.starts.join(", ")}`);
  console.log(`宿主被枚举占住      ${stat.enumMsTotal}ms`);
  console.log(`撞穿 ${BUDGET_MS}ms 预算   ${over.length}/${rec.length} 条  ${over.map((r) => r.name + " " + r.ms + "ms").join(", ")}`);
  console.log(`单条最长等待        ${Math.max(...rec.map((r) => r.ms))}ms`);
}

// ── 场景 2：面板开着的稳态（按节拍推算，不跑真实时钟） ───────────────
//  为什么不跑实时模拟：BEFORE 模式下每轮都有被客户端放弃的枚举留在假宿主的队列里
//  （现实也是如此：请求超时了，宿主那边那次调用不会被取消），排起来会拖十几分钟。
//  这里只算稳态下「一个面板开着一小时会打多少次全量枚举」，用轮询节拍 × TTL 推。
if (ONLY === 0 || ONLY === 2) {
  const PAGE_PER_MIN = 6; // loadPage 每 10 秒一轮，/api/sessions 每分钟 6 次
  const rows = [
    { name: "before（每轮直发枚举 + /api/stats 每 120 秒一次）", per10: PAGE_PER_MIN * 10 + 5 },
    { name: "after （30 秒档共享缓存，过期不阻塞）", per10: Math.ceil(600 / 30) },
  ];
  banner("场景 2 · 面板开着的稳态（推算）");
  for (const r of rows) {
    console.log(`  ${r.name}`);
    console.log(`    10 分钟 ${r.per10} 次 / 1 小时 ${r.per10 * 6} 次，宿主被枚举占住约 ${((r.per10 * 6 * ENUM_MS) / 1000).toFixed(0)} 秒/小时`);
  }
  console.log(`  （按单次枚举 ${ENUM_MS}ms 折算）`);
}

// ── 场景 3：缓存语义（宽限期内不阻塞 / 越界后阻塞 / 并发 miss 合并 / 结果正确） ──
if (ONLY === 0 || ONLY === 3) {
  const mod = await freshModule();
  const { sdk, stat } = makeSdk();
  const { listSessionsCached, resolveSessionId } = mod;
  banner("场景 3 · 缓存语义");

  const burstRec = [];
  await Promise.all(
    Array.from({ length: 5 }, (_, i) => tracked("并发#" + i, () => listSessionsCached(sdk, { ttlMs: 15000 }), burstRec))
  );
  console.log(`5 条并发冷请求 → 枚举次数 ${stat.enums}，单条等待 ${burstRec.map((r) => r.ms).join("/")}ms`);

  // 缓存已经是热的时候再取一次：应该秒回，不再打枚举
  const warm = stat.enums;
  const t1 = Date.now();
  const got = await listSessionsCached(sdk, { ttlMs: 40, staleMs: 8000 }).catch(() => null);
  console.log(`热缓存再取（40ms TTL / 8s 宽限）：${Date.now() - t1}ms 返回 ${Array.isArray(got) ? got.length + " 条" : got}，枚举次数增加 ${stat.enums - warm}`);

  // 文件名 → sessionId 的解析（面板每次算会话统计都要走这一条）
  const r1 = await resolveSessionId(sdk, SESSION_FILE);
  console.log(`文件名解析：${r1} ${r1 ? "（成功）" : "（失败）"}`);
  console.log(`累计枚举次数 ${stat.enums}`);
}

// 场景跑完直接退出：假宿主里还排着队的长尾枚举（现实中那些被客户端放弃、宿主仍在跑的调用）
// 会一直挂着定时器，等它自然排空要几分钟，对结论没有影响。
process.exit(0);

