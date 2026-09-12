// lib/usage-parser.js — 解析 Hana 会话 JSONL，产出统计与图表序列
// 口径 v2（2026-08-11 校准）：
//   - usage.cacheRead / usage.totalTokens 是「累计值」（当前上下文缓存总量），
//     单轮新增缓存命中 = 本轮 cacheRead − 上一轮 cacheRead（会话内单调递增，
//     上下文压缩后归零重新累积，故按增量逐轮累加最稳）
//   - usage.input / output / reasoning 是「单轮增量」
//   - 单轮处理量 total = input + cacheInc + output + reasoning
//   - 会话总计 sessionTokens = Σ单轮处理量（含推理）
//   - 上下文占用 lastWindowTokens = last.input + last.cacheRead（累计窗口大小）
//   - 费用：input×miss + cacheInc×hit + (output+reasoning)×output 价
//     （DeepSeek 官方惯例 reasoning 按输出价计费）

// ── 计费配置（内置兜底）──
// 这份内置数据由 scripts/sync-builtin-pricing.mjs 从仓库根 pricing.json 生成。
// 运行期若成功拉到外部 pricing.json，会由 setPricingConfig() 覆盖以下导出值。
// >>> BUILTIN-PRICING-DATA 由 scripts/sync-builtin-pricing.mjs 从 pricing.json 生成，请勿手工编辑
let PRICING_SNAPSHOT_AT = "2026-09-12";

// 价格来源标注（官方 / 折算 / 免费 / 未核实），用于透明呈现
let SOURCE_NOTE = {
  "Baichuan3-Turbo": "baichuan 官方定价页；官方页未列缓存命中价，按输入价计",
  "Baichuan4-Air": "baichuan 官方定价页；官方页未列缓存命中价，按输入价计",
  "Baichuan4-Turbo": "baichuan 官方定价页；官方页未列缓存命中价，按输入价计",
  "MiniMax-M2": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "MiniMax-M2.1": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "MiniMax-M2.5": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "MiniMax-M2.5-highspeed": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "MiniMax-M2.7": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "MiniMax-M2.7-highspeed": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "MiniMax-M3": "minimax 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "agnes-2.5-flash": "agnes 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "agnes-2.5-pro-alpha": "官方付费价（该托管 API 已标记废弃）",
  "agnes-image-2.1-flash": "免费",
  "agnes-video-v2.0": "免费",
  "agnes::agnes-2.5-flash": "agnes 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "agnes::agnes-2.5-pro-alpha": "官方付费价（该托管 API 已标记废弃）",
  "agnes::agnes-image-2.1-flash": "免费",
  "agnes::agnes-video-v2.0": "免费",
  "anthropic::claude-3-5-haiku": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Haiku 3.5 (retired, except on Bedrock and Google Cloud)",
  "anthropic::claude-fable-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Fable 5",
  "anthropic::claude-fable-5-1": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Fable 5.1",
  "anthropic::claude-haiku-4-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Haiku 4.5",
  "anthropic::claude-mythos-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Mythos 5 (limited availability)",
  "anthropic::claude-mythos-5-1": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Mythos 5.1 (limited availability)",
  "anthropic::claude-opus-4-1": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 4.1 (retired, except on Bedrock and Google Cloud)",
  "anthropic::claude-opus-4-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 4.5",
  "anthropic::claude-opus-4-6": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 4.6",
  "anthropic::claude-opus-4-7": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 4.7",
  "anthropic::claude-opus-4-8": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 4.8",
  "anthropic::claude-opus-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 5",
  "anthropic::claude-sonnet-4-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Sonnet 4.5",
  "anthropic::claude-sonnet-4-6": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Sonnet 4.6",
  "anthropic::claude-sonnet-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Sonnet 5",
  "baichuan::Baichuan3-Turbo": "baichuan 官方定价页；官方页未列缓存命中价，按输入价计",
  "baichuan::Baichuan4-Air": "baichuan 官方定价页；官方页未列缓存命中价，按输入价计",
  "baichuan::Baichuan4-Turbo": "baichuan 官方定价页；官方页未列缓存命中价，按输入价计",
  "claude-3-5-haiku": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Haiku 3.5 (retired, except on Bedrock and Google Cloud)",
  "claude-fable-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Fable 5",
  "claude-fable-5-1": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Fable 5.1",
  "claude-haiku-4-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Haiku 4.5",
  "claude-mythos-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Mythos 5 (limited availability)",
  "claude-mythos-5-1": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Mythos 5.1 (limited availability)",
  "claude-opus-4-1": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 4.1 (retired, except on Bedrock and Google Cloud)",
  "claude-opus-4-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 4.5",
  "claude-opus-4-6": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 4.6",
  "claude-opus-4-7": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 4.7",
  "claude-opus-4-8": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 4.8",
  "claude-opus-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Opus 5",
  "claude-sonnet-4-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Sonnet 4.5",
  "claude-sonnet-4-6": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Sonnet 4.6",
  "claude-sonnet-5": "anthropic 官方定价页；官方美元价 ×6.8 折算；官方名 Claude Sonnet 5",
  "codestral-latest": "mistral 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Codestral",
  "dashscope::kimi-k2.5": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "dashscope::qwen-flash": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen-long": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "dashscope::qwen-max": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "dashscope::qwen-plus": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen-turbo": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen-vl-max": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "dashscope::qwen-vl-plus": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "dashscope::qwen3-coder-flash": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen3-coder-plus": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen3-max": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen3-vl-plus": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen3.5-flash": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen3.5-omni-flash": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "dashscope::qwen3.5-omni-plus": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "dashscope::qwen3.5-plus": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen3.6-flash": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen3.6-max-preview": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen3.6-plus": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen3.8-flash": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwen3.8-max": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "dashscope::qwq-plus": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "deepseek-flash": "deepseek 官方定价页；峰谷计价（高峰为北京时间周一至周五 9:00-12:00、14:00-18:00，空闲价为高峰一半）",
  "deepseek-v4-flash": "deepseek 官方定价页；峰谷计价（高峰为北京时间周一至周五 9:00-12:00、14:00-18:00，空闲价为高峰一半）；旧名；官方页注(1)：模型已下线，请求由 DeepSeek-V4.1-Flash 服务并按 Flash 价计费",
  "deepseek-v4-flash-vision-exp": "deepseek 官方定价页；峰谷计价（高峰为北京时间周一至周五 9:00-12:00、14:00-18:00，空闲价为高峰一半）；旧名；官方页注(1)：同上",
  "deepseek-v4-pro": "deepseek 官方定价页；峰谷计价（高峰为北京时间周一至周五 9:00-12:00、14:00-18:00，空闲价为高峰一半）",
  "deepseek::deepseek-flash": "deepseek 官方定价页；峰谷计价（高峰为北京时间周一至周五 9:00-12:00、14:00-18:00，空闲价为高峰一半）",
  "deepseek::deepseek-v4-flash": "deepseek 官方定价页；峰谷计价（高峰为北京时间周一至周五 9:00-12:00、14:00-18:00，空闲价为高峰一半）；旧名；官方页注(1)：模型已下线，请求由 DeepSeek-V4.1-Flash 服务并按 Flash 价计费",
  "deepseek::deepseek-v4-flash-vision-exp": "deepseek 官方定价页；峰谷计价（高峰为北京时间周一至周五 9:00-12:00、14:00-18:00，空闲价为高峰一半）；旧名；官方页注(1)：同上",
  "deepseek::deepseek-v4-pro": "deepseek 官方定价页；峰谷计价（高峰为北京时间周一至周五 9:00-12:00、14:00-18:00，空闲价为高峰一半）",
  "doubao-pro-32k": "volcengine 官方定价页",
  "doubao-seed-2-1-pro": "volcengine 官方定价页；官方名 doubao-seed-2.1-pro",
  "doubao-seed-2-1-turbo": "volcengine 官方定价页；官方名 doubao-seed-2.1-turbo",
  "gemini-2.5-flash": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 2.5 Flash",
  "gemini-2.5-flash-lite": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 2.5 Flash-Lite",
  "gemini-2.5-pro": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 2.5 Pro",
  "gemini-3-flash-preview": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 3 Flash Preview",
  "gemini-3.1-flash-lite-preview": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 3.1 Flash-Lite (page lists model id gemini-3.1-flash-lite)",
  "gemini-3.1-pro-preview": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 3.1 Pro Preview",
  "gemini-3.7-flash": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 3.7 Flash",
  "gemini-3.8-flash": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 3.8 Flash",
  "gemini::gemini-2.5-flash": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 2.5 Flash",
  "gemini::gemini-2.5-flash-lite": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 2.5 Flash-Lite",
  "gemini::gemini-2.5-pro": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 2.5 Pro",
  "gemini::gemini-3-flash-preview": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 3 Flash Preview",
  "gemini::gemini-3.1-flash-lite-preview": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 3.1 Flash-Lite (page lists model id gemini-3.1-flash-lite)",
  "gemini::gemini-3.1-pro-preview": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 3.1 Pro Preview",
  "gemini::gemini-3.7-flash": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 3.7 Flash",
  "gemini::gemini-3.8-flash": "gemini 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Gemini 3.8 Flash",
  "glm-4-flash": "zhipu 官方定价页；官方页未列缓存命中价，按输入价计；官方名 GLM-4-Flash-250414",
  "glm-4-plus": "zhipu 官方定价页；官方名 GLM-4-Plus",
  "glm-4.6": "Z.ai 官方美元价换算（国内计价页未收录文本按量价）",
  "glm-4.7": "zhipu 官方定价页；分段计价，此处为主档，完整分档见 tiers；官方名 GLM-4.7",
  "glm-4.7-flash": "zhipu 官方定价页；官方名 GLM-4.7-Flash",
  "glm-5": "zhipu 官方定价页；分段计价，此处为主档，完整分档见 tiers；官方名 GLM-5",
  "glm-5-turbo": "zhipu 官方定价页；分段计价，此处为主档，完整分档见 tiers；官方名 GLM-5-Turbo",
  "glm-5.1": "zhipu 官方定价页；分段计价，此处为主档，完整分档见 tiers；官方名 GLM-5.1",
  "glm-5.2": "zhipu 官方定价页；官方名 GLM-5.2",
  "glm-5.3": "zhipu 官方定价页；官方名 GLM-5.3",
  "glm-5.3-flash": "zhipu 官方定价页；官方名 GLM-5.3-Flash",
  "glm-5v-turbo": "zhipu 官方定价页；分段计价，此处为主档，完整分档见 tiers；官方名 GLM-5V-Turbo",
  "gpt-4.1": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-4.1-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-4.1-nano": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-4o": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-4o-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-5": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-5-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-5-nano": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-5.1": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-5.2": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-5.3-codex": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-5.4": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "gpt-5.4-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-5.4-nano": "openai 官方定价页；官方美元价 ×6.8 折算",
  "gpt-5.5": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "gpt-5.6-luna": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "gpt-5.6-sol": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "gpt-5.6-terra": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "gpt-6-astra": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "grok-4.20-non-reasoning": "xai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 grok-4.20-0309-non-reasoning",
  "grok-4.20-reasoning": "xai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 grok-4.20-0309-reasoning",
  "grok-4.3": "xai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "grok-4.5": "xai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "grok-4.6": "xai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "groq::openai/gpt-oss-120b": "groq 官方定价页；官方美元价 ×6.8 折算；官方名 GPT OSS 120B (openai/gpt-oss-120b)",
  "groq::openai/gpt-oss-20b": "groq 官方定价页；官方美元价 ×6.8 折算；官方名 GPT OSS 20B (openai/gpt-oss-20b)",
  "kimi-k2.5": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "kimi-k2.6": "moonshot 官方定价页",
  "kimi-k2.7-code": "官方定价",
  "mimo-v2.5": "mimo 官方定价页",
  "mimo-v2.5-pro": "mimo 官方定价页",
  "mimo::mimo-v2.5": "mimo 官方定价页",
  "mimo::mimo-v2.5-pro": "mimo 官方定价页",
  "minimax::MiniMax-M2": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "minimax::MiniMax-M2.1": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "minimax::MiniMax-M2.5": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "minimax::MiniMax-M2.5-highspeed": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "minimax::MiniMax-M2.7": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "minimax::MiniMax-M2.7-highspeed": "minimax 官方定价页；官方美元价 ×6.8 折算",
  "minimax::MiniMax-M3": "minimax 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "mistral-large-3": "mistral 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Mistral Large 3",
  "mistral-large-latest": "mistral 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Mistral Large 3",
  "mistral-medium-latest": "mistral 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Mistral Medium 3.5",
  "mistral-small-latest": "mistral 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Mistral Small 4",
  "mistral::codestral-latest": "mistral 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Codestral",
  "mistral::mistral-large-3": "mistral 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Mistral Large 3",
  "mistral::mistral-large-latest": "mistral 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Mistral Large 3",
  "mistral::mistral-medium-latest": "mistral 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Mistral Medium 3.5",
  "mistral::mistral-small-latest": "mistral 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 Mistral Small 4",
  "moonshot::kimi-k2.6": "moonshot 官方定价页",
  "moonshot::kimi-k2.7-code": "官方定价",
  "o3": "openai 官方定价页；官方美元价 ×6.8 折算",
  "o3-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "o4-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "ollama::qwen3:8b": "本地推理，无 API 费用（不走官方按量计费）",
  "openai/gpt-oss-120b": "groq 官方定价页；官方美元价 ×6.8 折算；官方名 GPT OSS 120B (openai/gpt-oss-120b)",
  "openai/gpt-oss-20b": "groq 官方定价页；官方美元价 ×6.8 折算；官方名 GPT OSS 20B (openai/gpt-oss-20b)",
  "openai::gpt-4.1": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-4.1-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-4.1-nano": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-4o": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-4o-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-5": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-5-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-5-nano": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-5.1": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-5.2": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-5.3-codex": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-5.4": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "openai::gpt-5.4-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-5.4-nano": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::gpt-5.5": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "openai::gpt-5.6-luna": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "openai::gpt-5.6-sol": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "openai::gpt-5.6-terra": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "openai::gpt-6-astra": "openai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "openai::o3": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::o3-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "openai::o4-mini": "openai 官方定价页；官方美元价 ×6.8 折算",
  "perplexity::sonar": "perplexity 官方定价页；官方美元价 ×6.8 折算；官方页未列缓存命中价，按输入价计；官方名 Sonar",
  "perplexity::sonar-deep-research": "perplexity 官方定价页；官方美元价 ×6.8 折算；官方页未列缓存命中价，按输入价计；官方名 Sonar Deep Research",
  "perplexity::sonar-pro": "perplexity 官方定价页；官方美元价 ×6.8 折算；官方页未列缓存命中价，按输入价计；官方名 Sonar Pro",
  "perplexity::sonar-reasoning-pro": "perplexity 官方定价页；官方美元价 ×6.8 折算；官方页未列缓存命中价，按输入价计；官方名 Sonar Reasoning Pro",
  "qwen-flash": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen-long": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "qwen-max": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "qwen-plus": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen-turbo": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen-vl-max": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "qwen-vl-plus": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "qwen3-coder-flash": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3-coder-plus": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3-max": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3-vl-plus": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3.5-flash": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3.5-omni-flash": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "qwen3.5-omni-plus": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "qwen3.5-plus": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3.6-flash": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3.6-max-preview": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3.6-plus": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3.8-flash": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3.8-max": "dashscope 官方定价页；分段计价，此处为主档，完整分档见 tiers",
  "qwen3:8b": "本地推理，无 API 费用（不走官方按量计费）",
  "qwq-plus": "dashscope 官方定价页；官方页未列缓存命中价，按输入价计",
  "sonar": "perplexity 官方定价页；官方美元价 ×6.8 折算；官方页未列缓存命中价，按输入价计；官方名 Sonar",
  "sonar-deep-research": "perplexity 官方定价页；官方美元价 ×6.8 折算；官方页未列缓存命中价，按输入价计；官方名 Sonar Deep Research",
  "sonar-pro": "perplexity 官方定价页；官方美元价 ×6.8 折算；官方页未列缓存命中价，按输入价计；官方名 Sonar Pro",
  "sonar-reasoning-pro": "perplexity 官方定价页；官方美元价 ×6.8 折算；官方页未列缓存命中价，按输入价计；官方名 Sonar Reasoning Pro",
  "step-3.5-flash": "stepfun 官方定价页",
  "stepfun::step-3.5-flash": "stepfun 官方定价页",
  "volcengine::doubao-pro-32k": "volcengine 官方定价页",
  "volcengine::doubao-seed-2-1-pro": "volcengine 官方定价页；官方名 doubao-seed-2.1-pro",
  "volcengine::doubao-seed-2-1-turbo": "volcengine 官方定价页；官方名 doubao-seed-2.1-turbo",
  "xai::grok-4.20-non-reasoning": "xai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 grok-4.20-0309-non-reasoning",
  "xai::grok-4.20-reasoning": "xai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers；官方名 grok-4.20-0309-reasoning",
  "xai::grok-4.3": "xai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "xai::grok-4.5": "xai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "xai::grok-4.6": "xai 官方定价页；官方美元价 ×6.8 折算；分段计价，此处为主档，完整分档见 tiers",
  "zhipu::glm-4-flash": "zhipu 官方定价页；官方页未列缓存命中价，按输入价计；官方名 GLM-4-Flash-250414",
  "zhipu::glm-4-plus": "zhipu 官方定价页；官方名 GLM-4-Plus",
  "zhipu::glm-4.6": "Z.ai 官方美元价换算（国内计价页未收录文本按量价）",
  "zhipu::glm-4.7": "zhipu 官方定价页；分段计价，此处为主档，完整分档见 tiers；官方名 GLM-4.7",
  "zhipu::glm-4.7-flash": "zhipu 官方定价页；官方名 GLM-4.7-Flash",
  "zhipu::glm-5": "zhipu 官方定价页；分段计价，此处为主档，完整分档见 tiers；官方名 GLM-5",
  "zhipu::glm-5-turbo": "zhipu 官方定价页；分段计价，此处为主档，完整分档见 tiers；官方名 GLM-5-Turbo",
  "zhipu::glm-5.1": "zhipu 官方定价页；分段计价，此处为主档，完整分档见 tiers；官方名 GLM-5.1",
  "zhipu::glm-5.2": "zhipu 官方定价页；官方名 GLM-5.2",
  "zhipu::glm-5.3": "zhipu 官方定价页；官方名 GLM-5.3",
  "zhipu::glm-5.3-flash": "zhipu 官方定价页；官方名 GLM-5.3-Flash",
  "zhipu::glm-5v-turbo": "zhipu 官方定价页；分段计价，此处为主档，完整分档见 tiers；官方名 GLM-5V-Turbo",
};

