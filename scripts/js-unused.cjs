// js-unused.cjs —— 扫 ui/ 下的 JS，找「定义了但没人用」的具名函数与常量
// 用法：node scripts/js-unused.cjs
// 判据：名字在 JS + HTML（含模板字符串里的 id/class 引用）中出现次数为 1（只有定义处）。
// 局限：字符串里拼出来的引用、动态索引（obj[name]）、宿主侧约定名都可能造成假阳性，
//      所以输出一律当「候选」看待，删之前逐条确认。
const fs = require("fs"), path = require("path");
const DIR = path.resolve(__dirname, "..", "ui");
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|html)$/i.test(e.name)) files.push(p);
  }
})(DIR);

const texts = files.map((f) => ({ f, t: fs.readFileSync(f, "utf8") }));
const all = texts.map((x) => x.t).join("\n");

const DEF_RE = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function|async\s*function|\(|[A-Za-z_$][\w$]*\s*=>))/g;
const names = new Map();
for (const { f, t } of texts) {
  if (!f.endsWith(".js")) continue;
  let m;
  DEF_RE.lastIndex = 0;
  while ((m = DEF_RE.exec(t))) {
    const name = m[1] || m[2];
    if (!name) continue;
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(f);
  }
}

const unused = [];
for (const [name, where] of names) {
  const re = new RegExp("\\b" + name.replace(/\$/g, "\\$") + "\\b", "g");
  const count = (all.match(re) || []).length;
  if (count <= 1) unused.push({ name, where: [...new Set(where)].map((p) => path.relative(DIR, p)).join(",") });
}

console.log(`扫描 ${texts.length} 个文件；具名定义 ${names.size} 个；只出现一次的 ${unused.length} 个\n`);
unused.sort((a, b) => a.name.localeCompare(b.name)).forEach((u) => console.log(`  ${u.name}   (${u.where})`));
