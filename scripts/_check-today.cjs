// _check-today.cjs —— 验证「今天实时累计」的基准算法：与宿主汇总的今天值对得上
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");

(async () => {
  const db = new DatabaseSync("D:/AI/Hanako/usage-ledger.sqlite", { readOnly: true });
  const rows = db.prepare("select entry_json from usage_entries").all();
  const entries = rows.map((r) => { try { return JSON.parse(r.entry_json); } catch { return null; } }).filter(Boolean);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const { missInputOf } = await import("../lib/usage-parser.js");
  const { calcEntryCost } = await import("../lib/legacy-api.js").catch(() => ({ calcEntryCost: () => 0 }));
  const { acceptBase, todayTotals } = await import("../lib/today-live.js");

  acceptBase(entries, today, calcEntryCost, missInputOf);
  const t = todayTotals();
  const ref = db.prepare("select sum(total_tokens) t, sum(request_count) n, sum(cache_read_tokens) hit, sum(input_tokens) inn from usage_daily_rollups where stat_day = ?").get(today);
  const refMiss = Math.max(0, Number(ref.inn || 0) - Number(ref.hit || 0));

  console.log("今天:", today);
  console.log("基准(明细算)  :", JSON.stringify({ tokens: t.t, calls: t.n, hit: t.hit, miss: t.miss, baseTs: new Date(t.baseTs).toISOString() }));
  console.log("宿主汇总(对照):", JSON.stringify({ tokens: Number(ref.t), calls: Number(ref.n), hit: Number(ref.hit), miss: refMiss }));
  const dt = (t.t - Number(ref.t)) / Math.max(1, Number(ref.t));
  console.log("token 差异: " + (dt * 100).toFixed(3) + "%");
  db.close();
})();
