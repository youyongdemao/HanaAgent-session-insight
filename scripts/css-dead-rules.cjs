// css-dead-rules.cjs —— 找出 CSS 里「写了但不生效」的声明
// 用法：
//   node scripts/css-dead-rules.cjs                     # 汇总
//   node scripts/css-dead-rules.cjs --list              # 逐条列出
//   node scripts/css-dead-rules.cjs --list .ah-num      # 只看某个选择器
//   DUMP=1 node scripts/css-dead-rules.cjs              # 打印 keyframes 内的规则（自查解析用）
// 判据：同一媒体条件下、同一选择器文本出现多次时，后面的规则声明的同一属性会盖掉前面的。
//       一条规则的全部声明都被盖掉，整条即可删除。
// 边界：不处理「选择器不同但特异性相同」的层叠（那种要浏览器算最终值），也不处理
//       important 与非 important 之外的优先级（如 @layer）。
const fs = require("fs"), path = require("path");
const { parse } = require("./lib/css-parse.cjs");

const CSS = path.resolve(__dirname, "..", "ui", "assets", "panel-v2.css");
const src = fs.readFileSync(CSS, "utf8");
const rules = parse(src);
rules.forEach((r, i) => (r.idx = i));

// 「选择器 + 媒体条件」→ 按出现顺序的规则链
const chains = new Map();
for (const r of rules) for (const s of r.sels) {
  const key = r.media + " || " + s;
  if (!chains.has(key)) chains.set(key, []);
  chains.get(key).push(r);
}

/** 该链上每个属性的最终归属：important 压过一切非 important，同层内后写优先 */
function cascader(list) {
  const lastImp = new Map(), lastNorm = new Map();
  for (let i = list.length - 1; i >= 0; i--) {
    for (const d of list[i].decls) {
      if (d.important) { if (!lastImp.has(d.prop)) lastImp.set(d.prop, list[i].idx); }
      else { if (!lastNorm.has(d.prop)) lastNorm.set(d.prop, list[i].idx); }
    }
  }
  return (r, d) => d.important
    ? lastImp.get(d.prop) === r.idx
    : (!lastImp.has(d.prop) && lastNorm.get(d.prop) === r.idx);
}

const dead = [], deadRules = [];
for (const [key, list] of chains) {
  if (list.length < 2) continue;
  const live = cascader(list);
  for (const r of list) {
    const lost = r.decls.filter((d) => !live(r, d));
    if (lost.length) dead.push({ key, rule: r, lost });
  }
}
for (const r of rules) {
  if (!r.decls.length) continue;
  let allDead = true;
  for (const s of r.sels) {
    const list = chains.get(r.media + " || " + s) || [];
    const live = cascader(list);
    if (!r.decls.every((d) => !live(r, d))) { allDead = false; break; }
  }
  if (allDead) deadRules.push(r);
}

const argv = process.argv.slice(2);
if (process.env.DUMP) {
  rules.filter((r) => /^(to|from|100%|\d+%)$/.test(r.selectors.trim())).slice(0, 8).forEach((r) =>
    console.log("DUMP sel=" + JSON.stringify(r.selectors) + " at=" + r.braceAt + " media=" + r.media)
  );
}

const listMode = argv.includes("--list");
const filter = argv.find((a) => !a.startsWith("--"));
const deadDeclCount = dead.reduce((n, d) => n + d.lost.length, 0);

console.log(`规则 ${rules.length} 条；选择器-媒体条件组合 ${chains.size} 组`);
console.log(`含死声明的规则 ${dead.length} 条；整条被覆盖的规则 ${deadRules.length} 条`);
console.log(`死声明合计 ${deadDeclCount} 条\n`);

if (listMode) {
  console.log("===== 整条被覆盖、可直接删的规则 =====");
  for (const r of deadRules) {
    if (filter && !r.sels.join(",").includes(filter)) continue;
    console.log(`  [${r.media}] ${r.sels.join(",").slice(0, 130)}`);
    console.log(`      {${r.decls.map((d) => d.prop + (d.important ? "!" : "")).join("; ")}}`);
  }
  console.log("\n===== 部分死声明（规则还在，这些声明不生效） =====");
  for (const d of dead) {
    if (filter && !d.key.includes(filter)) continue;
    if (deadRules.includes(d.rule)) continue;
    console.log(`● ${d.key}`);
    for (const l of d.lost) console.log(`    ✗ ${l.prop}: ${l.value.slice(0, 90)}`);
  }
}
