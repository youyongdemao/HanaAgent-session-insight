# Git 开发与回滚

当前稳定基线标签：`v2-safe-baseline`

## 分支策略：单线（2026-10-06 起）

`main` 是唯一分支，开发、发行、定价数据全在这一条线上。

历史沿革：2026-09-10 起分 `v2.0.x`（发行线）与 `v2.1.x`（影子线）双轨；2026-09-26 `v2.0.x` 停更、开发收敛到 `v2.1.x`；2026-10-06 `v2.1.0` 发行后，`v2.1.x` 合并回 `main` 并删除，双轨结束。

## 日常开发

```powershell
git switch main
git add -A
git commit -m "feat: 描述改动"
git push origin main
```

## 发版

一条命令，出三个资产（手动包 + 市场包 + entry.json）：

```powershell
# 在 D:\AI\Hanako\OH-WorkSpace\HanaApp-Dev 下执行
node tools\release-hana.mjs session-insight X.Y.Z
```

细则与四条纪律见 `记忆\发版规范.md`、`记忆\HanaApp-开发与发布流程.md`。旧的 `pack-plugin.ps1` / `release.mjs` 已废弃删除。

## 定价数据

根 `pricing.json` 由每周三 02:30 的自动化任务「检查计费配置更新」维护。它只在 `repo` 这个工作树里操作，提交时只 `git add pricing.json lib/usage-parser.js` 两个文件，不要带上工作区里的其他改动。

## 远端约定

- `main`：仓库默认分支，唯一开发与发行线。
- `v2.0.x`：已停更，仅作历史保留。
- tag `v2.1.0`：已指向发行提交（合线前的 `v2.1.x` HEAD）。

## 查看状态

```powershell
git status
git log --oneline --decorate --graph
```

## 放弃单个文件的未提交修改

```powershell
git restore ui/assets/panel-v2.js
```

## 回到安全基线

```powershell
git reset --hard v2-safe-baseline
```

`reset --hard` 会丢弃未提交内容，执行前先检查 `git status`。
