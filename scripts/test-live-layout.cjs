// 临时：把 index.js 里 LIVE_ITEMS→parseLiveLayout 这段抽出来跑用例（不加载整个 App）
const fs = require("fs");
const src = fs.readFileSync(process.argv[2] || "index.js", "utf8");
const start = src.indexOf("const LIVE_ITEMS");
const end = src.indexOf("const WIDGET_BLOCKS");
if (start < 0 || end < 0 || end < start) {
  console.error("定位失败", start, end);
  process.exit(1);
}
const snippet = src.slice(start, end);
const factory = new Function(snippet + "\nreturn { LIVE_ITEMS, LIVE_DEFAULT, LIVE_LAYOUT_REV, parseLiveLayout };");
const M = factory();

const ids = (o) => (o.on || []).join(",");
const cases = [
  ["老配置（五项、无 rev）", '{"order":["hit","tps","tokens","cost","duration"],"on":["hit","tps","tokens","cost","duration"]}', undefined, "tps,ttft,duration"],
  ["新默认应保留用户选择（rev 2）", '{"order":["hit","tps","ttft","tokens","cost","duration"],"on":["hit","tps"],"rev":2}', undefined, "hit,tps"],
  ["认不出的 id → 回默认", '{"order":["a","b","c"],"on":["a"],"rev":2}', undefined, "tps,ttft,duration"],
  ["null → 默认", null, undefined, "tps,ttft,duration"],
  ["空字符串 → 默认", "", undefined, "tps,ttft,duration"],
  ["保存路径：只开费用", { order: M.LIVE_ITEMS.map((i) => i.id), on: ["cost"] }, { saving: true }, "cost"],
  ["保存路径：空对象 = 恢复默认", {}, { saving: true }, "tps,ttft,duration"],
  ["保存路径：带旧 rev 也照收", { order: M.LIVE_ITEMS.map((i) => i.id), on: ["duration"], rev: 1 }, { saving: true }, "duration"],
];
let bad = 0;
for (const [name, raw, opts, expect] of cases) {
  const got = M.parseLiveLayout(raw, opts);
  const ok = ids(got) === expect && got.order.length === M.LIVE_ITEMS.length && got.rev === M.LIVE_LAYOUT_REV;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}\n     on = ${ids(got) || "(空)"}   order = ${got.order.length} 项  rev = ${got.rev}   期望 on = ${expect}`);
}
console.log("默认集 = " + M.LIVE_DEFAULT.join(","));
console.log(bad ? `结果：${bad} 条不符合预期` : "结果：全部符合");
