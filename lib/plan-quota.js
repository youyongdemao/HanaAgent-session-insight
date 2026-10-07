// plan-quota.js —— 订阅套餐类供应商的额度查询（Kimi Code / OpenCode Go / MiniMax）
//
// 与「按量余额」不是一类：钱花在包月上，接口回的是时间窗口的已用/剩余百分比。
// 认证都用供应商自己的 API Key（Bearer），不需要用户另配凭据，所以目录里不给它们 keys。
//
// 这三个端点都是社区实测、官方未完整文档化的数据面接口（对照 cc-switch 的 coding_plan.rs），
// 形态随时可能变，解析一律防御式：字段对不上就跳过该窗口，不整体失败、也不猜数字。

/** 窗口三档的展示标签，与其余额度类供应商保持一致。 */
const WINDOW_META = {
  five_hour: { short: "5h", label: "5 小时窗口" },
  weekly: { short: "周", label: "周窗口" },
  monthly: { short: "月", label: "月窗口" },
};
const WINDOW_ORDER = ["five_hour", "weekly", "monthly"];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** ISO 时间：字符串原样（已是 ISO），数字按秒/毫秒自适应。0 与负数当没有。 */
function isoTime(v) {
  if (typeof v === "string") return v.trim() || null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  } catch {
    return null;
  }
}

/** 用「已用百分比」造窗口；越界夹到 0–100。 */
function windowOf(slot, usedPercent, resetAt) {
  const meta = WINDOW_META[slot];
  const used = Math.max(0, Math.min(100, num(usedPercent) ?? 0));
  return {
    type: slot,
    label: meta.label,
    short: meta.short,
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    resetAt: resetAt || null,
    windowSeconds: null,
  };
}

/** 有的家给的是「剩余百分比」，换过来。 */
function windowOfRemaining(slot, remainingPercent, resetAt) {
  const remaining = Math.max(0, Math.min(100, num(remainingPercent) ?? 0));
  return windowOf(slot, 100 - remaining, resetAt);
}

function sortWindows(list) {
  return list.filter(Boolean).sort((a, b) => WINDOW_ORDER.indexOf(a.type) - WINDOW_ORDER.indexOf(b.type));
}

// ── Kimi Code：GET https://api.kimi.com/coding/v1/usages ──
// limits[].detail 是 5 小时滚动窗口（limit / remaining），usage 是周限额。
function parseKimi(body) {
  const out = [];
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  const detail = limits.find((x) => x?.detail)?.detail;
  if (detail) {
    const limit = num(detail.limit);
    const remaining = num(detail.remaining);
    if (limit != null && limit > 0 && remaining != null) {
      out.push(windowOf("five_hour", ((limit - remaining) / limit) * 100, isoTime(detail.resetTime ?? detail.reset_at)));
    }
  }
  const usage = body?.usage;
  if (usage) {
    const limit = num(usage.limit);
    const remaining = num(usage.remaining);
    if (limit != null && limit > 0 && remaining != null) {
      out.push(windowOf("weekly", ((limit - remaining) / limit) * 100, isoTime(usage.resetTime ?? usage.reset_at)));
    }
  }
  return sortWindows(out);
}

// ── OpenCode Go：GET https://opencode.ai/zen/go/v1/usage ──
// usage.{rolling,weekly,monthly}.percent 是已用整数百分比。
const OPENCODE_WINDOWS = [
  ["rolling", "five_hour"],
  ["weekly", "weekly"],
  ["monthly", "monthly"],
];

function parseOpencodeGo(body) {
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") return [];
  const out = [];
  for (const [key, slot] of OPENCODE_WINDOWS) {
    const w = usage[key];
    if (!w) continue;
    const percent = num(w.percent);
    if (percent == null) continue;
    // percent 为 0 时上游给的是「now + 窗口时长」的占位重置值（窗口其实早已过期），丢弃不倒计时。
    out.push(windowOf(slot, percent, percent > 0 ? isoTime(w.resetsAt ?? w.resets_at) : null));
  }
  return sortWindows(out);
}

// ── MiniMax：GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains ──
// model_remains 里有 general（编程套餐）与 video 等，只取 general。
// 周桶并非所有套餐都有，靠 current_weekly_status === 1 判定激活。
function parseMinimax(body) {
  const list = Array.isArray(body?.model_remains) ? body.model_remains : [];
  const item = list.find((x) => String(x?.model_name || "").toLowerCase() === "general");
  if (!item) return [];
  const out = [];
  const intervalRemain = num(item.current_interval_remaining_percent);
  if (intervalRemain != null) {
    out.push(windowOfRemaining("five_hour", intervalRemain, isoTime(item.end_time)));
  }
  if (num(item.current_weekly_status) === 1) {
    const weeklyRemain = num(item.current_weekly_remaining_percent);
    if (weeklyRemain != null) {
      out.push(windowOfRemaining("weekly", weeklyRemain, isoTime(item.weekly_end_time)));
    }
  }
  return sortWindows(out);
}

/** MiniMax 的额度端点只在 minimaxi.com / minimax.io 有；从 baseUrl 判断国内还是国际。 */
function minimaxUrl(baseUrl) {
  const host = String(baseUrl || "").split("://").pop().split("/")[0].toLowerCase();
  return host.includes("minimax.io")
    ? "https://api.minimax.io/v1/api/openplatform/coding_plan/remains"
    : "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains";
}

/** 套餐类查询适配器：url 定端点，parse 把响应转成 windows。三家都用供应商 API Key（Bearer）。 */
export const PLAN_ADAPTERS = {
  "kimi-coding": {
    name: "Kimi Code",
    url: () => "https://api.kimi.com/coding/v1/usages",
    parse: parseKimi,
  },
  "opencode-go": {
    name: "OpenCode Go",
    url: () => "https://opencode.ai/zen/go/v1/usage",
    parse: parseOpencodeGo,
  },
  minimax: {
    name: "MiniMax",
    url: (baseUrl) => minimaxUrl(baseUrl),
    parse: parseMinimax,
  },
};
