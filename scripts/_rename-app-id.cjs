// 一次性改名工具：把 App id 从 session-insight-v2 改成 session-insight
//
// 只改「扩展 id」这一种出现，不动本地检出目录名（.../session-insight/session-insight-v2 里的
// 那一截是同名路径片段，改了会让探针的绝对路径指到不存在的目录）。
// 判据：命中前一个字符序列是 "session-insight/" 或 "session-insight\" 的，跳过。
//
// 用法：
//   node scripts/_rename-app-id.cjs            # 只看（dry-run），列出文件与命中数
//   node scripts/_rename-app-id.cjs --apply    # 写盘，逐文件核对字节增量
const fs = require("fs");
const path = require("path");

const FROM = "session-insight-v2";
const TO = "session-insight";
const APPLY = process.argv.includes("--apply");
const SELF = path.basename(__filename);

const ROOTS = [
  "D:/AI/Hanako/OH-WorkSpace/HanaApp-Dev",
  "D:/AI/Hanako/OH-WorkSpace/tools",
];
const EXT = new Set([".js", ".cjs", ".mjs", ".json", ".ps1", ".md", ".html", ".css", ".mts"]);
const SKIP_DIR = /(\\|\/)(\.git|node_modules|_aux|sdk|_dist|\.ephemeral|dist|dist-extensions|prompt-optimizer|answer-choice|video-summarizer|hanako-voice)(\\|\/)/i;
const SKIP_FILE = new Set([
  "pricing.json",
  SELF,
  "package-lock.json",
  "submit-market-pr.mjs",              // 手改（分支名要保留旧写法）
  "_manifest-backup-before-runtime.json", // 历史备份，不改
  "接力上下文-20260921.md",              // 历史交接文档，不改
]);

/** 命中处是否属于本地检出路径片段（...session-insight/session-insight-v2） */
function isLocalPathHit(text, at) {
  const before = text.slice(Math.max(0, at - 20), at);
  return /session-insight[\\/]$/.test(before);
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.test(full + path.sep)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      if (SKIP_FILE.has(e.name)) continue;
      if (!EXT.has(path.extname(e.name).toLowerCase())) continue;
      out.push(full);
    }
  }
}

const files = [];
for (const r of ROOTS) walk(r, files);

let totalHits = 0;
let totalSkipped = 0;
const report = [];
for (const f of files) {
  let text;
  try {
    text = fs.readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (!text.includes(FROM)) continue;
  let hits = 0;
  let skipped = 0;
  let out = "";
  let i = 0;
  while (true) {
    const at = text.indexOf(FROM, i);
    if (at < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, at);
    if (isLocalPathHit(text, at)) {
      out += FROM;
      skipped++;
    } else {
      out += TO;
      hits++;
    }
    i = at + FROM.length;
  }
  if (hits === 0 && skipped === 0) continue;
  totalHits += hits;
  totalSkipped += skipped;
  report.push({ f, hits, skipped, before: Buffer.byteLength(text, "utf8"), after: Buffer.byteLength(out, "utf8") });
  if (APPLY && hits > 0) {
    const expectDelta = -3 * hits; // "session-insight-v2" → "session-insight" 短 3 字节
    const actualDelta = report[report.length - 1].after - report[report.length - 1].before;
    if (actualDelta !== expectDelta) {
      console.error(`自检不过，未写入：${f} 期望 ${expectDelta} 实际 ${actualDelta}`);
      process.exitCode = 1;
      continue;
    }
    fs.writeFileSync(f, out, "utf8");
  }
}

if (report.length === 0) {
  console.log("没有命中。");
} else {
  for (const r of report.sort((a, b) => b.hits - a.hits)) {
    console.log(`${String(r.hits).padStart(3)} 改 / ${String(r.skipped).padStart(2)} 跳过（本地路径）  ${r.f.replace(/\\/g, "/").replace("D:/AI/Hanako/", "")}`);
  }
}
console.log(`\n合计：改 ${totalHits} 处，跳过 ${totalSkipped} 处（本地检出路径），涉及 ${report.length} 个文件。`);
console.log(APPLY ? "已写盘。" : "dry-run：未写盘。加 --apply 落盘。");
