# Git 开发与回滚

当前稳定基线标签：`v2-safe-baseline`

## 双轨版本策略（2026-09-10 定）

> **2026-09-26 更新：`v2.0.x` 基本停更。** 此后所有开发只落 `v2.1.x`，不再往 `v2.0.x` 补功能或修复；下面「日常开发」里的 cherry-pick 流程作废。
> **2026-10-06 更新：`v2.1.x` 正式成为发行线。** HanaAgent 1.0 上线后，`v2.1.0` 已从 `v2.1.x` 打 tag 并发布 Release。此后 `v2.1.x` 既承担开发也承担发行，发行仍需猫猫明确开口。

两条线并行维护，差异只在 `manifest.json` 的贡献块、版本号与 README 措辞，`assets/`、`lib/`、`routes/`、`pricing.json` 共用。

| 分支 | 定位 | 架构 | 发行 |
|------|------|------|------|
| `v2.0.x` | 发行线，日常工作分支 | 保留 legacy `page` / `widget` 贡献块 | 打 tag、发 release |
| `v2.1.x` | 发行线（2026-10-06 起） | cards-only，删除 legacy 贡献块 | 打 tag、发 release |

原因：2.1.0 在已发行 release 的 HanaAgent 上卡片窗口打不开，要等新卡片 UI 正式上线 release 后再全面迁移。

### 日常开发

功能改动一律提交到 `v2.1.x`（`v2.0.x` 已停更，不再从那条线做开发）。

```powershell
git switch v2.1.x
git add -A
git commit -m "feat: 描述改动"
```

### 同步到影子线（已作废）

> 2026-09-26 起不再从 `v2.0.x` 往 `v2.1.x` 同步，开发直接落 `v2.1.x`。此节仅留作历史参考。

功能在 `v2.0.x` 落地后，cherry-pick 到 `v2.1.x`：

```powershell
git switch v2.1.x
git cherry-pick <v2.0.x 上的提交>
```

`manifest.json` 冲突时保留 `v2.1.x` 的 cards-only 版本，只把 `version` 递增到对应的 2.1.x 号。

### 切换时机

`v2.1.x` 自 2026-09-26 起是唯一开发线，自 2026-10-06 起同时是发行线（`v2.1.0` 已发行）。发行仍以猫猫明确开口为准。

### 远端约定

- `v2.1.x`：发行线，推送远端 `origin/v2.1.x`，release 从这条线出。
- `v2.0.x`：已停更，仅作历史保留。
- 远端 `main`：仓库默认分支，2026-10-06 起与 `v2.1.x` 同源（已跟进 2.1.0 发行状态）。根 `pricing.json` 由周三任务在 `repo-main`（main）改动后合并回 `v2.1.x`。
- 远端 tag `v2.1.0` 已指向发行提交，GitHub Releases 里有对应的 release。

## 查看状态

```powershell
git status
git log --oneline --decorate --graph
```

## 放弃单个文件的未提交修改

```powershell
git restore assets/panel-v2.js
```

## 回到安全基线

```powershell
git reset --hard v2-safe-baseline
```

`reset --hard` 会丢弃未提交内容，执行前先检查 `git status`。