// 单价（元/百万 tokens）。键为「供应商::模型」限定键；全库唯一的模型另有裸键，供旧版回退。
let PRICING = {
  "Baichuan3-Turbo": { inputMiss: 12, inputHit: 12, output: 12 },
  "Baichuan4-Air": { inputMiss: 0.98, inputHit: 0.98, output: 0.98 },
  "Baichuan4-Turbo": { inputMiss: 15, inputHit: 15, output: 15 },
  "MiniMax-M2": { inputMiss: 2.04, inputHit: 0.2, output: 8.16 },
  "MiniMax-M2.1": { inputMiss: 2.04, inputHit: 0.2, output: 8.16 },
  "MiniMax-M2.5": { inputMiss: 2.04, inputHit: 0.2, output: 8.16 },
  "MiniMax-M2.5-highspeed": { inputMiss: 4.08, inputHit: 0.2, output: 16.32 },
  "MiniMax-M2.7": { inputMiss: 2.04, inputHit: 0.41, output: 8.16 },
  "MiniMax-M2.7-highspeed": { inputMiss: 4.08, inputHit: 0.41, output: 16.32 },
  "MiniMax-M3": { inputMiss: 2.04, inputHit: 0.41, output: 8.16 },
  "agnes-2.5-flash": { inputMiss: 0.34, inputHit: 0.03, output: 1.02 },
  "agnes-2.5-pro-alpha": { inputMiss: 3, inputHit: 0.025, output: 6 },
  "agnes-image-2.1-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "agnes-video-v2.0": { inputMiss: 0, inputHit: 0, output: 0 },
  "agnes::agnes-2.5-flash": { inputMiss: 0.34, inputHit: 0.03, output: 1.02 },
  "agnes::agnes-2.5-pro-alpha": { inputMiss: 3, inputHit: 0.025, output: 6 },
  "agnes::agnes-image-2.1-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "agnes::agnes-video-v2.0": { inputMiss: 0, inputHit: 0, output: 0 },
  "anthropic::claude-3-5-haiku": { inputMiss: 5.44, inputHit: 0.54, output: 27.2 },
  "anthropic::claude-fable-5": { inputMiss: 68, inputHit: 6.8, output: 340 },
  "anthropic::claude-fable-5-1": { inputMiss: 68, inputHit: 1.7, output: 340 },
  "anthropic::claude-haiku-4-5": { inputMiss: 6.8, inputHit: 0.68, output: 34 },
  "anthropic::claude-mythos-5": { inputMiss: 68, inputHit: 6.8, output: 340 },
  "anthropic::claude-mythos-5-1": { inputMiss: 68, inputHit: 1.7, output: 340 },
  "anthropic::claude-opus-4-1": { inputMiss: 102, inputHit: 10.2, output: 510 },
  "anthropic::claude-opus-4-5": { inputMiss: 34, inputHit: 3.4, output: 170 },
  "anthropic::claude-opus-4-6": { inputMiss: 34, inputHit: 3.4, output: 170 },
  "anthropic::claude-opus-4-7": { inputMiss: 34, inputHit: 3.4, output: 170 },
  "anthropic::claude-opus-4-8": { inputMiss: 34, inputHit: 3.4, output: 170 },
  "anthropic::claude-opus-5": { inputMiss: 34, inputHit: 3.4, output: 170 },
  "anthropic::claude-sonnet-4-5": { inputMiss: 20.4, inputHit: 2.04, output: 102 },
  "anthropic::claude-sonnet-4-6": { inputMiss: 20.4, inputHit: 2.04, output: 102 },
  "anthropic::claude-sonnet-5": { inputMiss: 13.6, inputHit: 1.36, output: 68 },
  "baichuan::Baichuan3-Turbo": { inputMiss: 12, inputHit: 12, output: 12 },
  "baichuan::Baichuan4-Air": { inputMiss: 0.98, inputHit: 0.98, output: 0.98 },
  "baichuan::Baichuan4-Turbo": { inputMiss: 15, inputHit: 15, output: 15 },
  "claude-3-5-haiku": { inputMiss: 5.44, inputHit: 0.54, output: 27.2 },
  "claude-fable-5": { inputMiss: 68, inputHit: 6.8, output: 340 },
  "claude-fable-5-1": { inputMiss: 68, inputHit: 1.7, output: 340 },
  "claude-haiku-4-5": { inputMiss: 6.8, inputHit: 0.68, output: 34 },
  "claude-mythos-5": { inputMiss: 68, inputHit: 6.8, output: 340 },
  "claude-mythos-5-1": { inputMiss: 68, inputHit: 1.7, output: 340 },
  "claude-opus-4-1": { inputMiss: 102, inputHit: 10.2, output: 510 },
  "claude-opus-4-5": { inputMiss: 34, inputHit: 3.4, output: 170 },
  "claude-opus-4-6": { inputMiss: 34, inputHit: 3.4, output: 170 },
  "claude-opus-4-7": { inputMiss: 34, inputHit: 3.4, output: 170 },
  "claude-opus-4-8": { inputMiss: 34, inputHit: 3.4, output: 170 },
  "claude-opus-5": { inputMiss: 34, inputHit: 3.4, output: 170 },
  "claude-sonnet-4-5": { inputMiss: 20.4, inputHit: 2.04, output: 102 },
  "claude-sonnet-4-6": { inputMiss: 20.4, inputHit: 2.04, output: 102 },
  "claude-sonnet-5": { inputMiss: 13.6, inputHit: 1.36, output: 68 },
  "codestral-latest": { inputMiss: 2.04, inputHit: 0.2, output: 6.12 },
  "dashscope::kimi-k2.5": { inputMiss: 4, inputHit: 4, output: 21 },
  "dashscope::qwen-flash": { inputMiss: 0.15, inputHit: 0.15, output: 1.5 },
  "dashscope::qwen-long": { inputMiss: 0.5, inputHit: 0.5, output: 2 },
  "dashscope::qwen-max": { inputMiss: 2.4, inputHit: 2.4, output: 9.6 },
  "dashscope::qwen-plus": { inputMiss: 0.8, inputHit: 0.8, output: 2 },
  "dashscope::qwen-turbo": { inputMiss: 0.3, inputHit: 0.3, output: 0.6 },
  "dashscope::qwen-vl-max": { inputMiss: 1.6, inputHit: 1.6, output: 4 },
  "dashscope::qwen-vl-plus": { inputMiss: 0.8, inputHit: 0.8, output: 2 },
  "dashscope::qwen3-coder-flash": { inputMiss: 1, inputHit: 1, output: 4 },
  "dashscope::qwen3-coder-plus": { inputMiss: 4, inputHit: 4, output: 16 },
  "dashscope::qwen3-max": { inputMiss: 2.5, inputHit: 2.5, output: 10 },
  "dashscope::qwen3-vl-plus": { inputMiss: 1, inputHit: 1, output: 10 },
  "dashscope::qwen3.5-flash": { inputMiss: 0.2, inputHit: 0.2, output: 2 },
  "dashscope::qwen3.5-omni-flash": { inputMiss: 2.2, inputHit: 2.2, output: 18 },
  "dashscope::qwen3.5-omni-plus": { inputMiss: 7, inputHit: 7, output: 40 },
  "dashscope::qwen3.5-plus": { inputMiss: 0.8, inputHit: 0.8, output: 4.8 },
  "dashscope::qwen3.6-flash": { inputMiss: 1.2, inputHit: 1.2, output: 7.2 },
  "dashscope::qwen3.6-max-preview": { inputMiss: 9, inputHit: 9, output: 54 },
  "dashscope::qwen3.6-plus": { inputMiss: 2, inputHit: 2, output: 12 },
  "dashscope::qwen3.8-flash": { inputMiss: 0.8, inputHit: 0.8, output: 2.7 },
  "dashscope::qwen3.8-max": { inputMiss: 12, inputHit: 12, output: 36 },
  "dashscope::qwq-plus": { inputMiss: 1.6, inputHit: 1.6, output: 4 },
  "deepseek-flash": {
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    offPeak: { inputMiss: 1, inputHit: 0.02, output: 4 },
  },
  "deepseek-v4-flash": {
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    offPeak: { inputMiss: 1, inputHit: 0.02, output: 4 },
  },
  "deepseek-v4-flash-vision-exp": {
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    offPeak: { inputMiss: 1, inputHit: 0.02, output: 4 },
  },
  "deepseek-v4-pro": {
    peak: { inputMiss: 9, inputHit: 0.3, output: 27 },
    offPeak: { inputMiss: 4.5, inputHit: 0.15, output: 13.5 },
  },
  "deepseek::deepseek-flash": {
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    offPeak: { inputMiss: 1, inputHit: 0.02, output: 4 },
  },
  "deepseek::deepseek-v4-flash": {
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    offPeak: { inputMiss: 1, inputHit: 0.02, output: 4 },
  },
  "deepseek::deepseek-v4-flash-vision-exp": {
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    offPeak: { inputMiss: 1, inputHit: 0.02, output: 4 },
  },
  "deepseek::deepseek-v4-pro": {
    peak: { inputMiss: 9, inputHit: 0.3, output: 27 },
    offPeak: { inputMiss: 4.5, inputHit: 0.15, output: 13.5 },
  },
  "doubao-pro-32k": { inputMiss: 0.8, inputHit: 0.16, output: 2 },
  "doubao-seed-2-1-pro": { inputMiss: 6, inputHit: 1.2, output: 30 },
  "doubao-seed-2-1-turbo": { inputMiss: 3, inputHit: 0.6, output: 15 },
  "gemini-2.5-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini-2.5-flash-lite": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini-2.5-pro": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini-3-flash-preview": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini-3.1-flash-lite-preview": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini-3.1-pro-preview": { inputMiss: 27.2, inputHit: 2.72, output: 122.4 },
  "gemini-3.7-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini-3.8-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini::gemini-2.5-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini::gemini-2.5-flash-lite": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini::gemini-2.5-pro": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini::gemini-3-flash-preview": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini::gemini-3.1-flash-lite-preview": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini::gemini-3.1-pro-preview": { inputMiss: 27.2, inputHit: 2.72, output: 122.4 },
  "gemini::gemini-3.7-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "gemini::gemini-3.8-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "glm-4-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "glm-4-plus": { inputMiss: 5, inputHit: 2.5, output: 5 },
  "glm-4.6": { inputMiss: 4, inputHit: 0.74, output: 14.8 },
  "glm-4.7": { inputMiss: 2, inputHit: 0.4, output: 8 },
  "glm-4.7-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "glm-5": { inputMiss: 4, inputHit: 1, output: 18 },
  "glm-5-turbo": { inputMiss: 5, inputHit: 1.2, output: 22 },
  "glm-5.1": { inputMiss: 6, inputHit: 1.3, output: 24 },
  "glm-5.2": { inputMiss: 8, inputHit: 2, output: 28 },
  "glm-5.3": { inputMiss: 8, inputHit: 2, output: 28 },
  "glm-5.3-flash": { inputMiss: 0.8, inputHit: 0.23, output: 2.8 },
  "glm-5v-turbo": { inputMiss: 5, inputHit: 1.2, output: 22 },
  "gpt-4.1": { inputMiss: 13.6, inputHit: 3.4, output: 54.4 },
  "gpt-4.1-mini": { inputMiss: 2.72, inputHit: 0.68, output: 10.88 },
  "gpt-4.1-nano": { inputMiss: 0.68, inputHit: 0.17, output: 2.72 },
  "gpt-4o": { inputMiss: 17, inputHit: 8.5, output: 68 },
  "gpt-4o-mini": { inputMiss: 1.02, inputHit: 0.51, output: 4.08 },
  "gpt-5": { inputMiss: 8.5, inputHit: 0.85, output: 68 },
  "gpt-5-mini": { inputMiss: 1.7, inputHit: 0.17, output: 13.6 },
  "gpt-5-nano": { inputMiss: 0.34, inputHit: 0.03, output: 2.72 },
  "gpt-5.1": { inputMiss: 8.5, inputHit: 0.85, output: 68 },
  "gpt-5.2": { inputMiss: 11.9, inputHit: 1.19, output: 95.2 },
  "gpt-5.3-codex": { inputMiss: 11.9, inputHit: 1.19, output: 95.2 },
  "gpt-5.4": { inputMiss: 17, inputHit: 1.7, output: 102 },
  "gpt-5.4-mini": { inputMiss: 5.1, inputHit: 0.51, output: 30.6 },
  "gpt-5.4-nano": { inputMiss: 1.36, inputHit: 0.14, output: 8.5 },
  "gpt-5.5": { inputMiss: 34, inputHit: 3.4, output: 204 },
  "gpt-5.6-luna": { inputMiss: 1.36, inputHit: 0.14, output: 8.16 },
  "gpt-5.6-sol": { inputMiss: 27.2, inputHit: 2.72, output: 136 },
  "gpt-5.6-terra": { inputMiss: 13.6, inputHit: 1.36, output: 81.6 },
  "gpt-6-astra": { inputMiss: 68, inputHit: 6.8, output: 340 },
  "grok-4.20-non-reasoning": { inputMiss: 8.5, inputHit: 1.36, output: 17 },
  "grok-4.20-reasoning": { inputMiss: 8.5, inputHit: 1.36, output: 17 },
  "grok-4.3": { inputMiss: 8.5, inputHit: 1.36, output: 17 },
  "grok-4.5": { inputMiss: 13.6, inputHit: 2.04, output: 40.8 },
  "grok-4.6": { inputMiss: 13.6, inputHit: 3.4, output: 40.8 },
  "groq::openai/gpt-oss-120b": { inputMiss: 1.02, inputHit: 0.51, output: 4.08 },
  "groq::openai/gpt-oss-20b": { inputMiss: 0.51, inputHit: 0.25, output: 2.04 },
  "kimi-k2.5": { inputMiss: 4, inputHit: 4, output: 21 },
  "kimi-k2.6": { inputMiss: 6.5, inputHit: 1.1, output: 27 },
  "kimi-k2.7-code": { inputMiss: 6.5, inputHit: 1.3, output: 27 },
  "mimo-v2.5": { inputMiss: 1, inputHit: 0.02, output: 2 },
  "mimo-v2.5-pro": { inputMiss: 3, inputHit: 0.03, output: 6 },
  "mimo::mimo-v2.5": { inputMiss: 1, inputHit: 0.02, output: 2 },
  "mimo::mimo-v2.5-pro": { inputMiss: 3, inputHit: 0.03, output: 6 },
  "minimax::MiniMax-M2": { inputMiss: 2.04, inputHit: 0.2, output: 8.16 },
  "minimax::MiniMax-M2.1": { inputMiss: 2.04, inputHit: 0.2, output: 8.16 },
  "minimax::MiniMax-M2.5": { inputMiss: 2.04, inputHit: 0.2, output: 8.16 },
  "minimax::MiniMax-M2.5-highspeed": { inputMiss: 4.08, inputHit: 0.2, output: 16.32 },
  "minimax::MiniMax-M2.7": { inputMiss: 2.04, inputHit: 0.41, output: 8.16 },
  "minimax::MiniMax-M2.7-highspeed": { inputMiss: 4.08, inputHit: 0.41, output: 16.32 },
  "minimax::MiniMax-M3": { inputMiss: 2.04, inputHit: 0.41, output: 8.16 },
  "mistral-large-3": { inputMiss: 3.4, inputHit: 0.34, output: 10.2 },
  "mistral-large-latest": { inputMiss: 3.4, inputHit: 0.34, output: 10.2 },
  "mistral-medium-latest": { inputMiss: 10.2, inputHit: 1.02, output: 51 },
  "mistral-small-latest": { inputMiss: 1.02, inputHit: 0.1, output: 4.08 },
  "mistral::codestral-latest": { inputMiss: 2.04, inputHit: 0.2, output: 6.12 },
  "mistral::mistral-large-3": { inputMiss: 3.4, inputHit: 0.34, output: 10.2 },
  "mistral::mistral-large-latest": { inputMiss: 3.4, inputHit: 0.34, output: 10.2 },
  "mistral::mistral-medium-latest": { inputMiss: 10.2, inputHit: 1.02, output: 51 },
  "mistral::mistral-small-latest": { inputMiss: 1.02, inputHit: 0.1, output: 4.08 },
  "moonshot::kimi-k2.6": { inputMiss: 6.5, inputHit: 1.1, output: 27 },
  "moonshot::kimi-k2.7-code": { inputMiss: 6.5, inputHit: 1.3, output: 27 },
  "o3": { inputMiss: 13.6, inputHit: 3.4, output: 54.4 },
  "o3-mini": { inputMiss: 7.48, inputHit: 3.74, output: 29.92 },
  "o4-mini": { inputMiss: 7.48, inputHit: 1.87, output: 29.92 },
  "ollama::qwen3:8b": { inputMiss: 0, inputHit: 0, output: 0 },
  "openai/gpt-oss-120b": { inputMiss: 1.02, inputHit: 0.51, output: 4.08 },
  "openai/gpt-oss-20b": { inputMiss: 0.51, inputHit: 0.25, output: 2.04 },
  "openai::gpt-4.1": { inputMiss: 13.6, inputHit: 3.4, output: 54.4 },
  "openai::gpt-4.1-mini": { inputMiss: 2.72, inputHit: 0.68, output: 10.88 },
  "openai::gpt-4.1-nano": { inputMiss: 0.68, inputHit: 0.17, output: 2.72 },
  "openai::gpt-4o": { inputMiss: 17, inputHit: 8.5, output: 68 },
  "openai::gpt-4o-mini": { inputMiss: 1.02, inputHit: 0.51, output: 4.08 },
  "openai::gpt-5": { inputMiss: 8.5, inputHit: 0.85, output: 68 },
  "openai::gpt-5-mini": { inputMiss: 1.7, inputHit: 0.17, output: 13.6 },
  "openai::gpt-5-nano": { inputMiss: 0.34, inputHit: 0.03, output: 2.72 },
  "openai::gpt-5.1": { inputMiss: 8.5, inputHit: 0.85, output: 68 },
  "openai::gpt-5.2": { inputMiss: 11.9, inputHit: 1.19, output: 95.2 },
  "openai::gpt-5.3-codex": { inputMiss: 11.9, inputHit: 1.19, output: 95.2 },
  "openai::gpt-5.4": { inputMiss: 17, inputHit: 1.7, output: 102 },
  "openai::gpt-5.4-mini": { inputMiss: 5.1, inputHit: 0.51, output: 30.6 },
  "openai::gpt-5.4-nano": { inputMiss: 1.36, inputHit: 0.14, output: 8.5 },
  "openai::gpt-5.5": { inputMiss: 34, inputHit: 3.4, output: 204 },
  "openai::gpt-5.6-luna": { inputMiss: 1.36, inputHit: 0.14, output: 8.16 },
  "openai::gpt-5.6-sol": { inputMiss: 27.2, inputHit: 2.72, output: 136 },
  "openai::gpt-5.6-terra": { inputMiss: 13.6, inputHit: 1.36, output: 81.6 },
  "openai::gpt-6-astra": { inputMiss: 68, inputHit: 6.8, output: 340 },
  "openai::o3": { inputMiss: 13.6, inputHit: 3.4, output: 54.4 },
  "openai::o3-mini": { inputMiss: 7.48, inputHit: 3.74, output: 29.92 },
  "openai::o4-mini": { inputMiss: 7.48, inputHit: 1.87, output: 29.92 },
  "perplexity::sonar": { inputMiss: 6.8, inputHit: 6.8, output: 6.8 },
  "perplexity::sonar-deep-research": { inputMiss: 13.6, inputHit: 13.6, output: 54.4 },
  "perplexity::sonar-pro": { inputMiss: 20.4, inputHit: 20.4, output: 102 },
  "perplexity::sonar-reasoning-pro": { inputMiss: 13.6, inputHit: 13.6, output: 54.4 },
  "qwen-flash": { inputMiss: 0.15, inputHit: 0.15, output: 1.5 },
  "qwen-long": { inputMiss: 0.5, inputHit: 0.5, output: 2 },
  "qwen-max": { inputMiss: 2.4, inputHit: 2.4, output: 9.6 },
  "qwen-plus": { inputMiss: 0.8, inputHit: 0.8, output: 2 },
  "qwen-turbo": { inputMiss: 0.3, inputHit: 0.3, output: 0.6 },
  "qwen-vl-max": { inputMiss: 1.6, inputHit: 1.6, output: 4 },
  "qwen-vl-plus": { inputMiss: 0.8, inputHit: 0.8, output: 2 },
  "qwen3-coder-flash": { inputMiss: 1, inputHit: 1, output: 4 },
  "qwen3-coder-plus": { inputMiss: 4, inputHit: 4, output: 16 },
  "qwen3-max": { inputMiss: 2.5, inputHit: 2.5, output: 10 },
  "qwen3-vl-plus": { inputMiss: 1, inputHit: 1, output: 10 },
  "qwen3.5-flash": { inputMiss: 0.2, inputHit: 0.2, output: 2 },
  "qwen3.5-omni-flash": { inputMiss: 2.2, inputHit: 2.2, output: 18 },
  "qwen3.5-omni-plus": { inputMiss: 7, inputHit: 7, output: 40 },
  "qwen3.5-plus": { inputMiss: 0.8, inputHit: 0.8, output: 4.8 },
  "qwen3.6-flash": { inputMiss: 1.2, inputHit: 1.2, output: 7.2 },
  "qwen3.6-max-preview": { inputMiss: 9, inputHit: 9, output: 54 },
  "qwen3.6-plus": { inputMiss: 2, inputHit: 2, output: 12 },
  "qwen3.8-flash": { inputMiss: 0.8, inputHit: 0.8, output: 2.7 },
  "qwen3.8-max": { inputMiss: 12, inputHit: 12, output: 36 },
  "qwen3:8b": { inputMiss: 0, inputHit: 0, output: 0 },
  "qwq-plus": { inputMiss: 1.6, inputHit: 1.6, output: 4 },
  "sonar": { inputMiss: 6.8, inputHit: 6.8, output: 6.8 },
  "sonar-deep-research": { inputMiss: 13.6, inputHit: 13.6, output: 54.4 },
  "sonar-pro": { inputMiss: 20.4, inputHit: 20.4, output: 102 },
  "sonar-reasoning-pro": { inputMiss: 13.6, inputHit: 13.6, output: 54.4 },
  "step-3.5-flash": { inputMiss: 0.7, inputHit: 0.14, output: 2.1 },
  "stepfun::step-3.5-flash": { inputMiss: 0.7, inputHit: 0.14, output: 2.1 },
  "volcengine::doubao-pro-32k": { inputMiss: 0.8, inputHit: 0.16, output: 2 },
  "volcengine::doubao-seed-2-1-pro": { inputMiss: 6, inputHit: 1.2, output: 30 },
  "volcengine::doubao-seed-2-1-turbo": { inputMiss: 3, inputHit: 0.6, output: 15 },
  "xai::grok-4.20-non-reasoning": { inputMiss: 8.5, inputHit: 1.36, output: 17 },
  "xai::grok-4.20-reasoning": { inputMiss: 8.5, inputHit: 1.36, output: 17 },
  "xai::grok-4.3": { inputMiss: 8.5, inputHit: 1.36, output: 17 },
  "xai::grok-4.5": { inputMiss: 13.6, inputHit: 2.04, output: 40.8 },
  "xai::grok-4.6": { inputMiss: 13.6, inputHit: 3.4, output: 40.8 },
  "zhipu::glm-4-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "zhipu::glm-4-plus": { inputMiss: 5, inputHit: 2.5, output: 5 },
  "zhipu::glm-4.6": { inputMiss: 4, inputHit: 0.74, output: 14.8 },
  "zhipu::glm-4.7": { inputMiss: 2, inputHit: 0.4, output: 8 },
  "zhipu::glm-4.7-flash": { inputMiss: 0, inputHit: 0, output: 0 },
  "zhipu::glm-5": { inputMiss: 4, inputHit: 1, output: 18 },
  "zhipu::glm-5-turbo": { inputMiss: 5, inputHit: 1.2, output: 22 },
  "zhipu::glm-5.1": { inputMiss: 6, inputHit: 1.3, output: 24 },
  "zhipu::glm-5.2": { inputMiss: 8, inputHit: 2, output: 28 },
  "zhipu::glm-5.3": { inputMiss: 8, inputHit: 2, output: 28 },
  "zhipu::glm-5.3-flash": { inputMiss: 0.8, inputHit: 0.23, output: 2.8 },
  "zhipu::glm-5v-turbo": { inputMiss: 5, inputHit: 1.2, output: 22 },
};

