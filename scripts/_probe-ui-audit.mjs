// scripts/_probe-ui-audit.mjs —— 在宿主压缩前端里定位某段文案的上下文（临时探针）
import { readFileSync } from "node:fs";

const file = process.argv[2];
const needle = process.argv[3] || "审核";
const t = readFileSync(file, "utf8");
let i = t.indexOf(needle);
let n = 0;
while (i >= 0 && n < 14) {
  console.log("--- @" + i);
  console.log(t.slice(Math.max(0, i - 320), i + 320).replace(/\s+/g, " "));
  i = t.indexOf(needle, i + 1);
  n++;
}
console.log("len=" + t.length + " hits=" + n);
