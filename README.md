# Session Insight — HanaAgent 会话用量面板

> 实时查看每个会话的 Token 消耗、缓存命中率、费用与余额，覆盖多供应商账户状态、逐轮趋势与全局用量分析。

Session Insight 是 HanaAgent 的会话用量面板，以 App 形态装载。完整工作台常驻左侧导航，点开即是当前会话的 Token、缓存命中率、费用与余额、逐轮趋势图表，以及各供应商账户的真实余额 / 配额 / 官方成本。数据全部来自宿主公开接口，管理凭据只留在后端。

## v2.1 相比 v2.0 的变化

- **装载形态换成 App**：manifestVersion 2，安装走「设置 → 扩展」，声明的能力在安装时逐项确认
- **数据源改用宿主公开接口**：会话列表、上下文占用、用量账本、供应商凭据，不再自行读会话 JSONL 与宿主数据库
- **页面层级**：整页工作台常驻左侧导航；实时用量成为独立卡片，按需放到画布上
- **主题跟随**：改由宿主 SDK 下发（`hana.theme`），不再读外观偏好文件
- **统计口径**：费用与趋势覆盖全量账本，按时间分片拉取
- **更新入口**：面板内指向「设置 → 扩展」

## 功能特性

- **多供应商账户状态**：DeepSeek / Moonshot 真实余额、智谱 Coding Plan 配额、OpenAI 官方成本、xAI API 预付余额和可选 Codex 订阅配额
- **会话级用量指标**：总 Token、缓存命中率、会话费用、轮数、运行时长
- **图表分析**：每轮 Token / 缓存命中率趋势 / 每轮费用 / 输入构成（未命中·缓存·输出），全部支持点击放大
- **混用模型会话识别**：自动统计会话内模型分布、主模型归属，会话费用按每轮实际模型价格累计
- **跟随当前会话**：工作台与实时用量都跟随主窗口选中的会话，可手动锁定到任意会话查看
- **双形态**：整页工作台 + 实时用量卡片
- **主题同步**：跟随 HanaAgent 当前主题，深浅色自适应
- **服务器定位**：每个会话可查看其使用过的供应商、模型与价格来源

## 安装

1. 从 [Releases](https://github.com/youyongdemao/HanaAgent-session-insight/releases) 下载 `session-insight-v*.zip`
2. 在 HanaAgent「设置 → 扩展」中安装该 zip
3. 安装时逐项确认以下能力（均为只读类）：
   - `app/tools.expose-to-model` — 向模型暴露一个读数据的工具
   - `app/sessions.read` — 读取会话列表与上下文（跟随当前会话需要）
   - `app/usage.read` — 读取宿主用量账本
   - `app/provider.credentials.read` — 读取供应商凭据以查询余额
   - `app/input.status` — 会话输入栏的状态位
4. 打开：左侧导航「会话用量·工作台」；实时用量可从卡片中心拖到画布上

## 配置

安装后在「设置 → 扩展 → Session Insight」里配置：

| 配置项 | 说明 | 默认 |
|-------|------|------|
| `refreshSeconds` | 状态条刷新间隔（秒） | 30 |
| `enableCodexQuota` | Codex 订阅配额（实验性，读取已登录的 ChatGPT OAuth 配额） | 关闭 |
| `deepseekApiKey` | 兜底用；仅在宿主凭据接口取不到时用于余额查询 | 空 |

账户数据分四种口径：真实余额、官方累计成本、订阅配额和暂不可查询。管理凭据只在后端读取，不会发送到面板页面。

## 计费数据库

价格不再写死在代码里。仓库根目录的 `pricing.json` 是唯一事实源，包含单价、高峰时段、模型归属供应商、上下文窗口和来源标注。

- **拉取**：App 启动后按 24 小时 TTL 拉取一次，先走 jsDelivr CDN，失败回退 GitHub raw，两者都不可用时使用内置快照
- **校验**：逐字段校验，非法值（负数、缺字段、类型错误）整条丢弃；整份配置都无效时保持内置数据不变
- **维护价格**：直接改本仓库的 `pricing.json` 并推送，客户端最迟 24 小时后生效

价格数据均来自各供应商官方定价页，查不到的模型标「未收录」，不做估算。

## App 形态（manifest v2）

本 App 用 `contributes` 声明：

| 贡献 | 内容 |
|------|------|
| `cards` | `panel` 整页卡（常驻左侧导航）+ `widget` 独立卡片（实时用量） |
| `ui.inputStatus` | 输入栏下方一条上下文占用状态 |
| `settings.schema` | 上面那张配置表 |

服务端入口是 `index.js`（`defineApp` + `ctx.routes.register`），后端路由挂在 `/api/apps/session-insight-v2/routes/` 下；页面资源在 `ui/` 下，由宿主签发票据装载。

## 更新通道

更新统一走「设置 → 扩展」：从 Releases 下载新 zip 覆盖安装。面板内不再自行下载覆盖，也不会去比对 v1 插件的 Release 版本号。

## 目录结构

```
session-insight/
├── manifest.json          # App 清单（manifestVersion 2）
├── index.js               # 服务端入口：defineApp、路由注册、工具注册
├── package.json           # 声明 type: module（子模块按 ESM 加载）
├── pricing.json           # 计费数据库（价格 / 峰谷 / 模型归属 / 上下文窗口）
├── lib/
│   ├── host-data.js       # 宿主接口 → 面板数据形状
│   ├── legacy-api.js      # 后端路由实现（数据源已换成宿主接口）
│   ├── usage-parser.js    # 计费逻辑与内置价格快照
│   └── provider-directory.js
├── ui/
│   ├── panel.html         # 工作台整页
│   ├── widget.html        # 实时用量
│   └── assets/            # 前端脚本与样式（panel-v2.js / panel-v2.css）
├── sdk/                   # 随包 SDK（宿主 App 契约）
└── assets/icon.svg        # App 图标
```

## License

MIT
