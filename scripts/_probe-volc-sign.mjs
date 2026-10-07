// scripts/_probe-volc-sign.mjs —— 火山签名结构 + 套餐额度解析的离线验证（不联网）
// 跑：node scripts/_probe-volc-sign.mjs
import { signRequest, regionFromBaseUrl, queryVolcenginePlan } from "../lib/volcengine-plan.js";

let fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`}`);
}

// ── 签名结构（对照 cc-switch 已锁定的契约）──
const sig = signRequest({
  accessKeyId: "AKLTtest",
  secretAccessKey: "secretkey",
  region: "cn-beijing",
  canonicalQueryStr: "Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01",
  body: "",
  now: new Date("2024-06-21T00:00:00Z"),
});
eq("x-date 形状", sig.xDate, "20240621T000000Z");
eq("空 body sha256", sig.xContentSha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
eq("Authorization 前缀", sig.authorization.startsWith("HMAC-SHA256 Credential=AKLTtest/20240621/cn-beijing/ark/request,"), true);
eq("SignedHeaders 固定顺序", sig.authorization.includes("SignedHeaders=host;x-date;x-content-sha256;content-type,"), true);
eq("region cn-beijing", regionFromBaseUrl("https://ark.cn-beijing.volces.com/api/coding/v3"), "cn-beijing");
eq("region cn-shanghai", regionFromBaseUrl("https://ark.cn-shanghai.volces.com/api/coding/v3"), "cn-shanghai");
eq("region 缺省", regionFromBaseUrl("https://example.com/api/coding"), "cn-beijing");

const sigValue = sig.authorization.match(/Signature=([0-9a-f]+)/)[1];
console.log("NODE_SIGNATURE=" + sigValue);

// ── 解析：两个 plan 各一发假响应 ──
const afpBody = {
  ResponseMetadata: { RequestId: "x" },
  Result: {
    PlanType: "Large",
    AFPFiveHour: { Quota: 50, Used: 12.5, ResetTime: 1778806800000 },
    AFPDaily: { Quota: 100, Used: 22.5, ResetTime: 1778803200000 },
    AFPWeekly: { Quota: 500, Used: 150, ResetTime: 1779062400000 },
    AFPMonthly: { Quota: 2000, Used: 850.5, ResetTime: 1780531200000 },
  },
};
const codingBody = {
  ResponseMetadata: { RequestId: "y" },
  Result: {
    Status: "Running",
    QuotaUsage: [
      { Level: "session", Percent: 0, ResetTimestamp: -1 },
      { Level: "weekly", Percent: 1.672568, ResetTimestamp: 1782057600 },
      { Level: "monthly", Percent: 0.836284, ResetTimestamp: 1784303999 },
    ],
  },
};

function mockFetch(map) {
  return async (url) => {
    const action = new URL(url).searchParams.get("Action");
    return { ok: true, status: 200, text: async () => JSON.stringify(map[action]) };
  };
}

const afp = await queryVolcenginePlan({
  fetchFn: mockFetch({ GetAFPUsage: afpBody }),
  accessKeyId: "a",
  secretAccessKey: "b",
  baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
});
eq("Agent Plan 命中", afp.ok, true);
eq("Agent Plan 名称", afp.plan, "Agent Plan Large");
eq("Agent Plan 三窗口顺序", afp.windows.map((w) => w.type), ["five_hour", "weekly", "monthly"]);
eq("AFP 5h 剩余", afp.windows[0].remainingPercent, 75);
eq("AFP 周 剩余", afp.windows[1].remainingPercent, 70);
eq("AFP 月 剩余", Math.round(afp.windows[2].remainingPercent * 1000) / 1000, 57.475);

const coding = await queryVolcenginePlan({
  fetchFn: mockFetch({
    GetAFPUsage: { ResponseMetadata: {}, Result: { AFPFiveHour: { Quota: 0, Used: 0 } } },
    GetCodingPlanUsage: codingBody,
  }),
  accessKeyId: "a",
  secretAccessKey: "b",
  baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
});
eq("AFP 空后退到 Coding Plan", coding.ok, true);
eq("Coding Plan 名称", coding.plan, "Coding Plan");
eq("Coding 5h 无重置时间（-1 哨兵）", coding.windows[0].resetAt, null);
eq("Coding 周 剩余", Math.round(coding.windows[1].remainingPercent * 100) / 100, 98.33);

// 鉴权失败 → 直接停，不再试第二个 action
let calls = 0;
const authFail = await queryVolcenginePlan({
  fetchFn: async () => {
    calls++;
    return {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ ResponseMetadata: { Error: { Code: "InvalidAuthorization", Message: "bad" } } }),
    };
  },
  accessKeyId: "a",
  secretAccessKey: "b",
  baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
});
eq("鉴权失败 reason", authFail.reason, "auth");
eq("鉴权失败只发一次请求", calls, 1);

console.log(fail ? `\n${fail} 项未通过` : "\n全部通过");
process.exit(fail ? 1 : 0);
