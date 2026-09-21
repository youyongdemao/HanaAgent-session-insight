// scripts/normalize-crlf.mjs — 把改动过的文本文件统一成 CRLF（无 BOM）
// 用法：
//   node scripts/normalize-crlf.mjs            # 处理 git status 报出来的改动/新增文件
//   node scripts/normalize-crlf.mjs a.js b.json
// 为什么需要：编辑工具写文件时按 LF 落盘，而这个仓库的文件全是 CRLF，
// 混用会把整文件的换行差异带进 diff。改完源码跑一次即可。
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const TEXT_EXT = new Set([
  ".js", ".mjs", ".cjs", ".json", ".html", ".css",
  ".md", ".ps1", ".ts", ".txt", ".yml", ".yaml",
]);

let targets = process.argv.slice(2);
if (targets.length === 0) {
  const out = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" });
  targets = out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const rest = line.slice(3).trim();
      const arrow = rest.lastIndexOf(" -> ");
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, "");
    });
}

for (const rel of targets) {
  const full = join(repoRoot, rel);
  if (!existsSync(full) || !statSync(full).isFile()) continue;
  if (!TEXT_EXT.has(extname(full).toLowerCase())) continue;

  const raw = readFileSync(full, "utf8");
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  if (normalized === raw) continue;

  // 顺手去掉 BOM：仓库里其余文件都是无 BOM 的 UTF-8
  writeFileSync(full, normalized.replace(/^\uFEFF/, ""), "utf8");
  console.log(`normalized ${rel}`);
}
