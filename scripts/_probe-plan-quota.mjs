// scripts/_probe-plan-quota.mjs —— 套餐类适配器的离线单测（不联网，喂 mock 响应）
import { PLAN_ADAPTERS } from "../lib/plan-quota.js";

let fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`}`);
}

// ── Kimi Code ──
const kimi = PLAN_ADAPTERS["kimi-coding"].parse({
  limits: [{ detail: { limit: 1000, remaining: 250, resetTime: "2026-10-08T03:00:00Z" } }],
  usage: { limit: 50000, remaining: 12500, resetTime: "2026-10-11T00:00:00Z" },
});
eq("Kimi 窗口", kimi.map((w) => w.type), ["five_hour", "weekly"]);
eq("Kimi 5h 剩余 25%", kimi[0].remainingPercent, 25);
eq("Kimi 周 剩余 25%", kimi[1].remainingPercent, 25);

// ── OpenCode Go ──
const oc = PLAN_ADAPTERS["opencode-go"].parse({
  usage: {
    rolling: { status: "ok", percent: 12, resetsAt: "2026-10-08T05:00:00Z" },
    weekly: { status: "ok", percent: 30, resetsAt: "2026-10-11T00:00:00Z" },
    monthly: { status: "ok", percent: 5, resetsAt: "2026-11-01T00:00:00Z" },
  },
});
eq("OC 窗口", oc.map((w) => w.type), ["five_hour", "weekly", "monthly"]);
eq("OC 5h 剩余 88%", oc[0].remainingPercent, 88);
eq("OC 周 剩余 70%", oc[1].remainingPercent, 70);

const oc0 = PLAN_ADAPTERS["opencode-go"].parse({ usage: { rolling: { percent: 0, resetsAt: "2026-10-08T05:00:00Z" } } });
eq("OC 0% 不给占位倒计时", oc0[0].resetAt, null);

// ── MiniMax ──
const mm = PLAN_ADAPTERS.minimax.parse({
  model_remains: [
    { model_name: "video", current_interval_remaining_percent: 100 },
    {
      model_name: "general",
      current_interval_remaining_percent: 60,
      end_time: 1791426911000,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 90,
      weekly_end_time: 1791734400000,
    },
  ],
});
eq("MM 只取 general", mm.map((w) => w.type), ["five_hour", "weekly"]);
eq("MM 5h 已用 40%", mm[0].usedPercent, 40);
eq("MM 周 剩余 90%", mm[1].remainingPercent, 90);

const mm3 = PLAN_ADAPTERS.minimax.parse({
  model_remains: [
    { model_name: "general", current_interval_remaining_percent: 100, current_weekly_status: 3, current_weekly_remaining_percent: 100 },
  ],
});
eq("MM 无周限额时不显示周桶", mm3.map((w) => w.type), ["five_hour"]);

// ── 端点拼装 ──
eq("MM 端点（国内）", PLAN_ADAPTERS.minimax.url("https://api.minimaxi.com/v1"), "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");
eq("MM 端点（国际）", PLAN_ADAPTERS.minimax.url("https://api.minimax.io/v1"), "https://api.minimax.io/v1/api/openplatform/coding_plan/remains");

// ── 异常响应不抛、返回空 ──
eq("Kimi 空响应", PLAN_ADAPTERS["kimi-coding"].parse(null), []);
eq("OC 空响应", PLAN_ADAPTERS["opencode-go"].parse({}), []);
eq("MM 空响应", PLAN_ADAPTERS.minimax.parse({ model_remains: [] }), []);

console.log(fail ? `\n${fail} 项未通过` : "\n全部通过");
process.exit(fail ? 1 : 0);
