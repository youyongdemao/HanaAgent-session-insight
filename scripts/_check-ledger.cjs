// _check-ledger.cjs —— 直接查宿主账本 SQLite，看数据到底覆盖到哪天
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const root = "D:/AI/Hanako";
const cands = [];
for (const n of fs.readdirSync(root)) {
  if (n.startsWith("usage-ledger.sqlite")) cands.push(path.join(root, n));
}
console.log("候选文件:", cands.map((c) => path.basename(c) + " (" + (fs.statSync(c).size / 1048576).toFixed(1) + "MB)").join(", "));
const dbPath = cands.find((c) => c.endsWith(".sqlite")) || cands[0];
if (!dbPath) { console.log("没找到 sqlite"); process.exit(0); }
let db;
try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { console.log("打开失败:", e.message); process.exit(0); }
const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
console.log("表:", tables.join(", "));
for (const t of tables) {
  try {
    const cols = db.prepare(`pragma table_info(${t})`).all().map((c) => c.name);
    const n = db.prepare(`select count(*) c from ${t}`).get().c;
    console.log(`\n[${t}] ${n} 行  列: ${cols.join(",")}`);
    // 找时间列
    const timeCol = cols.find((c) => /day|date|started|time|at$/i.test(c));
    if (timeCol) {
      const r = db.prepare(`select min(${timeCol}) a, max(${timeCol}) b from ${t}`).get();
      console.log(`  ${timeCol} 范围: ${r.a}  ~  ${r.b}`);
    }
    if (t === "usage_daily_rollups") {
      const by = db.prepare("select stat_day, count(*) c from usage_daily_rollups group by stat_day order by stat_day").all();
      console.log("  按天:", by.map((x) => x.stat_day + ":" + x.c).join(" "));
    }
  } catch (e) { console.log(`[${t}] 查询失败: ${e.message}`); }
}
db.close();
