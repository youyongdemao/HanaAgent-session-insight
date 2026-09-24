// assets/live.js — 本轮速览卡：单轮对话的实时指标条
// 显示哪些项、按什么顺序，全部来自 /api/live-config（设置页写入）。
import { hana } from "./sdk.js";

const APP_ID = "session-insight-v2";
const POLL_MS = 4000;

const ss = new URLSearchParams(location.search).get("appSurfaceSession") || "";

function apiUrl(path) {
  return `${location.origin}/api/apps/${APP_ID}/routes/${path}`;
}

async function apiFetch(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (ss) headers.set("X-Hana-App-Surface-Session", ss);
  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/* ── 格式化 ── */
const fmtNum = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
};
const fmtCost = (n) => {
  const v = Number(n) || 0;
  if (v >= 1) return "¥" + v.toFixed(2);
  if (v >= 0.01) return "¥" + v.toFixed(4);
  return v > 0 ? "¥" + v.toFixed(6) : "¥0";
};
const pct = (r, digits = 1) => (Number(r) * 100).toFixed(digits) + "%";

// 每个指标怎么取值、什么状态色、要不要用界面字体（模型名这类不适合等宽）
const RENDER = {
  model: (d) =>
    d.turn.modelId ? { k: "模型", text: d.turn.modelId, wide: true } : null,
  hit: (d) => {
    const r = d.turn.hitRatio;
    if (r == null) return null;
    return { k: "缓存命中", text: pct(r), cls: r < 0.85 ? "is-warn" : r >= 0.95 ? "is-good" : "" };
  },
  tokens: (d) => (d.turn.totalTokens != null ? { k: "本轮 Token", text: fmtNum(d.turn.totalTokens) } : null),
  cost: (d) => (d.turn.cost != null ? { k: "本轮费用", text: fmtCost(d.turn.cost) } : null),
  tps: (d) => {
    const t = d.turn.tps;
    if (t == null) return null;
    return { k: "吞吐", text: `${t} t/s`, cls: t < 20 ? "is-warn" : "" };
  },
  output: (d) => (d.turn.outputTokens != null ? { k: "输出", text: fmtNum(d.turn.outputTokens) } : null),
  input: (d) => (d.turn.inputTokens != null ? { k: "输入", text: fmtNum(d.turn.inputTokens) } : null),
  reasoning: (d) =>
    d.turn.reasoningTokens ? { k: "思考", text: fmtNum(d.turn.reasoningTokens) } : null,
  duration: (d) =>
    d.turn.durationMs != null ? { k: "耗时", text: (d.turn.durationMs / 1000).toFixed(1) + "s" } : null,
  sessionName: (d) => (d.session?.name ? { k: "会话", text: d.session.name, wide: true } : null),
  sessionTokens: (d) =>
    d.session?.totalTokens != null ? { k: "会话 Token", text: fmtNum(d.session.totalTokens) } : null,
  sessionCost: (d) =>
    d.session?.cost != null ? { k: "会话费用", text: fmtCost(d.session.cost) } : null,
  avgHit: (d) => (d.session?.hitRatio != null ? { k: "平均命中", text: pct(d.session.hitRatio) } : null),
  context: (d) =>
    d.context?.percent != null ? { k: "上下文", text: pct(d.context.percent, 0) } : null,
  compact: (d) =>
    d.context?.compactThreshold != null ? { k: "压缩阈值", text: pct(d.context.compactThreshold, 0) } : null,
  balance: (d) => (d.balance != null ? { k: "余额", text: fmtCost(d.balance) } : null),
};

let layout = { order: [], on: [] };
const row = document.getElementById("lvRow");
const seen = new Map(); // id -> 上次的值，用于只在变化时闪一下

/**
 * 把内容实际需要的高度上报给宿主。
 * 只在宿主允许内容长高的挂载位才做（黑板 / 拆窗是 fixed，报了也没用），
 * 免得白发一次 IPC，也免得在定死的框里反复拉扯。
 */
let lastReported = 0;
function reportHeight() {
  try {
    const env = hana.envelope?.getSnapshot?.();
    if (env?.height?.mode === "fixed") return;
    const host = document.querySelector(".lv");
    if (!host) return;
    const h = Math.ceil(host.scrollHeight);
    if (!h || Math.abs(h - lastReported) < 2) return;
    lastReported = h;
    hana.ui?.resize?.({ height: h });
  } catch {
    /* 旧宿主没有这路通道，保持原布局即可 */
  }
}

function renderShell() {
  const want = layout.order.filter((id) => layout.on.includes(id) && RENDER[id]);
  if (!want.length) {
    row.innerHTML = '<span class="lv-empty">未选择显示项，请在会话用量设置里勾选</span>';
    requestAnimationFrame(reportHeight);
    return;
  }
  row.innerHTML = want
    .map((id) => `<span class="lv-item" data-id="${id}"><i class="lv-k"></i><b class="lv-v"></b></span>`)
    .join("");
  requestAnimationFrame(reportHeight);
}

function paint(data) {
  for (const el of row.querySelectorAll(".lv-item")) {
    const id = el.dataset.id;
    let out = null;
    try {
      out = RENDER[id](data);
    } catch {
      out = null;
    }
    const kEl = el.querySelector(".lv-k");
    const vEl = el.querySelector(".lv-v");
    if (!out) {
      el.style.display = "none";
      continue;
    }
    el.style.display = "";
    kEl.textContent = out.k;
    el.classList.toggle("is-wide", !!out.wide);
    el.classList.toggle("is-warn", out.cls === "is-warn");
    el.classList.toggle("is-good", out.cls === "is-good");
    const prev = seen.get(id);
    if (prev !== undefined && prev !== out.text) {
      vEl.classList.remove("flash");
      void vEl.offsetWidth;
      vEl.classList.add("flash");
    }
    seen.set(id, out.text);
    vEl.textContent = out.text;
    el.title = `${out.k}：${out.text}`;
  }
  requestAnimationFrame(reportHeight);
}

async function loadConfig() {
  try {
    const cfg = await apiFetch("api/live-config");
    layout = { order: cfg.order || [], on: cfg.on || [] };
  } catch {
    layout = { order: [], on: [] };
  }
  renderShell();
}

/** 余额走既有端点，失败就静默留空（卡片不承诺这项一定有值）。 */
async function fetchBalance() {
  try {
    const b = await apiFetch("api/balance");
    const list = b?.balances ?? [];
    const first = list.find((x) => typeof x?.remaining === "number") ?? list[0];
    const v = first?.remaining ?? first?.balance ?? null;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

async function tick() {
  try {
    const data = await apiFetch("api/live-data");
    if (layout.on.includes("balance")) data.balance = await fetchBalance();
    paint(data);
  } catch {
    // 单次失败不打断轮询，保持上一次的值
  }
}

let timer = 0;
async function start() {
  await loadConfig();
  await tick();
  timer = window.setInterval(tick, POLL_MS);
  window.addEventListener("beforeunload", () => window.clearInterval(timer), { once: true });
  // 宿主改变尺寸约束（比如从黑板拖成独立窗口）时重算一次
  hana.envelope?.subscribe?.(() => requestAnimationFrame(reportHeight));
  // 内容尺寸自身变化（换布局、切换显示项）时也跟上
  if (window.ResizeObserver) {
    new ResizeObserver(() => requestAnimationFrame(reportHeight)).observe(row);
  }
  // 设置页保存后广播，卡片立刻换布局，不用等下一轮
  window.addEventListener("storage", (e) => {
    if (e.key === "si-live-layout") start();
  });
}

start();
