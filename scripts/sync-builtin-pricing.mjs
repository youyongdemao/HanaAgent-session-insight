#!/usr/bin/env node
// scripts/sync-builtin-pricing.mjs
//
// 从仓库根的 pricing.json 生成 lib/usage-parser.js 里的内置兜底数据，
// 让「在线数据库」和「离线兜底」出自同一份真相，不再靠手抄。
//
// 用法：node scripts/sync-builtin-pricing.mjs [pricingJsonPath]
// 默认读 <repo>/pricing.json，写 <repo>/lib/usage-parser.js 的标记区间。
//
// 标记区间由本脚本在首次运行时自动建立（把原有的 PRICING_SNAPSHOT_AT /
// SOURCE_NOTE / PRICING / PROVIDER_OF_MODEL / CONTEXT_WINDOW 五个声明整体接管）。
// 生成区内的内容请勿手工编辑，改了会在下次运行时被覆盖。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const dbPath = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, "pricing.json");
const parserPath = join(repoRoot, "lib", "usage-parser.js");

const START = "// >>> BUILTIN-PRICING-DATA";
const END = "// <<< BUILTIN-PRICING-DATA";

const db = JSON.parse(readFileSync(dbPath, "utf8"));
if (!db || typeof db !== "object" || !db.models || typeof db.models !== "object") {
  console.error("pricing.json 结构不对：缺少 models 对象");
  process.exit(1);
}

const isPrice = (p) =>
  !!p && ["inputMiss", "inputHit", "output"].every((k) => typeof p[k] === "number" && Number.isFinite(p[k]) && p[k] >= 0);

const notes = [];
const prices = [];
const providers = [];
const windows = [];
const skipped = [];

for (const key of Object.keys(db.models).sort()) {
  const cfg = db.models[key];
  if (!cfg || typeof cfg !== "object") { skipped.push(key + "（条目不是对象）"); continue; }

  let price = null;
  if (isPrice(cfg.flat)) {
    price = { inputMiss: cfg.flat.inputMiss, inputHit: cfg.flat.inputHit, output: cfg.flat.output };
  } else if (isPrice(cfg.peak) && isPrice(cfg.offPeak)) {
    price = {
      peak: { inputMiss: cfg.peak.inputMiss, inputHit: cfg.peak.inputHit, output: cfg.peak.output },
      offPeak: { inputMiss: cfg.offPeak.inputMiss, inputHit: cfg.offPeak.inputHit, output: cfg.offPeak.output },
    };
  }
  if (!price) { skipped.push(key + "（既没有合法 flat 也没有合法 peak/offPeak）"); continue; }

  prices.push([key, price]);
  if (typeof cfg.source === "string" && cfg.source) notes.push([key, cfg.source]);
  const owner = (typeof cfg.provider === "string" && cfg.provider) || (key.includes("::") ? key.split("::")[0] : null);
  if (owner) providers.push([key, owner]);
  if (typeof cfg.contextWindow === "number" && cfg.contextWindow > 0) windows.push([key, cfg.contextWindow]);
}

const q = (s) => JSON.stringify(s);
const flatObj = (o) => `{ inputMiss: ${o.inputMiss}, inputHit: ${o.inputHit}, output: ${o.output} }`;
const priceLiteral = (p) =>
  p.peak
    ? `{\n    peak: ${flatObj(p.peak)},\n    offPeak: ${flatObj(p.offPeak)},\n  }`
    : flatObj(p);
const mapLiteral = (rows) => rows.map(([k, v]) => `  ${q(k)}: ${typeof v === "string" ? q(v) : v},`).join("\n");

const block = [
  START + " 由 scripts/sync-builtin-pricing.mjs 从 pricing.json 生成，请勿手工编辑",
  `let PRICING_SNAPSHOT_AT = ${q(db.snapshotAt || "")};`,
  "",
  "// 价格来源标注（官方 / 折算 / 免费 / 未核实），用于透明呈现",
  "let SOURCE_NOTE = {",
  mapLiteral(notes),
  "};",
  "",
  "// 单价（元/百万 tokens）。键为「供应商::模型」限定键；全库唯一的模型另有裸键，供旧版回退。",
  "let PRICING = {",
  prices.map(([k, p]) => `  ${q(k)}: ${priceLiteral(p)},`).join("\n"),
  "};",
  "",
  "// 模型归属供应商（限定键同时登记裸键归属）",
  "let PROVIDER_OF_MODEL = {",
  mapLiteral(providers),
  "};",
  "",
  "// 上下文窗口（tokens）",
  "let CONTEXT_WINDOW = {",
  mapLiteral(windows),
  "};",
  END,
].join("\n");

let src = readFileSync(parserPath, "utf8");
const s = src.indexOf(START);
const e = src.indexOf(END);

if (s >= 0 && e > s) {
  src = src.slice(0, s) + block + src.slice(e + END.length);
} else {
  // 首次运行：把从 PRICING_SNAPSHOT_AT 声明到 CONTEXT_WINDOW 块结束的整段替换掉
  const head = "// ── 计费配置（内置兜底）──";
  const hi = src.indexOf(head);
  const anchor = src.indexOf("let PRICING_SNAPSHOT_AT");
  const after = src.indexOf("\nfunction round(", anchor);
  if (hi < 0 || anchor < 0 || after < 0) {
    console.error("找不到内置数据段（PRICING_SNAPSHOT_AT … function round），无法接管");
    process.exit(1);
  }
  const lead = [
    head,
    "// 这份内置数据由 scripts/sync-builtin-pricing.mjs 从仓库根 pricing.json 生成。",
    "// 运行期若成功拉到外部 pricing.json，会由 setPricingConfig() 覆盖以下导出值。",
    "",
  ].join("\n");
  src = src.slice(0, hi) + lead + block + src.slice(after);
}

writeFileSync(parserPath, src, "utf8");

console.log(`pricing.json: ${dbPath}`);
console.log(`snapshotAt: ${db.snapshotAt}`);
console.log(`写入条目 ${prices.length}（含限定键与裸键）；来源标注 ${notes.length}；归属 ${providers.length}；窗口 ${windows.length}`);
if (skipped.length) {
  console.log(`跳过 ${skipped.length} 条无有效价格的条目：`);
  for (const line of skipped) console.log("  - " + line);
}