// 模型归属供应商（限定键同时登记裸键归属）
let PROVIDER_OF_MODEL = {
  "Baichuan3-Turbo": "baichuan",
  "Baichuan4-Air": "baichuan",
  "Baichuan4-Turbo": "baichuan",
  "MiniMax-M2": "minimax",
  "MiniMax-M2.1": "minimax",
  "MiniMax-M2.5": "minimax",
  "MiniMax-M2.5-highspeed": "minimax",
  "MiniMax-M2.7": "minimax",
  "MiniMax-M2.7-highspeed": "minimax",
  "MiniMax-M3": "minimax",
  "agnes-2.5-flash": "agnes",
  "agnes-2.5-pro-alpha": "agnes",
  "agnes-image-2.1-flash": "agnes",
  "agnes-video-v2.0": "agnes",
  "agnes::agnes-2.5-flash": "agnes",
  "agnes::agnes-2.5-pro-alpha": "agnes",
  "agnes::agnes-image-2.1-flash": "agnes",
  "agnes::agnes-video-v2.0": "agnes",
  "anthropic::claude-3-5-haiku": "anthropic",
  "anthropic::claude-fable-5": "anthropic",
  "anthropic::claude-fable-5-1": "anthropic",
  "anthropic::claude-haiku-4-5": "anthropic",
  "anthropic::claude-mythos-5": "anthropic",
  "anthropic::claude-mythos-5-1": "anthropic",
  "anthropic::claude-opus-4-1": "anthropic",
  "anthropic::claude-opus-4-5": "anthropic",
  "anthropic::claude-opus-4-6": "anthropic",
  "anthropic::claude-opus-4-7": "anthropic",
  "anthropic::claude-opus-4-8": "anthropic",
  "anthropic::claude-opus-5": "anthropic",
  "anthropic::claude-sonnet-4-5": "anthropic",
  "anthropic::claude-sonnet-4-6": "anthropic",
  "anthropic::claude-sonnet-5": "anthropic",
  "baichuan::Baichuan3-Turbo": "baichuan",
  "baichuan::Baichuan4-Air": "baichuan",
  "baichuan::Baichuan4-Turbo": "baichuan",
  "claude-3-5-haiku": "anthropic",
  "claude-fable-5": "anthropic",
  "claude-fable-5-1": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "claude-mythos-5": "anthropic",
  "claude-mythos-5-1": "anthropic",
  "claude-opus-4-1": "anthropic",
  "claude-opus-4-5": "anthropic",
  "claude-opus-4-6": "anthropic",
  "claude-opus-4-7": "anthropic",
  "claude-opus-4-8": "anthropic",
  "claude-opus-5": "anthropic",
  "claude-sonnet-4-5": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-sonnet-5": "anthropic",
  "codestral-latest": "mistral",
  "dashscope::kimi-k2.5": "dashscope",
  "dashscope::qwen-flash": "dashscope",
  "dashscope::qwen-long": "dashscope",
  "dashscope::qwen-max": "dashscope",
  "dashscope::qwen-plus": "dashscope",
  "dashscope::qwen-turbo": "dashscope",
  "dashscope::qwen-vl-max": "dashscope",
  "dashscope::qwen-vl-plus": "dashscope",
  "dashscope::qwen3-coder-flash": "dashscope",
  "dashscope::qwen3-coder-plus": "dashscope",
  "dashscope::qwen3-max": "dashscope",
  "dashscope::qwen3-vl-plus": "dashscope",
  "dashscope::qwen3.5-flash": "dashscope",
  "dashscope::qwen3.5-omni-flash": "dashscope",
  "dashscope::qwen3.5-omni-plus": "dashscope",
  "dashscope::qwen3.5-plus": "dashscope",
  "dashscope::qwen3.6-flash": "dashscope",
  "dashscope::qwen3.6-max-preview": "dashscope",
  "dashscope::qwen3.6-plus": "dashscope",
  "dashscope::qwen3.8-flash": "dashscope",
  "dashscope::qwen3.8-max": "dashscope",
  "dashscope::qwq-plus": "dashscope",
  "deepseek-flash": "deepseek",
  "deepseek-v4-flash": "deepseek",
  "deepseek-v4-flash-vision-exp": "deepseek",
  "deepseek-v4-pro": "deepseek",
  "deepseek::deepseek-flash": "deepseek",
  "deepseek::deepseek-v4-flash": "deepseek",
  "deepseek::deepseek-v4-flash-vision-exp": "deepseek",
  "deepseek::deepseek-v4-pro": "deepseek",
  "doubao-pro-32k": "volcengine",
  "doubao-seed-2-1-pro": "volcengine",
  "doubao-seed-2-1-turbo": "volcengine",
  "gemini-2.5-flash": "gemini",
  "gemini-2.5-flash-lite": "gemini",
  "gemini-2.5-pro": "gemini",
  "gemini-3-flash-preview": "gemini",
  "gemini-3.1-flash-lite-preview": "gemini",
  "gemini-3.1-pro-preview": "gemini",
  "gemini-3.7-flash": "gemini",
  "gemini-3.8-flash": "gemini",
  "gemini::gemini-2.5-flash": "gemini",
  "gemini::gemini-2.5-flash-lite": "gemini",
  "gemini::gemini-2.5-pro": "gemini",
  "gemini::gemini-3-flash-preview": "gemini",
  "gemini::gemini-3.1-flash-lite-preview": "gemini",
  "gemini::gemini-3.1-pro-preview": "gemini",
  "gemini::gemini-3.7-flash": "gemini",
  "gemini::gemini-3.8-flash": "gemini",
  "glm-4-flash": "zhipu",
  "glm-4-plus": "zhipu",
  "glm-4.6": "zhipu",
  "glm-4.7": "zhipu",
  "glm-4.7-flash": "zhipu",
  "glm-5": "zhipu",
  "glm-5-turbo": "zhipu",
  "glm-5.1": "zhipu",
  "glm-5.2": "zhipu",
  "glm-5.3": "zhipu",
  "glm-5.3-flash": "zhipu",
  "glm-5v-turbo": "zhipu",
  "gpt-4.1": "openai",
  "gpt-4.1-mini": "openai",
  "gpt-4.1-nano": "openai",
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-5": "openai",
  "gpt-5-mini": "openai",
  "gpt-5-nano": "openai",
  "gpt-5.1": "openai",
  "gpt-5.2": "openai",
  "gpt-5.3-codex": "openai",
  "gpt-5.4": "openai",
  "gpt-5.4-mini": "openai",
  "gpt-5.4-nano": "openai",
  "gpt-5.5": "openai",
  "gpt-5.6-luna": "openai",
  "gpt-5.6-sol": "openai",
  "gpt-5.6-terra": "openai",
  "gpt-6-astra": "openai",
  "grok-4.20-non-reasoning": "xai",
  "grok-4.20-reasoning": "xai",
  "grok-4.3": "xai",
  "grok-4.5": "xai",
  "grok-4.6": "xai",
  "groq::openai/gpt-oss-120b": "groq",
  "groq::openai/gpt-oss-20b": "groq",
  "kimi-k2.5": "dashscope",
  "kimi-k2.6": "moonshot",
  "kimi-k2.7-code": "moonshot",
  "mimo-v2.5": "mimo",
  "mimo-v2.5-pro": "mimo",
  "mimo::mimo-v2.5": "mimo",
  "mimo::mimo-v2.5-pro": "mimo",
  "minimax::MiniMax-M2": "minimax",
  "minimax::MiniMax-M2.1": "minimax",
  "minimax::MiniMax-M2.5": "minimax",
  "minimax::MiniMax-M2.5-highspeed": "minimax",
  "minimax::MiniMax-M2.7": "minimax",
  "minimax::MiniMax-M2.7-highspeed": "minimax",
  "minimax::MiniMax-M3": "minimax",
  "mistral-large-3": "mistral",
  "mistral-large-latest": "mistral",
  "mistral-medium-latest": "mistral",
  "mistral-small-latest": "mistral",
  "mistral::codestral-latest": "mistral",
  "mistral::mistral-large-3": "mistral",
  "mistral::mistral-large-latest": "mistral",
  "mistral::mistral-medium-latest": "mistral",
  "mistral::mistral-small-latest": "mistral",
  "moonshot::kimi-k2.6": "moonshot",
  "moonshot::kimi-k2.7-code": "moonshot",
  "o3": "openai",
  "o3-mini": "openai",
  "o4-mini": "openai",
  "ollama::qwen3:8b": "ollama",
  "openai/gpt-oss-120b": "groq",
  "openai/gpt-oss-20b": "groq",
  "openai::gpt-4.1": "openai",
  "openai::gpt-4.1-mini": "openai",
  "openai::gpt-4.1-nano": "openai",
  "openai::gpt-4o": "openai",
  "openai::gpt-4o-mini": "openai",
  "openai::gpt-5": "openai",
  "openai::gpt-5-mini": "openai",
  "openai::gpt-5-nano": "openai",
  "openai::gpt-5.1": "openai",
  "openai::gpt-5.2": "openai",
  "openai::gpt-5.3-codex": "openai",
  "openai::gpt-5.4": "openai",
  "openai::gpt-5.4-mini": "openai",
  "openai::gpt-5.4-nano": "openai",
  "openai::gpt-5.5": "openai",
  "openai::gpt-5.6-luna": "openai",
  "openai::gpt-5.6-sol": "openai",
  "openai::gpt-5.6-terra": "openai",
  "openai::gpt-6-astra": "openai",
  "openai::o3": "openai",
  "openai::o3-mini": "openai",
  "openai::o4-mini": "openai",
  "perplexity::sonar": "perplexity",
  "perplexity::sonar-deep-research": "perplexity",
  "perplexity::sonar-pro": "perplexity",
  "perplexity::sonar-reasoning-pro": "perplexity",
  "qwen-flash": "dashscope",
  "qwen-long": "dashscope",
  "qwen-max": "dashscope",
  "qwen-plus": "dashscope",
  "qwen-turbo": "dashscope",
  "qwen-vl-max": "dashscope",
  "qwen-vl-plus": "dashscope",
  "qwen3-coder-flash": "dashscope",
  "qwen3-coder-plus": "dashscope",
  "qwen3-max": "dashscope",
  "qwen3-vl-plus": "dashscope",
  "qwen3.5-flash": "dashscope",
  "qwen3.5-omni-flash": "dashscope",
  "qwen3.5-omni-plus": "dashscope",
  "qwen3.5-plus": "dashscope",
  "qwen3.6-flash": "dashscope",
  "qwen3.6-max-preview": "dashscope",
  "qwen3.6-plus": "dashscope",
  "qwen3.8-flash": "dashscope",
  "qwen3.8-max": "dashscope",
  "qwen3:8b": "ollama",
  "qwq-plus": "dashscope",
  "sonar": "perplexity",
  "sonar-deep-research": "perplexity",
  "sonar-pro": "perplexity",
  "sonar-reasoning-pro": "perplexity",
  "step-3.5-flash": "stepfun",
  "stepfun::step-3.5-flash": "stepfun",
  "volcengine::doubao-pro-32k": "volcengine",
  "volcengine::doubao-seed-2-1-pro": "volcengine",
  "volcengine::doubao-seed-2-1-turbo": "volcengine",
  "xai::grok-4.20-non-reasoning": "xai",
  "xai::grok-4.20-reasoning": "xai",
  "xai::grok-4.3": "xai",
  "xai::grok-4.5": "xai",
  "xai::grok-4.6": "xai",
  "zhipu::glm-4-flash": "zhipu",
  "zhipu::glm-4-plus": "zhipu",
  "zhipu::glm-4.6": "zhipu",
  "zhipu::glm-4.7": "zhipu",
  "zhipu::glm-4.7-flash": "zhipu",
  "zhipu::glm-5": "zhipu",
  "zhipu::glm-5-turbo": "zhipu",
  "zhipu::glm-5.1": "zhipu",
  "zhipu::glm-5.2": "zhipu",
  "zhipu::glm-5.3": "zhipu",
  "zhipu::glm-5.3-flash": "zhipu",
  "zhipu::glm-5v-turbo": "zhipu",
};

