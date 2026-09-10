# Git 开发与回滚

当前稳定基线标签：`v2-safe-baseline`

## 双轨版本策略（2026-09-10 定）

两条线并行维护，差异只在 `manifest.json` 的贡献块、版本号与 README 措辞，`assets/`、`lib/`、`routes/`、`pricing.json` 共用。

| 分支 | 定位 | 架构 | 发行 |
|------|------|------|------|
| `v2.0.x` | 发行线，日常工作分支 | 保留 legacy `page` / `widget` 贡献块 | 打 tag、发 release |
| `v2.1.x` | 影子线，跟随适配 | cards-only，删除 legacy 贡献块 | **不打 tag、不发 release，只本地提交** |

原因：2.1.0 在已发行 release 的 HanaAgent 上卡片窗口打不开，要等新卡片 UI 正式上线 release 后再全面迁移。

### 日常开发

功能改动一律先提交到 `v2.0.x`，按 release 节奏发版。

```powershell
git switch v2.0.x
git add -A
git commit -m "feat: 描述改动"
```

### 同步到影子线

功能在 `v2.0.x` 落地后，cherry-pick 到 `v2.1.x`：

```powershell
git switch v2.1.x
git cherry-pick <v2.0.x 上的提交>
```

`manifest.json` 冲突时保留 `v2.1.x` 的 cards-only 版本，只把 `version` 递增到对应的 2.1.x 号。

### 切换时机

等到猫猫明确说"可以发行 2.1.x"那天：`v2.1.x` 转为唯一开发线，`v2.0.x` 停止更新。在此之前的任何时候，`v2.1.x` 都不发行、不打 tag。

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
