// _check-daily.cjs —— 用宿主真实按天汇总验证永久库：灌入、累计、不重复写
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");
const os = require("os");

(async () => {
  const db = new DatabaseSync("D:/AI/Hanako/usage-ledger.sqlite", { readOnly: true });
  const rows = db.prepare("select stat_day d, sum(total_tokens) t, sum(request_count) n, sum(cache_read_tokens) hit, sum(input_tokens) inn from usage_daily_rollups group by stat_day order by stat_day").all();
  const d0 = new Date();
  const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, "0")}-${String(d0.getDate()).padStart(2, "0")}`;
  const dayRows = new Map();
  for (const r of rows) {
    dayRows.set(r.d, { t: Number(r.t || 0), c: 0, hit: Number(r.hit || 0), miss: Math.max(0, Number(r.inn || 0) - Number(r.hit || 0)), n: Number(r.n || 0) });
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "si-daily-"));
  const ctx = { dataDir: tmp };
  const { ingestDays, dailyTotals, dailyDays } = await import("../lib/daily-store.js");

  console.log("宿主汇总天数:", rows.length, "（首日 " + rows[0].d + "，末日 " + rows[rows.length - 1].d + "）");
  console.log("今天是:", today);
  const asked = ingestDays(ctx, dayRows, today);
  console.log("落盘行数:", asked);
  const dir = path.join(tmp, "ledger-daily");
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean);
    total += lines.length;
    console.log("  " + f + "  " + lines.length + " 行   首行 " + lines[0]);
  }
  const tot = dailyTotals(ctx);
  console.log("累计返回:", JSON.stringify({
    tokens: (tot.tokens / 1e9).toFixed(2) + "B",
    calls: tot.calls,
    days: tot.days,
    firstDay: tot.firstDay,
    lastDay: tot.lastDay,
  }));
  console.log("文件行数合计:", total);
  const again = ingestDays(ctx, dayRows, today);
  console.log("同一批数据再灌一次，落盘行数（应为 0）:", again);
  console.log("再灌后累计天数（应不变）:", dailyTotals(ctx).days);
  fs.rmSync(tmp, { recursive: true, force: true });
})();
