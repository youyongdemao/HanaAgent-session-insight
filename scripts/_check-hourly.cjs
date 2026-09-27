// _check-hourly.cjs —— 用宿主真实明细验证按小时缓存：落盘内容、区间求和、清理
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const os = require("os");
const fs = require("fs");

(async () => {
  const db = new DatabaseSync("D:/AI/Hanako/usage-ledger.sqlite", { readOnly: true });
  const rows = db.prepare("select entry_json from usage_entries").all();
  const entries = rows.map((r) => { try { return JSON.parse(r.entry_json); } catch { return null; } }).filter(Boolean);
  console.log("明细条数:", entries.length, " 时间范围:", entries.map((e) => e.startedAt).sort()[0], "~", entries.map((e) => e.startedAt).sort().pop());

  const { missInputOf } = await import("../lib/usage-parser.js");
  const { updateHourlyCache, sumHoursInRange, hourlyCacheDays } = await import("../lib/hourly-cache.js");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "si-hourly-"));
  const ctx = { dataDir: tmp };
  for (const e of entries) e.__siCost = 0.001; // 费用口径本次不验证
  const now = Date.now();
  const t0 = Date.now();
  const wrote = updateHourlyCache(ctx, entries, now, missInputOf);
  console.log("聚合耗时:", Date.now() - t0, "ms   有完整小时落盘:", wrote);

  const dir = path.join(tmp, "ledger-hourly");
  const days = hourlyCacheDays(ctx);
  console.log("覆盖日期:", days.join(", "));
  let totalLines = 0, totalBytes = 0;
  for (const f of fs.readdirSync(dir)) {
    const txt = fs.readFileSync(path.join(dir, f), "utf8");
    const lines = txt.trim().split("\n").filter(Boolean);
    totalLines += lines.length; totalBytes += Buffer.byteLength(txt);
    console.log("  " + f + "  " + lines.length + " 行  " + Buffer.byteLength(txt) + "B   首行: " + lines[0]);
  }
  console.log("合计 " + totalLines + " 行 / " + totalBytes + " B");

  // 区间求和 vs 直接从明细算
  const hourMs = 3600e3;
  const nowH = now - (now % hourMs);
  const rng = [nowH - 3 * hourMs, nowH - 1 * hourMs];
  const s = sumHoursInRange(ctx, rng[0], rng[1]);
  let ref = 0, refHit = 0, refMiss = 0, refN = 0;
  for (const e of entries) {
    const ts = Date.parse(e.startedAt || "");
    if (!(ts >= rng[0] && ts < rng[1])) continue;
    const u = e.usage || {};
    const inTot = u.input?.totalTokens ?? u.input?.uncachedTokens ?? 0;
    const miss = missInputOf(u) ?? inTot;
    const hit = u.cache?.readTokens != null ? u.cache.readTokens : Math.max(0, inTot - miss);
    ref += u.totalTokens || 0; refHit += hit; refMiss += miss; refN++;
  }
  console.log("\n区间求和验证（最近 2 个已结束小时）:");
  console.log("  缓存:", s ? JSON.stringify({ tokens: Math.round(s.tokens), hit: Math.round(s.hit), miss: Math.round(s.miss), calls: Math.round(s.calls) }) : null);
  console.log("  明细:", JSON.stringify({ tokens: ref, hit: refHit, miss: refMiss, calls: refN }));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
})();