// 上下文窗口（tokens）
let CONTEXT_WINDOW = {
  "Baichuan3-Turbo": 32768,
  "Baichuan4-Air": 32768,
  "Baichuan4-Turbo": 32768,
  "MiniMax-M2": 204800,
  "MiniMax-M2.1": 204800,
  "MiniMax-M2.5": 204800,
  "MiniMax-M2.5-highspeed": 204800,
  "MiniMax-M2.7": 204800,
  "MiniMax-M2.7-highspeed": 204800,
  "MiniMax-M3": 500000,
  "agnes-2.5-pro-alpha": 1000000,
  "agnes-image-2.1-flash": 1000000,
  "agnes-video-v2.0": 1000000,
  "agnes::agnes-2.5-pro-alpha": 1000000,
  "agnes::agnes-image-2.1-flash": 1000000,
  "agnes::agnes-video-v2.0": 1000000,
  "anthropic::claude-3-5-haiku": 200000,
  "anthropic::claude-fable-5": 1000000,
  "anthropic::claude-fable-5-1": 1000000,
  "anthropic::claude-haiku-4-5": 200000,
  "anthropic::claude-mythos-5": 1000000,
  "anthropic::claude-mythos-5-1": 1000000,
  "anthropic::claude-opus-4-1": 200000,
  "anthropic::claude-opus-4-5": 200000,
  "anthropic::claude-opus-4-6": 200000,
  "anthropic::claude-opus-4-7": 1000000,
  "anthropic::claude-opus-4-8": 1000000,
  "anthropic::claude-opus-5": 1000000,
  "anthropic::claude-sonnet-4-5": 200000,
  "anthropic::claude-sonnet-4-6": 200000,
  "anthropic::claude-sonnet-5": 1000000,
  "baichuan::Baichuan3-Turbo": 32768,
  "baichuan::Baichuan4-Air": 32768,
  "baichuan::Baichuan4-Turbo": 32768,
  "claude-3-5-haiku": 200000,
  "claude-fable-5": 1000000,
  "claude-fable-5-1": 1000000,
  "claude-haiku-4-5": 200000,
  "claude-mythos-5": 1000000,
  "claude-mythos-5-1": 1000000,
  "claude-opus-4-1": 200000,
  "claude-opus-4-5": 200000,
  "claude-opus-4-6": 200000,
  "claude-opus-4-7": 1000000,
  "claude-opus-4-8": 1000000,
  "claude-opus-5": 1000000,
  "claude-sonnet-4-5": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-sonnet-5": 1000000,
  "codestral-latest": 256000,
  "dashscope::kimi-k2.5": 262144,
  "dashscope::qwen-flash": 997952,
  "dashscope::qwen-long": 10000000,
  "dashscope::qwen-max": 32768,
  "dashscope::qwen-plus": 131072,
  "dashscope::qwen-turbo": 131072,
  "dashscope::qwen-vl-max": 128000,
  "dashscope::qwen-vl-plus": 128000,
  "dashscope::qwen3-coder-flash": 997952,
  "dashscope::qwen3-coder-plus": 997952,
  "dashscope::qwen3-max": 262144,
  "dashscope::qwen3-vl-plus": 260096,
  "dashscope::qwen3.5-flash": 131072,
  "dashscope::qwen3.5-omni-flash": 262144,
  "dashscope::qwen3.5-omni-plus": 262144,
  "dashscope::qwen3.5-plus": 1000000,
  "dashscope::qwen3.6-flash": 131072,
  "dashscope::qwen3.6-max-preview": 1000000,
  "dashscope::qwen3.6-plus": 1000000,
  "dashscope::qwen3.8-flash": 1000000,
  "dashscope::qwen3.8-max": 1000000,
  "dashscope::qwq-plus": 131072,
  "deepseek-flash": 1000000,
  "deepseek-v4-flash": 1000000,
  "deepseek-v4-flash-vision-exp": 1000000,
  "deepseek-v4-pro": 1000000,
  "deepseek::deepseek-flash": 1000000,
  "deepseek::deepseek-v4-flash": 1000000,
  "deepseek::deepseek-v4-flash-vision-exp": 1000000,
  "deepseek::deepseek-v4-pro": 1000000,
  "doubao-pro-32k": 32768,
  "gemini-2.5-flash": 1048576,
  "gemini-2.5-flash-lite": 1048576,
  "gemini-2.5-pro": 1048576,
  "gemini-3-flash-preview": 1048576,
  "gemini-3.1-flash-lite-preview": 1048576,
  "gemini-3.1-pro-preview": 1048576,
  "gemini-3.7-flash": 1048576,
  "gemini-3.8-flash": 1048576,
  "gemini::gemini-2.5-flash": 1048576,
  "gemini::gemini-2.5-flash-lite": 1048576,
  "gemini::gemini-2.5-pro": 1048576,
  "gemini::gemini-3-flash-preview": 1048576,
  "gemini::gemini-3.1-flash-lite-preview": 1048576,
  "gemini::gemini-3.1-pro-preview": 1048576,
  "gemini::gemini-3.7-flash": 1048576,
  "gemini::gemini-3.8-flash": 1048576,
  "glm-4-flash": 131072,
  "glm-4-plus": 131072,
  "glm-4.6": 200000,
  "glm-4.7": 200000,
  "glm-4.7-flash": 200000,
  "glm-5": 200000,
  "glm-5-turbo": 205000,
  "glm-5.1": 200000,
  "glm-5.2": 1000000,
  "glm-5.3": 1000000,
  "glm-5.3-flash": 1000000,
  "glm-5v-turbo": 200000,
  "gpt-4.1": 1047576,
  "gpt-4.1-mini": 1047576,
  "gpt-4.1-nano": 1047576,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-5": 400000,
  "gpt-5-mini": 400000,
  "gpt-5-nano": 400000,
  "gpt-5.1": 400000,
  "gpt-5.2": 400000,
  "gpt-5.3-codex": 400000,
  "gpt-5.4": 272000,
  "gpt-5.4-mini": 400000,
  "gpt-5.4-nano": 400000,
  "gpt-5.5": 272000,
  "gpt-5.6-luna": 1050000,
  "gpt-5.6-sol": 1050000,
  "gpt-5.6-terra": 1050000,
  "gpt-6-astra": 1050000,
  "grok-4.20-non-reasoning": 2000000,
  "grok-4.20-reasoning": 2000000,
  "grok-4.3": 1000000,
  "grok-4.5": 500000,
  "grok-4.6": 500000,
  "groq::openai/gpt-oss-120b": 131072,
  "groq::openai/gpt-oss-20b": 131072,
  "kimi-k2.5": 262144,
  "kimi-k2.6": 262144,
  "kimi-k2.7-code": 256000,
  "mimo-v2.5": 1048576,
  "mimo-v2.5-pro": 1048576,
  "mimo::mimo-v2.5": 1048576,
  "mimo::mimo-v2.5-pro": 1048576,
  "minimax::MiniMax-M2": 204800,
  "minimax::MiniMax-M2.1": 204800,
  "minimax::MiniMax-M2.5": 204800,
  "minimax::MiniMax-M2.5-highspeed": 204800,
  "minimax::MiniMax-M2.7": 204800,
  "minimax::MiniMax-M2.7-highspeed": 204800,
  "minimax::MiniMax-M3": 500000,
  "mistral-large-3": 262144,
  "mistral-large-latest": 262144,
  "mistral-medium-latest": 262144,
  "mistral-small-latest": 256000,
  "mistral::codestral-latest": 256000,
  "mistral::mistral-large-3": 262144,
  "mistral::mistral-large-latest": 262144,
  "mistral::mistral-medium-latest": 262144,
  "mistral::mistral-small-latest": 256000,
  "moonshot::kimi-k2.6": 262144,
  "moonshot::kimi-k2.7-code": 256000,
  "o3": 200000,
  "o3-mini": 200000,
  "o4-mini": 200000,
  "openai/gpt-oss-120b": 131072,
  "openai/gpt-oss-20b": 131072,
  "openai::gpt-4.1": 1047576,
  "openai::gpt-4.1-mini": 1047576,
  "openai::gpt-4.1-nano": 1047576,
  "openai::gpt-4o": 128000,
  "openai::gpt-4o-mini": 128000,
  "openai::gpt-5": 400000,
  "openai::gpt-5-mini": 400000,
  "openai::gpt-5-nano": 400000,
  "openai::gpt-5.1": 400000,
  "openai::gpt-5.2": 400000,
  "openai::gpt-5.3-codex": 400000,
  "openai::gpt-5.4": 272000,
  "openai::gpt-5.4-mini": 400000,
  "openai::gpt-5.4-nano": 400000,
  "openai::gpt-5.5": 272000,
  "openai::gpt-5.6-luna": 1050000,
  "openai::gpt-5.6-sol": 1050000,
  "openai::gpt-5.6-terra": 1050000,
  "openai::gpt-6-astra": 1050000,
  "openai::o3": 200000,
  "openai::o3-mini": 200000,
  "openai::o4-mini": 200000,
  "perplexity::sonar": 128000,
  "perplexity::sonar-deep-research": 128000,
  "perplexity::sonar-pro": 200000,
  "perplexity::sonar-reasoning-pro": 128000,
  "qwen-flash": 997952,
  "qwen-long": 10000000,
  "qwen-max": 32768,
  "qwen-plus": 131072,
  "qwen-turbo": 131072,
  "qwen-vl-max": 128000,
  "qwen-vl-plus": 128000,
  "qwen3-coder-flash": 997952,
  "qwen3-coder-plus": 997952,
  "qwen3-max": 262144,
  "qwen3-vl-plus": 260096,
  "qwen3.5-flash": 131072,
  "qwen3.5-omni-flash": 262144,
  "qwen3.5-omni-plus": 262144,
  "qwen3.5-plus": 1000000,
  "qwen3.6-flash": 131072,
  "qwen3.6-max-preview": 1000000,
  "qwen3.6-plus": 1000000,
  "qwen3.8-flash": 1000000,
  "qwen3.8-max": 1000000,
  "qwq-plus": 131072,
  "sonar": 128000,
  "sonar-deep-research": 128000,
  "sonar-pro": 200000,
  "sonar-reasoning-pro": 128000,
  "step-3.5-flash": 262144,
  "stepfun::step-3.5-flash": 262144,
  "volcengine::doubao-pro-32k": 32768,
  "xai::grok-4.20-non-reasoning": 2000000,
  "xai::grok-4.20-reasoning": 2000000,
  "xai::grok-4.3": 1000000,
  "xai::grok-4.5": 500000,
  "xai::grok-4.6": 500000,
  "zhipu::glm-4-flash": 131072,
  "zhipu::glm-4-plus": 131072,
  "zhipu::glm-4.6": 200000,
  "zhipu::glm-4.7": 200000,
  "zhipu::glm-4.7-flash": 200000,
  "zhipu::glm-5": 200000,
  "zhipu::glm-5-turbo": 205000,
  "zhipu::glm-5.1": 200000,
  "zhipu::glm-5.2": 1000000,
  "zhipu::glm-5.3": 1000000,
  "zhipu::glm-5.3-flash": 1000000,
  "zhipu::glm-5v-turbo": 200000,
};
// <<< BUILTIN-PRICING-DATA
function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ── 外部计费配置注入 ──
// api.js 拉到远程 pricing.json 后调用。逐字段校验，非法条目直接丢弃，
// 全部条目都非法时返回 false 并保持内置配置不变（避免一份坏配置把费用算成 0）。
function isValidPrice(p) {
  return !!p && ["inputMiss", "inputHit", "output"].every(
    (k) => typeof p[k] === "number" && Number.isFinite(p[k]) && p[k] >= 0,
  );
}

