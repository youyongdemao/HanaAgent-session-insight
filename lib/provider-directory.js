// provider-directory.js —— 供应商目录（单一来源）
//
// 每个供应商在这里集中描述四件事，其他文件不再各写一份：
//   name    显示名
//   links   控制台/账单入口（页面“打开官网”按钮用）
//   query   余额/配额查询门路：kind=查询类型，reachable=官方是否有可查接口，note=未查到时的说明
//
// query.reachable 是界面灯色的判据，不靠文案猜：
//   true  官方有余额/配额/用量接口，只是当前条件不满足（没配 Admin Key、非 Coding Plan 等）→ 亮红
//   false 官方没有可查接口，或本来就是免费/本地 → 灰灯（本地的另按 local 标粉）
//
// 备注（2026-09-20 核对）：MiMo、Gemini 官方均无余额/用量接口，只有网页控制台；
// z.ai Coding Plan 有 monitor/usage/quota/limit；OpenAI 走 Admin Costs API。
/**
 * 本地应用的默认安装位置。
 * App 子进程只拿得到 PATH / HOME / TMPDIR / LANG，没有 %LOCALAPPDATA% 这类变量，
 * 所以用 HOME 拼出 Windows 上最常见的几个安装目录。这些只是「省事」，解析不到
 * 就交给用户在设置里指定，不是保证。
 */
function defaultDirs(productDir, names) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return [];
  const bases = [`${home}\\AppData\\Local\\Programs`, `${home}\\AppData\\Local`, home];
  const paths = [];
  for (const base of bases) for (const name of names) paths.push(`${base}\\${productDir}\\${name}`);
  return paths;
}

