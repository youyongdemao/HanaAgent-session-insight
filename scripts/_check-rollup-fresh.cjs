// _check-rollup-fresh.cjs —— 看宿主按天汇总表（今天那行）多久更新一次
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("D:/AI/Hanako/usage-ledger.sqlite", { readOnly: true });
const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const q = () => db.prepare("select sum(total_tokens) t, sum(request_count) n from usage_daily_rollups where stat_day = ?").get(today);
const t0 = q();
console.log("今天(" + today + ") 汇总 T0:", JSON.stringify(t0));
const marks = [10, 20, 30, 45, 60];
let i = 0;
const tick = () => {
  const v = q();
  console.log("  T+" + marks[i] + "s :", JSON.stringify(v), v && t0 && v.t !== t0.t ? "← 变了" : "");
  i++;
  if (i < marks.length) setTimeout(tick, (marks[i] - marks[i - 1]) * 1000);
  else { db.close(); }
};
setTimeout(tick, marks[0] * 1000);