// 供应商接入标签归一：同一家的 OAuth / coding plan / 区域站共用一份官方单价。
// 计费数据库按官方直连身份入库（键写成 "<provider>::<model>"），
// 运行时会话里的 provider 可能带接入后缀，先归一再去查表。
const PROVIDER_ALIAS = {
  "xai-oauth": "xai",
  "openai-codex-oauth": "openai",
  "zhipu-coding": "zhipu",
  "kimi-coding": "moonshot",
  "dashscope-coding": "dashscope",
  "dashscope-token-plan": "dashscope",
  "volcengine-coding": "volcengine",
};

function canonProvider(provider) {
  if (!provider) return null;
  return PROVIDER_ALIAS[provider] || provider;
}

function setPricingConfig(raw) {
  if (!raw || typeof raw !== "object" || !raw.models || typeof raw.models !== "object") return false;
  const nextPricing = {}, nextProvider = {}, nextNote = {}, nextWindow = {};
  const bareOwners = new Map();   // 裸模型名 → Set(供应商)，用于判断是否全库唯一
  const bareExplicit = new Map(); // 显式给出的裸键（无 "::" 前缀）
  let accepted = 0;

  const putMeta = (key, provider, cfg) => {
    if (provider) nextProvider[key] = provider;
    if (typeof cfg.source === "string" && cfg.source) nextNote[key] = cfg.source;
    if (typeof cfg.contextWindow === "number" && cfg.contextWindow > 0) nextWindow[key] = cfg.contextWindow;
  };

  for (const [key, cfg] of Object.entries(raw.models)) {
    if (!key || !cfg || typeof cfg !== "object") continue;
    let price = null;
    if (isValidPrice(cfg.flat)) {
      price = { inputMiss: cfg.flat.inputMiss, inputHit: cfg.flat.inputHit, output: cfg.flat.output };
    } else if (isValidPrice(cfg.peak) && isValidPrice(cfg.offPeak)) {
      price = {
        peak: { inputMiss: cfg.peak.inputMiss, inputHit: cfg.peak.inputHit, output: cfg.peak.output },
        offPeak: { inputMiss: cfg.offPeak.inputMiss, inputHit: cfg.offPeak.inputHit, output: cfg.offPeak.output },
      };
    }
    if (!price) continue;

    // 键格式 "<provider>::<model>"（分隔符用 :: ，因为模型 ID 本身可能带 "/"）
    const sep = key.indexOf("::");
    const keyProvider = sep > 0 ? canonProvider(key.slice(0, sep)) : null;
    const model = sep > 0 ? key.slice(sep + 2) : key;
    const provider = canonProvider(typeof cfg.provider === "string" && cfg.provider ? cfg.provider : keyProvider);

    if (keyProvider) {
      const scoped = `${keyProvider}::${model}`;
      nextPricing[scoped] = price;
      putMeta(scoped, provider || keyProvider, cfg);
      if (!bareOwners.has(model)) bareOwners.set(model, new Set());
      bareOwners.get(model).add(keyProvider);
    } else {
      bareExplicit.set(model, price);
      putMeta(model, provider, cfg);
    }
    accepted += 1;
  }

  // 全库只有一个供应商提供的模型，才登记裸键（旧版插件与未带 provider 的调用走这条路）
  for (const [model, owners] of bareOwners) {
    if (owners.size !== 1) continue;
    const only = [...owners][0];
    const scoped = `${only}::${model}`;
    nextPricing[model] = nextPricing[scoped];
    if (nextProvider[scoped] && !nextProvider[model]) nextProvider[model] = nextProvider[scoped];
    if (nextNote[scoped] && !nextNote[model]) nextNote[model] = nextNote[scoped];
    if (nextWindow[scoped] && !nextWindow[model]) nextWindow[model] = nextWindow[scoped];
  }
  for (const [model, price] of bareExplicit) nextPricing[model] = price;

  if (!accepted) return false;
  PRICING = nextPricing;
  PROVIDER_OF_MODEL = { ...PROVIDER_OF_MODEL, ...nextProvider };
  SOURCE_NOTE = { ...SOURCE_NOTE, ...nextNote };
  CONTEXT_WINDOW = { ...CONTEXT_WINDOW, ...nextWindow };
  if (typeof raw.snapshotAt === "string" && raw.snapshotAt) PRICING_SNAPSHOT_AT = raw.snapshotAt;
  return true;
}