export const PROVIDER_DIRECTORY = {
  deepseek: {
    name: "DeepSeek",
    billing: "metered",
    links: [{ label: "API 平台", url: "https://platform.deepseek.com" }, { label: "用量账单", url: "https://platform.deepseek.com/usage" }],
    query: { kind: "balance", reachable: true, via: "GET /user/balance", note: "余额接口暂不可用" },
  },
  moonshot: {
    name: "Moonshot",
    billing: "metered",
    links: [{ label: "Kimi 开放平台", url: "https://platform.kimi.com" }],
    query: { kind: "balance", reachable: true, via: "GET /users/me/balance", note: "余额接口暂不可用" },
  },
  zhipu: {
    name: "智谱",
    billing: "metered",
    links: [{ label: "开放平台", url: "https://open.bigmodel.cn" }, { label: "控制台", url: "https://open.bigmodel.cn/console" }],
    query: { kind: "quota", reachable: true, via: "GET /api/monitor/usage/quota/limit（需 Coding Plan）", note: "当前账户非 Coding Plan 或配额不可用" },
  },
  "zhipu-coding": {
    name: "智谱 Coding",
    billing: "subscription",
    links: [{ label: "Z.ai", url: "https://z.ai" }, { label: "订阅用量", url: "https://z.ai/manage-apikey/subscription" }],
    query: { kind: "quota", reachable: true, via: "GET api.z.ai/api/monitor/usage/quota/limit（需 Coding Plan）", note: "当前账户非 Coding Plan 或配额不可用" },
  },
  "volcengine-coding": {
    name: "火山方舟 Coding",
    billing: "subscription",
    links: [{ label: "方舟控制台", url: "https://console.volcengine.com/ark" }, { label: "开通管理", url: "https://console.volcengine.com/ark/subscribe" }],
    // 套餐用量（session / 周 / 月三窗口）走火山**控制面 OpenAPI**：
    //   Coding Plan → GetCodingPlanUsage，Agent Plan → GetAFPUsage，
    //   都在 open.volcengineapi.com，要 AK/SK 的 V4 签名。
    // 推理用的 API Key（bearer）查不到任何用量，两套凭据不能混。
    // 两个 action 已在 lib/volcengine-plan.js 里实现，凭据从 App 设置读取。
    query: {
      kind: "quota",
      reachable: true,
      via: "火山 OpenAPI GetAFPUsage / GetCodingPlanUsage（需 AK/SK 的 V4 签名）",
      note: "未配置火山 AK/SK：到「设置 → 供应商设置」里填写后才能读取套餐额度",
      keys: [
        { id: "volcengineAccessKey", label: "AccessKey", desc: "用于查询套餐额度：火山方舟 OpenAPI 的访问密钥 ID" },
        { id: "volcengineSecretKey", label: "SecretKey", secret: true, desc: "用于查询套餐额度：火山方舟 OpenAPI 的访问密钥" },
      ],
    },
  },
  openai: {
    name: "OpenAI",
    billing: "metered",
    links: [{ label: "平台", url: "https://platform.openai.com" }, { label: "用量", url: "https://platform.openai.com/usage" }],
    query: {
      kind: "usage",
      reachable: true,
      via: "Admin Costs API（需 Admin Key）",
      note: "需配置 OpenAI Admin Key",
      keys: [{ id: "openaiAdminKey", label: "Admin Key", secret: true, desc: "用于查询用量：调用 Admin Costs API 所需的管理员密钥" }],
    },
  },
  "openai-codex": {
    name: "ChatGPT Plus / Pro",
    billing: "subscription",
    links: [{ label: "Codex 控制台", url: "https://chatgpt.com/codex" }],
    // 走 chatgpt.com 的私有配额端点（需本机 OAuth 凭据，实测可用）。
    // 作为「订阅额度」类供应商，它的窗口用量比金额更有意义。
    query: { kind: "quota", reachable: true, via: "GET chatgpt.com/backend-api/wham/usage（需本机 OAuth 凭据）", note: "OAuth 凭据缺失或已过期" },
  },
  xai: {
    name: "xAI",
    billing: "metered",
    links: [{ label: "控制台", url: "https://console.x.ai" }],
    query: {
      kind: "balance",
      reachable: true,
      via: "management-api.x.ai（需 Management Key + Team ID）",
      note: "Management Key 或 Team ID 无效",
      keys: [
        { id: "xaiManagementKey", label: "Management Key", secret: true, desc: "用于查询余额：management-api.x.ai 所需的管理密钥" },
        { id: "xaiTeamId", label: "Team ID", desc: "用于查询余额：management-api.x.ai 所需的团队标识" },
      ],
    },
  },
  gemini: {
    name: "Gemini",
    billing: "metered",
    links: [{ label: "AI Studio", url: "https://aistudio.google.com" }, { label: "用量", url: "https://aistudio.google.com/usage" }],
    query: { kind: "none", reachable: false, via: "官方无用量接口，仅网页可查", note: "官方无接口，只能到 AI Studio 看" },
  },
  mimo: {
    name: "MiMo",
    billing: "metered",
    links: [{ label: "开放平台", url: "https://platform.xiaomimimo.com" }],
    query: { kind: "none", reachable: false, via: "官方无余额/用量接口，仅网页控制台", note: "官方无接口，只能到开放平台看" },
  },
  agnes: {
    name: "Agnes",
    billing: "free",
    links: [{ label: "API Hub", url: "https://apihub.agnes-ai.com" }],
    query: { kind: "none", reachable: false, via: "全模态免费额度，无余额概念", note: "全模态免费，无余额可查" },
  },
  "xai-oauth": {
    name: "xAI Grok",
    billing: "subscription",
    links: [{ label: "Grok", url: "https://grok.com" }],
    query: { kind: "none", reachable: false, via: "订阅制，无公开接口", note: "订阅制，无公开接口" },
  },
  ollama: {
    name: "Ollama",
    billing: "local",
    local: true,
    links: [{ label: "官网", url: "https://ollama.com" }],
    query: { kind: "none", reachable: false, via: "本地部署，无余额概念", note: "本地部署，没有可读取的余额接口" },
    launch: {
      label: "启动 Ollama",
      // 启动的是托盘应用「ollama app.exe」（双击的那个）。带空格的命令名会被宿主当 shell
      // 表达式拒收，所以先解析 ollama.exe 拿安装目录，再取同目录的托盘应用。
      // 后面两组是默认安装目录与命令行兜底，都不依赖具体用户名。
      attempts: [
        { candidates: ["ollama.exe"], sibling: "ollama app.exe", args: [] },
        { candidates: defaultDirs("Ollama", ["ollama app.exe"]), args: [] },
        {
          candidates: ["ollama.exe", ...defaultDirs("Ollama", ["ollama.exe"])],
          args: ["serve"],
        },
      ],
      // 用户级的 OLLAMA_MODELS 在 App 子进程里看不到（宿主只给 PATH/HOME/TMPDIR/LANG），
      // 不带上的话 ollama 会回退到 C:\Users\<用户>\.ollama\models：模型列表是空的，
      // 而且新拉的模型会落到 C 盘。这里显式指回本机那套模型库。
      env: { OLLAMA_MODELS: "D:\\AI\\Ollama\\models" },
      probePort: 11434,
      probePath: "/api/version",
    },
  },
  freetoken: {
    name: "FreeToken",
    billing: "local",
    local: true,
    links: [],
    query: { kind: "none", reachable: false, via: "本地部署，无余额概念", note: "本地部署，没有可读取的余额接口" },
    launch: {
      label: "启动 FreeToken",
      // 先按默认安装目录找，本机自定义安装位置只做最后兜底；两者都中不了就走让用户指定
      attempts: [
        {
          candidates: [
            "freetoken-desktop.exe",
            ...defaultDirs("FreeToken Desktop", ["freetoken-desktop.exe"]),
            "D:\\AI\\Freetoken\\FreeToken Desktop\\freetoken-desktop.exe",
          ],
          args: [],
        },
      ],
      probePort: 1919,
      probePath: "/",
    },
  },
  // ── 2026-09-25 按 HanaAgent 官方模型目录（model-catalog）对齐时补入 ──
  dashscope: {
    name: "阿里云百炼",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://bailian.console.aliyun.com" },
      { label: "定价", url: "https://help.aliyun.com/zh/model-studio/model-pricing" },
    ],
    // 模型用量只能在控制台看；阿里云账户现金余额要走通用计费 BSS OpenAPI（AK/SK 的 RPC 签名），
    // 那条路反映的是整个阿里云账户，不是百炼的免费额度，两者不能混。插件尚未接入。
    query: {
      kind: "balance",
      reachable: true,
      via: "阿里云 BssOpenApi QueryAccountBalance（RPC 签名，账号级 AK/SK）",
      note: "未查到余额：到「设置 → 供应商设置」配置阿里云 AccessKey ID / Secret",
      keys: [
        { id: "aliyunAccessKeyId", label: "AccessKey ID", desc: "阿里云账号级 AccessKey ID（查询云账户余额用）" },
        { id: "aliyunAccessKeySecret", label: "AccessKey Secret", secret: true, desc: "阿里云账号级 AccessKey Secret" },
      ],
    },
  },
  "dashscope-coding": {
    name: "阿里云百炼 Coding",
    billing: "subscription",
    links: [
      { label: "订阅页", url: "https://bailian.console.aliyun.com/cn-beijing/subscription/coding-plan" },
      { label: "说明", url: "https://help.aliyun.com/zh/model-studio/coding-plan" },
    ],
    query: {
      kind: "none",
      reachable: false,
      via: "官方无公开接口，用量只在 Coding Plan 页面可见",
      note: "套餐按模型调用次数扣额度，用量到控制台看",
    },
  },
  "dashscope-token-plan": {
    name: "阿里云百炼 Token 套餐",
    billing: "subscription",
    links: [
      { label: "订阅页", url: "https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan" },
      { label: "说明", url: "https://help.aliyun.com/zh/model-studio/token-plan-overview" },
    ],
    query: {
      kind: "none",
      reachable: false,
      via: "官方无公开文档；社区逆向的控制台网关需临时 access_token，未接入",
      note: "套餐按 Credits 计量，用量到控制台「我的订阅」看",
    },
  },
  "kimi-coding": {
    name: "Kimi Code",
    billing: "subscription",
    links: [
      { label: "控制台", url: "https://www.kimi.com/code/console" },
      { label: "额度", url: "https://www.kimi.com/membership/subscription?tab=quota" },
    ],
    query: {
      kind: "quota",
      reachable: true,
      via: "GET api.kimi.com/coding/v1/usages（Bearer，供应商 Key）",
      note: "未查到额度：确认已订阅 Kimi Code 且该供应商的密钥有效",
    },
  },
  modelscope: {
    name: "魔搭 ModelScope",
    billing: "free",
    links: [
      { label: "社区", url: "https://www.modelscope.cn" },
      { label: "额度规则", url: "https://www.modelscope.cn/docs/model-service/API-Inference/limits" },
    ],
    query: { kind: "none", reachable: false, via: "官方无查询接口，每日免费额度只在控制台看", note: "实名用户每日 2000 次、每日重置" },
  },
  "opencode-go": {
    name: "OpenCode Go",
    billing: "subscription",
    links: [
      { label: "控制台", url: "https://opencode.ai/console/go" },
      { label: "说明", url: "https://opencode.ai/docs/go/" },
    ],
    query: {
      kind: "quota",
      reachable: true,
      via: "GET opencode.ai/zen/go/v1/usage（Bearer，供应商 Key）",
      note: "未查到额度：确认已订阅 OpenCode Go 且该供应商的密钥有效",
    },
  },
  volcengine: {
    name: "火山方舟",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://console.volcengine.com/ark" },
      { label: "费用中心", url: "https://console.volcengine.com/finance/bill" },
      { label: "计费说明", url: "https://www.volcengine.com/docs/ark/model-service-pricing" },
    ],
    query: {
      kind: "balance",
      reachable: true,
      via: "费用中心 QueryBalanceAcct（service=billing，复用方舟那对 AK/SK）",
      note: "未查到余额：到「设置 → 供应商设置」配置火山 AK/SK（与方舟 Coding 共用同一对）",
    },
  },
  siliconflow: {
    name: "硅基流动",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://cloud.siliconflow.cn" },
      { label: "定价", url: "https://siliconflow.cn/pricing" },
    ],
    query: {
      kind: "balance",
      reachable: true,
      via: "GET /v1/user/info（Bearer API Key；端点来自社区验证，官方 API 文档未收录）",
      note: "查询失败时检查 API Key 是否有效",
    },
  },
  minimax: {
    name: "MiniMax",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://platform.minimaxi.com" },
      { label: "充值", url: "https://platform.minimaxi.com/user-center/payment" },
    ],
    query: {
      kind: "quota",
      reachable: true,
      via: "GET api.minimaxi.com/v1/api/openplatform/coding_plan/remains（Bearer，供应商 Key）",
      note: "未查到额度：确认已订阅 Coding Plan 且该供应商的密钥有效",
    },
  },
  stepfun: {
    name: "阶跃星辰",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://platform.stepfun.com" },
      { label: "定价", url: "https://platform.stepfun.com/docs/zh/guides/pricing/details" },
    ],
    query: {
      kind: "balance",
      reachable: true,
      via: "GET /v1/accounts（Bearer API Key）",
      note: "查询失败时检查 API Key 是否有效",
    },
  },
  hunyuan: {
    name: "腾讯混元",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://console.cloud.tencent.com/hunyuan" },
      { label: "费用中心", url: "https://console.cloud.tencent.com/expense" },
      { label: "计费说明", url: "https://cloud.tencent.com/document/product/1729/97731" },
    ],
    query: {
      kind: "balance",
      reachable: true,
      via: "腾讯云 billing DescribeAccountBalance（TC3-HMAC-SHA256，账号级 SecretId/Key）",
      note: "未查到余额：到「设置 → 供应商设置」配置腾讯云 SecretId / SecretKey",
      keys: [
        { id: "tencentSecretId", label: "SecretId", desc: "腾讯云 API 密钥 SecretId（查询云账户余额用）" },
        { id: "tencentSecretKey", label: "SecretKey", secret: true, desc: "腾讯云 API 密钥 SecretKey" },
      ],
    },
  },
  "baidu-cloud": {
    name: "百度智能云千帆",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://console.bce.baidu.com/qianfan/" },
      { label: "定价", url: "https://cloud.baidu.com/doc/qianfan/s/wmh4sv6ya" },
    ],
    query: {
      kind: "balance",
      reachable: true,
      via: "百度智能云 Finance /v1/finance/cash/balance（BCE 签名，账号级 AK/SK）",
      note: "未查到余额：到「设置 → 供应商设置」配置百度智能云 AccessKey ID / Secret",
      keys: [
        { id: "baiduAccessKeyId", label: "AccessKey ID", desc: "百度智能云 AccessKey ID（查询云账户余额用）" },
        { id: "baiduAccessKeySecret", label: "AccessKey Secret", secret: true, desc: "百度智能云 Secret Access Key" },
      ],
    },
  },
  baichuan: {
    name: "百川智能",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://platform.baichuan-ai.com" },
      { label: "定价", url: "https://platform.baichuan-ai.com/prices" },
    ],
    query: { kind: "none", reachable: false, via: "官方接口清单只有对话与知识库，无余额/配额查询端点", note: "官方无接口，只能到控制台看" },
  },
  infini: {
    name: "无问芯穹",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://cloud.infini-ai.com" },
      { label: "费用中心", url: "https://cloud.infini-ai.com/billing/bill" },
    ],
    query: { kind: "none", reachable: false, via: "官方只提供费用中心页面与余额预警短信，无查询端点", note: "按小时出账，余额只能到费用中心看" },
  },
  anthropic: {
    name: "Anthropic",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://console.anthropic.com" },
      { label: "账单", url: "https://console.anthropic.com/settings/billing" },
      { label: "定价", url: "https://www.anthropic.com/pricing" },
    ],
    query: {
      kind: "none",
      reachable: false,
      via: "无余额接口；Admin API 提供用量/成本报表 GET /v1/organizations/usage_report/messages（需 Admin Key）",
      note: "报的是历史用量与美元成本，不是预付余额；插件尚未接入",
    },
  },
  openrouter: {
    name: "OpenRouter",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://openrouter.ai" },
      { label: "额度", url: "https://openrouter.ai/settings/credits" },
      { label: "定价", url: "https://openrouter.ai/pricing" },
    ],
    query: {
      kind: "balance",
      reachable: true,
      via: "GET /v1/credits（Bearer，需管理密钥；返回 total_credits / total_usage）",
      note: "普通推理密钥会返回 403，要换成管理密钥（provisioning key）",
    },
  },
  mistral: {
    name: "Mistral AI",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://console.mistral.ai" },
      { label: "定价", url: "https://mistral.ai/pricing" },
    ],
    query: {
      kind: "none",
      reachable: false,
      via: "无余额接口；Admin API 有用量指标 GET /v1/admin/usage（x-api-key 需 Admin Key）",
      note: "报的是消费量与成本，不是实时余额；插件尚未接入",
    },
  },
  groq: {
    name: "Groq",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://console.groq.com" },
      { label: "定价", url: "https://groq.com/pricing" },
    ],
    query: { kind: "none", reachable: false, via: "官方 Billing FAQ 只让到控制台看用量，未列任何余额/用量端点", note: "官方无接口，只能到 Dashboard 看" },
  },
  together: {
    name: "Together AI",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://api.together.ai" },
      { label: "定价", url: "https://www.together.ai/pricing" },
    ],
    query: { kind: "none", reachable: false, via: "官方只有 credits/billing 说明，未见任何余额或用量端点", note: "余额只在控制台可见" },
  },
  perplexity: {
    name: "Perplexity",
    billing: "metered",
    links: [
      { label: "API 平台", url: "https://www.perplexity.ai/api-platform" },
      { label: "设置", url: "https://www.perplexity.ai/settings/api" },
    ],
    query: { kind: "none", reachable: false, via: "普通账户无公开余额接口；Enterprise 另有 Analytics API（需企业权限）", note: "普通档查不到，只有企业版有分析接口" },
  },
  fireworks: {
    name: "Fireworks AI",
    billing: "metered",
    links: [
      { label: "控制台", url: "https://app.fireworks.ai" },
      { label: "定价", url: "https://fireworks.ai/pricing" },
    ],
    query: {
      kind: "none",
      reachable: false,
      via: "有账单汇总/用量接口 GET /v1/accounts/{account_id}/billing/summary（Bearer，需账户级权限）",
      note: "返回的是消费汇总，不是余额；需 account_id，插件尚未接入",
    },
  },
};

