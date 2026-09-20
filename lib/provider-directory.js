// provider-directory.js —— 供应商目录（单一来源）
//
// 每个供应商在这里集中描述四件事，其他文件不再各写一份：
//   name    显示名
//   links   控制台/账单入口（同时作为 /api/open 的跳转白名单来源）
//   query   余额/配额查询门路：kind=查询类型，reachable=官方是否有可查接口，note=未查到时的说明
//   launch  本地部署应用的启动目标（exe 候选路径 + 探活端口）
//
// query.reachable 是界面灯色的判据，不靠文案猜：
//   true  官方有余额/配额/用量接口，只是当前条件不满足（没配 Admin Key、非 Coding Plan 等）→ 亮红
//   false 官方没有可查接口，或本来就是免费/本地 → 灰灯（本地的另按 local 标粉）
//
// 备注（2026-09-20 核对）：MiMo、Gemini 官方均无余额/用量接口，只有网页控制台；
// z.ai Coding Plan 有 monitor/usage/quota/limit；OpenAI 走 Admin Costs API。
export const PROVIDER_DIRECTORY = {
  deepseek: {
    name: "DeepSeek",
    links: [{ label: "API 平台", url: "https://platform.deepseek.com" }, { label: "用量账单", url: "https://platform.deepseek.com/usage" }],
    query: { kind: "balance", reachable: true, via: "GET /user/balance", note: "余额接口暂不可用" },
  },
  moonshot: {
    name: "Moonshot",
    links: [{ label: "Kimi 开放平台", url: "https://platform.kimi.com" }],
    query: { kind: "balance", reachable: true, via: "GET /users/me/balance", note: "余额接口暂不可用" },
  },
  zhipu: {
    name: "智谱",
    links: [{ label: "开放平台", url: "https://open.bigmodel.cn" }, { label: "控制台", url: "https://open.bigmodel.cn/console" }],
    query: { kind: "quota", reachable: true, via: "GET /api/monitor/usage/quota/limit（需 Coding Plan）", note: "当前账户非 Coding Plan 或配额不可用" },
  },
  "zhipu-coding": {
    name: "智谱 Coding",
    links: [{ label: "Z.ai", url: "https://z.ai" }, { label: "订阅用量", url: "https://z.ai/manage-apikey/subscription" }],
    query: { kind: "quota", reachable: true, via: "GET api.z.ai/api/monitor/usage/quota/limit（需 Coding Plan）", note: "当前账户非 Coding Plan 或配额不可用" },
  },
  openai: {
    name: "OpenAI",
    links: [{ label: "平台", url: "https://platform.openai.com" }, { label: "用量", url: "https://platform.openai.com/usage" }],
    query: { kind: "usage", reachable: true, via: "Admin Costs API（需 Admin Key）", note: "需配置 OpenAI Admin Key" },
  },
  "openai-codex": {
    name: "ChatGPT Plus / Pro",
    links: [{ label: "Codex 控制台", url: "https://chatgpt.com/codex" }],
    query: { kind: "quota", reachable: true, via: "chatgpt.com/backend-api/wham/usage（需 OAuth 登录）", note: "实验性配额未启用" },
  },
  xai: {
    name: "xAI",
    links: [{ label: "控制台", url: "https://console.x.ai" }],
    query: { kind: "balance", reachable: true, via: "management-api.x.ai（需 Management Key + Team ID）", note: "Management Key 或 Team ID 无效" },
  },
  gemini: {
    name: "Gemini",
    links: [{ label: "AI Studio", url: "https://aistudio.google.com" }, { label: "用量", url: "https://aistudio.google.com/usage" }],
    query: { kind: "none", reachable: false, via: "官方无用量接口，仅网页可查", note: "官方无接口，只能到 AI Studio 看" },
  },
  mimo: {
    name: "MiMo",
    links: [{ label: "开放平台", url: "https://platform.xiaomimimo.com" }],
    query: { kind: "none", reachable: false, via: "官方无余额/用量接口，仅网页控制台", note: "官方无接口，只能到开放平台看" },
  },
  agnes: {
    name: "Agnes",
    links: [{ label: "API Hub", url: "https://apihub.agnes-ai.com" }],
    query: { kind: "none", reachable: false, via: "全模态免费额度，无余额概念", note: "全模态免费，无余额可查" },
  },
  "xai-oauth": {
    name: "xAI Grok",
    links: [{ label: "Grok", url: "https://grok.com" }],
    query: { kind: "none", reachable: false, via: "订阅制，无公开接口", note: "订阅制，无公开接口" },
  },
  ollama: {
    name: "Ollama",
    local: true,
    links: [{ label: "官网", url: "https://ollama.com" }],
    query: { kind: "none", reachable: false, via: "本地部署，无余额概念", note: "本地部署，没有可读取的余额接口" },
    launch: {
      label: "启动 Ollama",
      targets: ["%LOCALAPPDATA%\\Programs\\Ollama\\ollama app.exe"],
      probePort: 11434,
    },
  },
  freetoken: {
    name: "FreeToken",
    local: true,
    links: [],
    query: { kind: "none", reachable: false, via: "本地部署，无余额概念", note: "本地部署，没有可读取的余额接口" },
    launch: {
      label: "启动 FreeToken",
      targets: [
        "%LOCALAPPDATA%\\Programs\\FreeToken Desktop\\freetoken-desktop.exe",
        "D:\\AI\\Freetoken\\FreeToken Desktop\\freetoken-desktop.exe",
      ],
      probePort: 1919,
    },
  },
};

// 把 %VAR% 展开成绝对路径，未展开的直接返回
export function expandEnvPath(p) {
  return String(p).replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
}

// 某个供应商的启动目标（第一个真实存在的 exe）；没有可启动目标时返回 null
export function resolveLaunchTarget(provider, existsFn) {
  const dir = PROVIDER_DIRECTORY[provider];
  if (!dir?.launch) return null;
  for (const raw of dir.launch.targets || []) {
    const exe = expandEnvPath(raw);
    if (existsFn(exe)) return { exe, label: dir.launch.label || dir.name, probePort: dir.launch.probePort || null };
  }
  return null;
}

// 目录里所有外链的 hostname，供 /api/open 做跳转白名单
export function allowedLinkHosts() {
  const hosts = new Set();
  for (const dir of Object.values(PROVIDER_DIRECTORY)) {
    for (const link of dir.links || []) {
      try { hosts.add(new URL(link.url).hostname); } catch {}
    }
  }
  return hosts;
}