// 高峰时段：北京时间 9:00-12:00、14:00-18:00，其余空闲（空闲价 = 高峰价一半）
function isPeakHour(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return true; // 时间戳缺失/异常时按高峰价（保守）
  const beijingHour = (d.getUTCHours() + 8) % 24;
  return (beijingHour >= 9 && beijingHour < 12) || (beijingHour >= 14 && beijingHour < 18);
}

// 价格查表：先按「供应商::模型」限定键（同一模型名跨厂商价格不同），再回退到裸模型名
function lookupPriceEntry(model, provider) {
  if (!model) return null;
  const p = canonProvider(provider);
  if (p) {
    const scoped = PRICING[`${p}::${model}`];
    if (scoped) return scoped;
  }
  return PRICING[model] || null;
}

// 取某模型在指定时刻的单价：峰谷模型按时间选档，固定价模型直接返回
function priceFor(model, ts, provider) {
  const entry = lookupPriceEntry(model, provider);
  if (!entry) return null;
  if (entry.peak) return isPeakHour(ts) ? entry.peak : entry.offPeak;
  return entry;
}

// 上下文窗口：先查限定键，再查裸键，最后默认 1M
function contextWindowFor(model, provider) {
  const p = canonProvider(provider);
  if (!model) return 1_000_000;
  if (p && CONTEXT_WINDOW[`${p}::${model}`]) return CONTEXT_WINDOW[`${p}::${model}`];
  return CONTEXT_WINDOW[model] || 1_000_000;
}

