# 供应商查询接口核对清单（每次更新必做）

维护对象：`lib/provider-directory.js` 里每家的 `query.via`，也就是余额 / 配额 / 用量门路。
这些接口由各家自己维护，路径、鉴权方式、响应结构都可能随时变，所以每次插件更新都要过一遍。

## 一键核对

```
node scripts/check-providers.mjs            # 只读配置，不触网：列启用集合、本地判定、启动目标
node scripts/check-providers.mjs --verify   # 真打各家接口，报告哪些门路还有效
```

`--verify` 输出分两类：

- **查到**：接口活着，返回了余额或配额数字
- **未查到**：再分 `reachable=true`（官方有门路，得修配置或改接口路径）和 `reachable=false`（官方本来就没有）

## 当前门路（2026-09-20 核对）

| 供应商 | 门路 | 鉴权 | 备注 |
|---|---|---|---|
| deepseek | `GET /user/balance` | api_key | 实测可用 |
| moonshot | `GET /users/me/balance` | api_key | 实测可用 |
| zhipu | `GET api.z.ai` 或 `open.bigmodel.cn` `/api/monitor/usage/quota/limit` | api_key | 需 Coding Plan |
| zhipu-coding | 同上（key 与 zhipu 独立） | api_key | 需 Coding Plan |
| openai | Admin Costs API | Admin Key | 普通 Project Key 无权 |
| openai-codex | `GET chatgpt.com/backend-api/wham/usage` | OAuth access token | 需打开「Codex 订阅配额」开关 |
| xai | `management-api.x.ai` | Management Key + Team ID | 在插件配置里填 |
| gemini | 无 | — | 只有 AI Studio 网页 |
| mimo | 无 | — | 只有开放平台网页 |
| agnes | 无 | — | 全模态免费，无余额概念 |
| xai-oauth | 无 | — | 订阅制 |
| ollama / freetoken | 无 | — | 本地部署 |

## 发现变化时怎么改

1. 改 `lib/provider-directory.js` 对应条目的 `query.via` 与 `note`
2. 响应结构变了就改 `routes/api.js` 里对应的查询函数（`queryZhipuQuotaOne` / `queryOpenAICosts` / `queryCodexQuota` / `queryXaiBalance`）
3. 原本 `reachable=false` 的供应商如果出现了可查接口，把该条改成 `true`（它会从灰灯变成红/绿）
4. 跑 `node scripts/check-providers.mjs --verify` 与 `node scripts/ui-probe-provider-cards.cjs` 确认
5. 在 release notes 的「修复」或「优化」段里写清楚改了什么

## 为什么必须每次做

灯色语义（绿=可查 / 粉=本地 / 亮红=有门路没走到 / 灰=不可得）全部建立在这份判断上。
接口悄悄失效却没人发现，界面就会把一家其实查得到的供应商显示成「无接口」，或者反过来把该报警的显示成正常。
