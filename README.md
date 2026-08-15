# HanaAgent 会话用量统计面板插件

> Hana Agent 会话用量统计面板插件 — 多供应商余额、Token 消耗、缓存命中率、费用与图表分析。

## 功能特性

- **多供应商账户状态**：DeepSeek / Moonshot 真实余额、智谱 Coding Plan 配额、OpenAI 官方成本、xAI API 预付余额和可选 Codex 订阅配额
- **会话级用量指标**：总 Token、缓存命中率、会话费用、轮数、运行时长
- **图表分析**：每轮 Token / 缓存命中率趋势 / 每轮费用 / 输入构成（未命中·缓存·输出），全部支持点击放大
- **混用模型会话识别**：自动统计会话内模型分布、主模型归属，会话费用按每轮实际模型价格累计
- **会话标题提取**：按session标题查询，自动跳过系统注入消息（`[hana_reference]` / 附件等），精确单会话用量统计
- **双形态**：widget 常驻状态条（当前模型、命中、Token、费用、余额、对话标题）+ 完整数据面板
- **细腻动效**：深浅色模式自适应、鼠标跟踪光晕、数字滚动、卡片逐层淡入、无回弹减速曲线
- **纯插件主题同步**：直接读取 HanaAgent 外观偏好，深浅切换不依赖 renderer 补丁
- **内置更新检查**：详情页可检查 GitHub Latest Release；发现新版后校验、备份并更新（自动安装需要 WinRAR）

## 安装

1. 在 HanaAgent 设置 > 插件中，拖入本项目文件夹；或放置到用户插件目录
2. 刷新插件列表，启用 `session-insight`
3. 打开「会话用量」页面（或挂载 widget 状态条）

## 配置

| 配置项 | 说明 | 默认 |
|-------|------|------|
| `sessionsDir` | Hana 会话 JSONL 目录 | Hana 自带 `agents/<agent>/sessions` |
| `deepseekApiKey` | DeepSeek API Key（余额查询，留空自动读 provider-catalog） | 空 |
| `openaiAdminKey` | OpenAI Organization Admin Key，用于官方 Usage / Costs | 空 |
| `xaiManagementKey` | xAI Management Key，用于团队账单接口 | 空 |
| `xaiTeamId` | xAI Team ID，与 Management Key 配套 | 空 |
| `enableCodexQuota` | 启用实验性 ChatGPT/Codex 订阅配额查询 | 关闭 |
| `refreshSeconds` | widget 状态条自动刷新间隔 | 30 |

账户数据分为四种口径：真实余额、官方累计成本、订阅配额和本地估算。管理凭据只在后端读取，不会发送到插件 iframe。Codex 配额使用未公开接口，启用后最多每五分钟查询一次。

## 目录结构

```
session-insight/
├── manifest.json        # 插件清单
├── assets/
│   ├── panel.js         # 前端逻辑
│   └── panel.css        # 样式
├── routes/
│   ├── api.js           # 数据接口（统计/余额）
│   └── ui.js            # 页面与 widget 路由
└── lib/
    └── usage-parser.js  # 会话 JSONL 解析与费用计算
```

## License

MIT