// 费用：input(未命中) + cacheInc(命中) + (output + reasoning) × 输出价
function calcCost(input, cacheInc, output, reasoning, model, ts, provider) {
  const p = priceFor(model, ts, provider);
  if (!p) return null;
  return (
    (input / 1e6) * p.inputMiss +
    (cacheInc / 1e6) * p.inputHit +
    ((output + (reasoning || 0)) / 1e6) * p.output
  );
}

// 解析单个会话文件内容，limitTurns 限制返回的逐轮序列长度（用于图表）
function parseSession(content, limitTurns = 200) {
  const lines = content.split("\n");
  const turns = [];
  let model = null;
  let currentModel = null;
  let currentProvider = null;
  const modelProviders = {};
  let sessionStart = null;
  let sessionId = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "session" && !sessionStart) {
      sessionStart = obj.timestamp;
      sessionId = obj.id || null;
    }
    if (obj.type === "model_change") {
      currentModel = obj.modelId || currentModel;
      currentProvider = obj.provider || currentProvider;
      if (!model) model = currentModel;
      if (currentModel && currentProvider) modelProviders[currentModel] = currentProvider;
    }
    if (obj.type === "message" && obj.message && obj.message.role === "assistant" && obj.message.usage) {
      const u = obj.message.usage;
      const turnModel = obj.message.model || currentModel || null;
      const turnProvider = obj.message.provider || currentProvider || PROVIDER_OF_MODEL[turnModel] || null;
      if (turnModel && turnProvider) modelProviders[turnModel] = turnProvider;
      turns.push({
        ts: obj.timestamp,
        input: u.input || 0,
        output: u.output || 0,
        cacheRead: u.cacheRead || 0,
        cacheWrite: u.cacheWrite || 0,
        reasoning: u.reasoning || 0,
        total: u.totalTokens || 0,
        m: turnModel, // 该轮实际模型（多模型会话计费用）
        p: turnProvider, // 该轮实际供应商（支持 OAuth / 动态供应商）
      });
      if (!model) model = turnModel;
    }
  }

  if (turns.length === 0) return null;

  // 逐轮补充缓存增量，并做累计统计
  let sumInput = 0, sumOutput = 0, sumCacheInc = 0, sumCacheRead = 0, sumCacheWrite = 0, sumReasoning = 0;
  let prevCache = 0;
  for (const t of turns) {
    t.cacheInc = Math.max(0, (t.cacheRead || 0) - prevCache);
    prevCache = t.cacheRead;
    sumInput += t.input;
    sumOutput += t.output;
    sumCacheInc += t.cacheInc;
    sumCacheRead += t.cacheRead || 0;
    sumCacheWrite += t.cacheWrite || 0;
    sumReasoning += t.reasoning || 0;
  }

  // 命中率的正确口径：一次请求的输入 = 命中(cacheRead) + 未命中(input)。
  // 不能用 cacheInc(=cacheRead 差分)，因为 cacheRead 是累计值，会在重启/上下文压缩时
  // 归零重涨，差分在那里会被 clamp 成 0，把几十万命中量误判为未读，命中率被系统压低。
  const last = turns[turns.length - 1];
  const avgHit = sumCacheRead + sumInput > 0 ? (sumCacheRead / (sumCacheRead + sumInput)) * 100 : 0;
  const lastHit = last.cacheRead + last.input > 0 ? (last.cacheRead / (last.cacheRead + last.input)) * 100 : 0;

  // 逐轮序列（图表用）：只保留最近 limitTurns 轮；同时累计逐轮实际费用
  const series = [];
  let cumInput = 0, cumOutput = 0, cumCache = 0, cumReason = 0, cumCost = 0;
  const modelCounts = {}; // 每轮实际模型出现次数（多模型会话归属判定）
  const providerUsage = {}; // 本会话按实际供应商聚合：tokens / 费用 / 轮数
  for (const t of turns) {
    const m = t.m || model;
    modelCounts[m] = (modelCounts[m] || 0) + 1;
    cumInput += t.input;
    cumOutput += t.output;
    cumCache += t.cacheInc;
    cumReason += t.reasoning || 0;
    const rawCost = calcCost(t.input, t.cacheInc, t.output, t.reasoning, m, t.ts, t.p || modelProviders[m] || PROVIDER_OF_MODEL[m]);
    const c = rawCost || 0;
    cumCost += c;
    const turnTotal = t.input + t.cacheInc + t.output + (t.reasoning || 0);
    const provider = t.p || modelProviders[m] || PROVIDER_OF_MODEL[m] || "unknown";
    const pu = providerUsage[provider] || (providerUsage[provider] = { provider, turns: 0, tokens: 0, cost: 0, pricedTurns: 0, models: {}, modelTokens: {} });
    pu.turns++;
    pu.tokens += turnTotal;
    pu.cost += c;
    if (rawCost != null) pu.pricedTurns++;
    pu.models[m] = (pu.models[m] || 0) + 1;
    pu.modelTokens[m] = (pu.modelTokens[m] || 0) + turnTotal;
    series.push({
      i: series.length + 1,
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead, // 本轮实际缓存命中量（非增量，命中率用）
      cacheInc: t.cacheInc, // 本轮缓存增量（费用口径）
      total: turnTotal, // 单轮处理量
      hit: t.cacheRead + t.input > 0 ? round((t.cacheRead / (t.cacheRead + t.input)) * 100, 1) : 0,
      cost: round(c, 6),
      cumTokens: cumInput + cumOutput + cumCache + cumReason,
      cumCost: round(cumCost, 4),
    });
  }
  const trimmed = series.slice(-limitTurns);

  // 会话归属模型：主模型 = 出现轮次最多的模型；会话费用 = 逐轮按各自模型价格累计
  const dominant = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0];
  const dominantModel = dominant ? dominant[0] : model;
  const sessionCost = cumCost;
  const lastCost = calcCost(last.input, last.cacheInc, last.output, last.reasoning, last.m || model, last.ts, modelProviders[last.m || model] || PROVIDER_OF_MODEL[last.m || model]);
  const models = Object.entries(modelCounts).map(([m, cnt]) => ({ model: m, turns: cnt, provider: modelProviders[m] || PROVIDER_OF_MODEL[m] || null }));
  const providers = Object.values(providerUsage).map((p) => ({
    provider: p.provider,
    turns: p.turns,
    tokens: p.tokens,
    cost: p.pricedTurns > 0 ? round(p.cost, 4) : null,
    costComplete: p.pricedTurns === p.turns,
    models: Object.entries(p.models).map(([model, turns]) => ({ model, turns, tokens: p.modelTokens[model] || 0 })),
  }));
  model = dominantModel; // 会话归属用主模型

  const contextWindow = contextWindowFor(model, modelProviders[model] || PROVIDER_OF_MODEL[model]);

  // 上下文窗口占用：最近一次请求的 input + cacheRead（累计）即当前窗口大小
  const lastWindowTokens = last.input + last.cacheRead;
  const compactThreshold = 0.8; // 压缩阈值（Hana 默认 80%）
  const contextPercent = contextWindow > 0 ? (lastWindowTokens / contextWindow) * 100 : 0;
  const remainingToCompact = Math.max(0, contextWindow * compactThreshold - lastWindowTokens);

  // 会话时长（分钟）
  let durationMinutes = null;
  if (sessionStart && turns.length > 0) {
    const start = Date.parse(sessionStart);
    const end = Date.parse(turns[turns.length - 1].ts) || Date.now();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durationMinutes = Math.max(0, Math.round((end - start) / 60000));
    }
  }

  return {
    model,
    provider: modelProviders[model] || PROVIDER_OF_MODEL[model] || null,
    models, // 会话内模型分布：[{model, turns, provider}]
    providers, // 本会话实际使用的供应商明细：tokens / cost / turns / models
    sessionId,
    contextWindow,
    contextPercent: Math.round(contextPercent * 10) / 10,
    lastWindowTokens,
    compactThreshold,
    remainingToCompact,
    durationMinutes,
    turns: turns.length,
    sessionTokens: sumInput + sumOutput + sumCacheInc + sumReasoning,
    lastTurnTokens: last.input + last.cacheInc + last.output + (last.reasoning || 0),
    lastHitPercent: round(lastHit),
    avgHitPercent: round(avgHit),
    sumInput,
    sumOutput,
    sumCacheRead: sumCacheRead, // 本轮实际缓存命中累计（命中率口径）
    sumCacheInc, // 单轮缓存增量累计（费用口径）
    sumCacheWrite,
    sumReasoning,
    sessionCostCny: sessionCost == null ? null : round(sessionCost, 4),
    lastCostCny: lastCost == null ? null : round(lastCost, 6),
    startTime: sessionStart,
    series: trimmed,
  };
}

export { parseSession, PRICING, PROVIDER_OF_MODEL, CONTEXT_WINDOW, round, priceFor, isPeakHour, SOURCE_NOTE, PRICING_SNAPSHOT_AT, setPricingConfig, canonProvider, contextWindowFor };
