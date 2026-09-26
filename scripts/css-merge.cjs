// css-merge.cjs —— 把「同一个选择器写了多条规则」合并成一条
// 用法：
//   node scripts/css-merge.cjs            # dry-run，看会合并什么
//   node scripts/css-merge.cjs --apply    # 写回 ui/assets/panel-v2.css
// 前提：死声明已经由 css-prune 清过（被覆盖的声明不在了，剩下的都是活声明）。
// 做法：对每个「选择器 + 媒体条件」链，把链上前面的规则体按顺序并到链尾那条规则的开头，
//       然后删掉前面那些规则 —— 声明顺序保持原样，因此层叠结果不变。
// 只处理「前面那条规则服务的每个选择器，其链尾都是同一条规则」的情形；
// 其余（一条规则被拆归到不同的后续规则）跳过，不动。
const fs = require("fs"), path = require("path");
const { parse } = require("./lib/css-parse.cjs");

const CSS = path.resolve(__dirname, "..", "ui", "assets", "panel-v2.css");
const src = fs.readFileSync(CSS, "utf8");
const rules = parse(src);
rules.forEach((r, i) => (r.idx = i));

const chains = new Map();
for (const r of rules) for (const s of r.sels) {
  const k = r.media + " || " + s;
  if (!chains.has(k)) chains.set(k, []);
  chains.get(k).push(r);
}

const bodyOf = (r) => src.slice(r.braceAt + 1, r.end).trim().replace(/;\s*$/, "");

const kill = new Set();
const prefix = new Map();   // 链尾规则 → 要并到它开头的声明片段（按顺序）
let skipped = 0;

for (const [key, list] of chains) {
  if (list.length < 2) continue;
  const tail = list[list.length - 1];
  const heads = list.slice(0, -1);
  // 只合并「选择器组一字不差」的重复规则。
  // 若 head 是 `.a` 而 tail 是 `.a,.b`，把 head 的声明搬进 tail 会把它扩散到 `.b` 上 ——
  // 这是 2026-09-26 第一次合并时 550 处渲染差异的来源。
  const sig = (r) => r.sels.slice().sort().join(",");
  const tsig = sig(tail);
  if (!heads.every((h) => sig(h) === tsig)) { skipped += heads.length; continue; }
  const parts = prefix.get(tail) || [];
  for (const h of heads.sort((a, b) => a.idx - b.idx)) {
    if (kill.has(h)) continue;
    const b = bodyOf(h);
    if (b) parts.push({ idx: h.idx, body: b });
    kill.add(h);
  }
  prefix.set(tail, parts);
}

const edits = [];
for (const h of kill) edits.push({ from: h.selStart, to: h.end + 1, text: "" });
for (const [tail, parts] of prefix) {
  const own = bodyOf(tail);
  // 关键：多条链可能汇到同一条链尾，拼接前必须按原规则在文件里的先后排序，
  // 否则声明顺序会被打乱，本来「后写覆盖前写」的属主就换了人。
  const ordered = parts.slice().sort((a, b) => a.idx - b.idx).map((p) => p.body);
  const merged = ordered.concat(own ? [own] : []).join(";");
  edits.push({ from: tail.braceAt + 1, to: tail.end, text: merged });
}

edits.sort((a, b) => a.from - b.from);
const mergedEdits = [];
for (const e of edits) {
  const last = mergedEdits[mergedEdits.length - 1];
  if (last && e.from <= last.to) continue;   // 理论上不会重叠，保险
  mergedEdits.push(e);
}

let out = src;
for (const e of mergedEdits.slice().sort((a, b) => b.from - a.from)) {
  out = out.slice(0, e.from) + e.text + out.slice(e.to);
}

console.log(`原始 ${src.length} 字符 → 合并后 ${out.length} 字符（${out.length - src.length >= 0 ? "+" : ""}${out.length - src.length}）`);
console.log(`并入 ${kill.size} 条规则到 ${prefix.size} 条链尾规则；跳过 ${skipped} 条（归属不唯一）`);

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const bare = strip(out);
const open = (bare.match(/\{/g) || []).length, close = (bare.match(/\}/g) || []).length;
console.log(`花括号 open=${open} close=${close} ${open === close ? "（配平）" : "（不平衡！）"}`);

if (process.argv.includes("--apply")) {
  if (open !== close) { console.log("花括号不平衡，拒绝写入"); process.exit(1); }
  fs.writeFileSync(CSS, out, "utf8");
  console.log("已写入 " + CSS);
} else {
  console.log("（未写文件；加 --apply 生效）");
}
