# Git 开发与回滚

当前稳定基线标签：`v2-safe-baseline`

## 查看状态

```powershell
git status
git log --oneline --decorate --graph
```

## 提交新改动

```powershell
git add -A
git commit -m "描述改动"
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
