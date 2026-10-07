// scripts/_show-lines.mjs —— 打印指定行或含某关键词的行号（长压缩行排查用）
import { readFileSync } from "node:fs";

const f = process.argv[2];
const src = readFileSync(f, "utf8");
const lines = src.split(/\r?\n/);
const args = process.argv.slice(3);

if (args[0] === "--grep") {
  const needle = args[1];
  lines.forEach((l, i) => {
    if (l.includes(needle)) console.log(`LINE ${i + 1}  len=${l.length}`);
  });
} else if (args[0] === "--find") {
  const needle = args[1];
  const win = Number(args[2] || 240);
  lines.forEach((l, i) => {
    let at = l.indexOf(needle);
    while (at >= 0) {
      console.log(`LINE ${i + 1} @${at}: ...${l.slice(Math.max(0, at - win), at + win)}...`);
      at = l.indexOf(needle, at + 1);
    }
  });
} else {
  for (const n of args) {
    const i = Number(n) - 1;
    console.log(`===== line ${n} (len=${lines[i].length}) =====`);
    console.log(lines[i]);
  }
}
