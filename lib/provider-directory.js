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
  openai: {
    name: "OpenAI",
    billing: "metered",
    links: [{ label: "平台", url: "https://platform.openai.com" }, { label: "用量", url: "https://platform.openai.com/usage" }],
    query: { kind: "usage", reachable: true, via: "Admin Costs API（需 Admin Key）", note: "需配置 OpenAI Admin Key" },
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
    query: { kind: "balance", reachable: true, via: "management-api.x.ai（需 Management Key + Team ID）", note: "Management Key 或 Team ID 无效" },
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
