# CSS 维护纪律

## 铁律：新规则覆盖旧规则时，把旧的删掉

同一个选择器（媒体条件也相同）不要出现两条规则靠「后写优先」来分胜负。改样式时如果新写法压住了旧写法，就把旧的那条从文件里删掉，而不是在下面再叠一条。

原因：这么叠下去之后，没人能一眼看出哪条生效。2026-09-26 清理时，
`body:not([data-surface="widget"]) .hero-pricing .api-hero .ah-block-cost .ah-num` 这一个选择器上叠了 5 条规则，想改个字号要连着读五处，还得数顺序。

## 改完 CSS 的三步

### 1. 体检：还有没有被完整覆盖的规则

```powershell
node scripts/css-dead-rules.cjs            # 汇总
node scripts/css-dead-rules.cjs --list     # 逐条清单
node scripts/css-dead-rules.cjs --list .ah-num   # 只看某个选择器
```

「整条被覆盖的规则」必须是 **0**。

### 2. 清理（需要时）

```powershell
node scripts/css-prune.cjs            # dry-run：看会删什么
node scripts/css-prune.cjs --apply    # 写回
```

### 3. 验证：渲染指纹必须零差异

```powershell
node scripts/css-render-diff.cjs dump scripts/_render-before.json
node scripts/css-prune.cjs --apply
node scripts/css-render-diff.cjs dump scripts/_render-after.json
node scripts/css-render-diff.cjs diff scripts/_render-before.json scripts/_render-after.json
```

采集范围：5 档窗口宽度（1280 / 1000 / 760 / 600 / 500）× 2 个页面 × 全部元素 × 60 个计算属性。
光晕类 `box-shadow` / `filter` 的模糊半径每帧在抖（同一份 CSS 连跑两次也差 0.2px），脚本对这两项只比较「有 / 无」，所以正常情况下**两次 diff 都应该是 0 处差异**。

**这一步不能跳。** 第一次清理时判据写错了：拆选择器组用的是普通 `split(",")`，把 `:is(.panel , .card , .chart-card)` 括号里的逗号也当成了分隔符，于是一条 `:is(...)` 规则冒名顶替了真正匹配 `.card` 的规则，把合法声明判成死声明、删掉了 `.card` 的背景与阴影。是渲染对比把它抓出来的，不是代码审查看出来的。

清理完记得删掉临时文件（`scripts/_render-*.json` 这类一份就有十几兆）。

## 局限：自动验证覆盖不到的地方

渲染指纹只跑静态态。**按钮 hover、卡片 hover、弹层展开、断点边界**这些状态不在网里，改动涉及它们时要手动点一遍：

- 卡片悬停的缩放与光晕
- API 页「刷新全部」等按钮的悬停
- 会话详情弹层的打开与收起
- 窗口拖到 640px 附近，看模型占比那块的圆环居中

## 工具

| 脚本 | 用途 |
|------|------|
| `scripts/css-dead-rules.cjs` | 找被后续规则覆盖的声明（同选择器 + 同媒体条件，`!important` 分层比较） |
| `scripts/css-prune.cjs` | 按上面的判据真正删除：区间合并去重、花括号自检、删完复查残留 |
| `scripts/css-render-diff.cjs` | 渲染指纹采集与比对（dump / diff 两种模式） |
| `scripts/css-rule-audit.cjs` | 花括号配平 + 「文件里有但 CSSOM 里没有」的选择器，用来查被吞掉的规则 |
| `scripts/js-unused.cjs` | JS 里定义了但没有任何引用点的函数 / 常量 |
| `scripts/lib/css-parse.cjs` | 共用解析器（拆选择器组时只认括号外的逗号；注释换成等长空格以避免污染 at 规则头） |

`sync-to-installed.ps1` 已内置第 1 步体检：同步时会检查「整条被覆盖的规则」，不为 0 就给出警告。

## 已知边界

- **跨特异性覆盖没有做**：`.ah-num` 被 `body:not(...) .ah-block-cost .ah-num` 压住这一类，静态分析判断不了，得让浏览器算最终值。目前只处理「选择器文本完全相同」的覆盖。
- **多选择器规则里的部分死声明不删**：一条规则同时服务多个选择器时，某条声明可能只在其中一个选择器上不生效，删了会连带影响另一个，所以留着（清理后会剩几十条这类，属正常）。
- **`@keyframes` / `@font-face` 内部不参与分析**，整体跳过。
