// css-prune.cjs —— 按 css-dead-rules 的判据，把「被覆盖的声明」从 CSS 里真正删掉
// 用法：
//   node scripts/css-prune.cjs            # 只统计，不改文件
//   node scripts/css-prune.cjs --apply    # 写回 ui/assets/panel-v2.css
// 删除范围：
//   · 整条被覆盖的规则 → 选择器到右花括号整段删除
//   · 部分死声明       → 只摘掉那几条声明（连同分隔符），注释与其余声明原样保留
const fs = require("fs"), path = require("path");
const { parse } = require("./lib/css-parse.cjs");

const CSS = path.resolve(__dirname, "..", "ui", "assets", "panel-v2.css");
const src = fs.readFileSync(CSS, "utf8");
const rules = parse(src);
rules.forEach((r, i) => (r.idx = i));

const chains = new Map();
for (const r of rules) for (const s of r.sels) {
  const key = r.media + " || " + s;
  if (!chains.has(key)) chains.set(key, []);
  chains.get(key).push(r);
}
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

const edits = [];
let killedRules = 0, killedDecls = 0;
for (const r of rules) {
  if (!r.decls.length) continue;
  // 多选择器规则：只要在任意一个选择器上该声明还活着，就保留（任一为活即活）
  const liveOf = new Map();
  for (const s of r.sels) {
    const live = cascader(chains.get(r.media + " || " + s) || []);
    for (const d of r.decls) if (liveOf.get(d) !== true) liveOf.set(d, live(r, d));
  }
  const live = new Set(r.decls.filter((d) => liveOf.get(d) === true));
  if (live.size === 0) {
    edits.push({ from: r.selStart, to: r.end + 1 });
    killedRules++;
    killedDecls += r.decls.length;
    continue;
  }
  const deadSegs = r.decls.filter((d) => !live.has(d)).sort((a, b) => b.start - a.start);
  for (const d of deadSegs) {
    const base = r.braceAt + 1;
    let from = base + d.start, to;
    if (d.end < r.raw.length) to = base + d.end + 1;          // 吃掉尾随的分号
    else { to = base + d.end; if (d.start > 0) from -= 1; }   // 末段无分号：吃掉前一个分号
    edits.push({ from, to });
    killedDecls++;
  }
}

edits.sort((a, b) => a.from - b.from);

// 合并相邻/重叠区间：摘「末段无分号」的声明时会往前吃掉一个分号，
// 而那个分号可能已在同规则上一段的删除区间里。不合并就会重复计数、删多字符。
const merged = [];
for (const e of edits) {
  const last = merged[merged.length - 1];
  if (last && e.from <= last.to) last.to = Math.max(last.to, e.to);
  else merged.push({ from: e.from, to: e.to });
}

if (process.argv.includes("--check")) {
  let bad = 0;
  for (const e of edits) {
    const seg = src.slice(e.from, e.to);
    const o = (seg.match(/\{/g) || []).length, c = (seg.match(/\}/g) || []).length;
    if (o !== c) { bad++; if (bad <= 8) console.log(`不平衡片段 [${e.from},${e.to})  {${o} }${c}  ` + JSON.stringify(seg.slice(0, 150))); }
  }
  console.log(`删除片段共 ${edits.length} 处，花括号不成对的 ${bad} 处`);
  // 重叠检测（升序排列下：后一处的起点不应落在前一处内部）
  let overlap = 0;
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].from < edits[i - 1].to) {
      overlap++;
      if (overlap <= 6) {
        const a = edits[i - 1], b = edits[i];
        console.log(`区间重叠: [${a.from},${a.to}) 与 [${b.from},${b.to})`);
        console.log("   左片段: " + JSON.stringify(src.slice(a.from, a.to).slice(0, 120)));
        console.log("   右片段: " + JSON.stringify(src.slice(b.from, b.to).slice(0, 120)));
      }
    }
  }
  for (const e of edits) if (!(e.from >= 0 && e.to >= e.from && e.to <= src.length)) console.log("区间越界", JSON.stringify(e));
  console.log(`重叠区间 ${overlap} 处`);
}
let out = src;
for (const e of merged.slice().sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + out.slice(e.to);

console.log(`原始 ${src.length} 字符 → 清理后 ${out.length} 字符（-${src.length - out.length}）`);
console.log(`删除整条规则 ${killedRules} 条；删除声明 ${killedDecls} 条；替换区间 ${edits.length} 处`);

// 自检：去掉注释后花括号必须仍然配平（注释里允许出现花括号），且重新解析后不应再有死声明
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const bare = strip(out);
const open = (bare.match(/\{/g) || []).length, close = (bare.match(/\}/g) || []).length;
console.log(`花括号 open=${open} close=${close} ${open === close ? "（配平）" : "（不平衡！）"}`);
const after = parse(out);
const afterChains = new Map();
for (const r of after) for (const s of r.sels) {
  const key = r.media + " || " + s;
  if (!afterChains.has(key)) afterChains.set(key, []);
  afterChains.get(key).push(r);
}
after.forEach((r, i) => (r.idx = i));
let remain = 0, remainSingle = 0;
for (const r of after) {
  const liveOf = new Map();
  for (const s of r.sels) {
    const live = cascader(afterChains.get(r.media + " || " + s) || []);
    for (const d of r.decls) if (liveOf.get(d) !== true) liveOf.set(d, live(r, d));
  }
  const deadN = r.decls.filter((d) => liveOf.get(d) !== true).length;
  remain += deadN;
  if (deadN && r.sels.length === 1) remainSingle += deadN;
}
console.log(`清理后残留死声明 ${remain} 条（其中单选择器规则 ${remainSingle} 条，应为 0）`);

if (process.argv.includes("--apply")) {
  if (open !== close) { console.log("花括号不平衡，拒绝写入"); process.exit(1); }
  fs.writeFileSync(CSS, out, "utf8");
  console.log("已写入 " + CSS);
} else {
  if (process.argv.includes("--out")) {
    const p = path.join(__dirname, "_pruned.css");
    fs.writeFileSync(p, out, "utf8");
    console.log("已写出预览 " + p);
  }
  console.log("（未写文件；加 --apply 生效）");
}