/**
 * 计费形态（自动判定，不需要用户配置）：
 *   metered      按量计费 —— 有公开单价，费用按 token 算
 *   subscription 订阅额度 —— OAuth 接入或 Coding Plan 类，钱花在包月上，界面该看额度用量而不是金额
 *   free         云端免费额度（如 Agnes）—— 不花钱，但走的是别人家的 API，不是本地
 *   free         云端免费额度（如 Agnes）—— 不花钱，但走的是别人家的 API，不是本地
 *   local        本地部署 —— 跑在自己机器上，没有费用也没有额度
 * 判据依次是：目录里写死的 billing → baseUrl 指向本机 → provider id 的接入后缀 → 默认按量。
 * 用户自己新增的供应商走最后两条兜底，也能落到合理形态。
 */
export function billingModeOf(providerId, baseUrl) {
  const dir = PROVIDER_DIRECTORY[providerId];
  if (dir?.billing) return dir.billing;
  const b = String(baseUrl || "");
  if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(b)) return "local";
  // 订阅通道常常直接用专线域名区分（如 MiMo 的 token-plan-cn.xiaomimimo.com）
  if (/token[-_]?plan/i.test(b)) return "subscription";
  if (/(^|-)(oauth|coding|plan)(-|$)/i.test(String(providerId || ""))) return "subscription";
  return "metered";
}

/** 形态的中文标签，界面直接用 */
export const BILLING_LABEL = { metered: "按量计费", subscription: "订阅额度", free: "免费额度", local: "本地部署" };

/** 启动目标的对外形状：详情页只要标题和端口，不要候选路径 */
export function launchSummary(providerId) {
  const launch = PROVIDER_DIRECTORY[providerId]?.launch;
  return launch ? { label: launch.label, port: launch.probePort ?? null } : null;
}
