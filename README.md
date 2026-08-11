# Session Insight

> Hana Agent 会话用量全景面板 — 多供应商余额、Token 消耗、缓存命中率、费用与图表分析。

## 功能特性

- **多供应商余额总览**：DeepSeek / Moonshot / MiMo / 智谱 / Agnes / OpenAI / Gemini 并行查询余额，60s 缓存
- **会话级用量指标**：总 Token、缓存命中率、会话费用、轮数、运行时长
- **图表分析**：每轮 Token / 缓存命中率趋势 / 每轮费用 / 输入构成（未命中·缓存·输出），全部支持点击放大
- **全局用量总览**：Agent 消耗、每日费用趋势、请求延迟分布、模型费用对比，可点击查看详情
- **混用模型会话识别**：自动统计会话内模型分布、主模型归属，会话费用按每轮实际模型价格累计
- **会话标题提取**：取对话第一句话作为标题，自动跳过系统注入消息（`[hana_reference]` / 附件等）
- **双形态**：widget 常驻状态条（当前模型、命中、Token、费用、余额、对话标题）+ 完整数据面板
- **细腻动效**：深浅色模式自适应、鼠标跟踪光晕、数字滚动、卡片逐层淡入、无回弹减速曲线

## 安装

1. 在 HanaAgent 设置 > 插件中，拖入本项目文件夹；或放置到用户插件目录
2. 刷新插件列表，启用 `session-insight`
3. 打开「会话用量」页面（或挂载 widget 状态条）

## 配置

| 配置项 | 说明 | 默认 |
|-------|------|------|
| `sessionsDir` | Hana 会话 JSONL 目录 | Hana 自带 `agents/<agent>/sessions` |
| `deepseekApiKey` | DeepSeek API Key（余额查询，留空自动读 provider-catalog） | 空 |
| `refreshSeconds` | widget 状态条自动刷新间隔 | 30 |

## 目录结构

```
session-insight/
├── manifest.json        # 插件清单
├── assets/
│   ├── panel.js         # 前端逻辑
│   ├── panel.css        # 样式
│   └── logos/           # 供应商 logo 水印
├── routes/
│   ├── api.js           # 数据接口（统计/余额/全局总览）
│   └── ui.js            # 页面与 widget 路由
└── lib/
    └── usage-parser.js  # 会话 JSONL 解析与费用计算
```

## License

MIT
