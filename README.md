# HanaAgent 会话用量统计面板插件

> 实时查看每个会话的 Token 消耗、缓存命中率、费用与余额，覆盖多供应商账户状态、逐轮趋势与全局用量分析。

## v2.0 更新要点

- **全新 v2 界面**：统一的玻璃材质与光照语言，卡片、面板、图表共用同一套交互反馈
- **统一交互动效**：悬停微放大、按压回缩、松开平滑回位、光标跟随光斑，覆盖页面、侧边栏与放大详情里的全部卡片
- **数字转轮动画**：所有纯数字指标逐位滚动到目标值，与卡片刷新节奏联动（首次打开、手动刷新、切换视图时触发，自动轮询不打扰）
- **会话图表放大详情**：四张逐轮图表（Token 用量 / 费用 / 构成 / 缓存命中率）点击即可展开完整数据，不受滚动条限制
- **费用简报详情**：按供应商分组的模型价格卡，光晕、浓度、亮度与用量页统一
- **侧边栏窄宽度自适应**：拖窄窗口时卡片自动换行，不再出现横向滚动；低于 240px 才触发滚动
- **今日统计增加失败计数**：调用失败时显示「今日调用 9 失败 9」，区分「没有数据」和「数据为零」

## 功能特性

- **多供应商账户状态**：DeepSeek / Moonshot 真实余额、智谱 Coding Plan 配额、OpenAI 官方成本、xAI API 预付余额和可选 Codex 订阅配额
- **会话级用量指标**：总 Token、缓存命中率、会话费用、轮数、运行时长
- **图表分析**：每轮 Token / 缓存命中率趋势 / 每轮费用 / 输入构成（未命中·缓存·输出），全部支持点击放大
- **混用模型会话识别**：自动统计会话内模型分布、主模型归属，会话费用按每轮实际模型价格累计
- **会话标题提取**：按 session 标题查询，自动跳过系统注入消息（`[hana_reference]` / 附件等），精确单会话用量统计
- **双形态**：widget 常驻状态条（当前模型、命中、Token、费用、余额、对话标题）+ 完整数据面板
- **主题同步**：直接读取 HanaAgent 外观偏好，深浅色切换不依赖 renderer 补丁
- **内置更新检查**：详情页可检查 GitHub Latest Release；发现新版后校验、备份并更新

## 安装

> 🧩 **首次安装后，可直接让 HanaAgent 协助配置插件**：对 HanaAgent 说「帮我配置 session-insight 插件」，它会自动读取数据根、会话目录等配置项，无需手动填。

1. 在 HanaAgent 设置 > 插件中，拖入本项目文件夹；或放置到用户插件目录
2. 刷新插件列表，启用 `session-insight`
3. **务必为该插件开启「全权访问」（full access）权限**：在插件列表中点开 `session-insight`，找到权限/访问级别设置，授予「全权访问」。否则新版卡片、会话统计等依赖宿主能力的功能会因权限不足而受限或无法加载。
4. 打开插件：在 HanaAgent 里通过以下几个入口进入——「会话用量」页面、侧边的「用量状态栏」widget、或「卡片中心」里的 Session Insight 卡片。

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

账户数据分为四种口径：真实余额、官方累计成本、订阅配额和暂不可查询。管理凭据只在后端读取，不会发送到插件 iframe。Codex 配额使用未公开接口，启用后最多每五分钟查询一次。

## 更新通道

内置更新检查与历史版本完全一致，指向同一个仓库和同一套约定：

- 检查接口：`https://api.github.com/repos/youyongdemao/HanaAgent-session-insight/releases/latest`
- 安装包：Release 附件中形如 `session-insight-*.zip` 的资产
- 安装方式：校验 SHA256 → 备份当前插件目录 → 整体替换；失败自动回滚
- 版本要求：`minAppVersion` 为 `0.159.0`，与 v1.2.x 相同

因此 **v1.2.x 的老版本可以直接通过「检查更新」一键升级到 v2.0.0**，无需手动重装。

## 目录结构

```
session-insight/
├── manifest.json          # 插件清单
├── assets/
│   ├── panel-v2.js        # 前端逻辑（v2）
│   ├── panel-v2.css       # 样式（v2）
│   ├── panel.js           # 前端逻辑（v1 兼容）
│   └── panel.css          # 样式（v1 兼容）
├── routes/
│   ├── api.js             # 数据接口（统计/余额/更新）
│   └── ui.js              # 页面与 widget 路由
└── lib/
    └── usage-parser.js    # 会话 JSONL 解析与费用计算
```

## License

MIT
