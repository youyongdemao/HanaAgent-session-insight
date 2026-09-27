// _check-fill.cjs —— 用宿主真实的按天汇总，验证「d7/d30 桶按时间重叠摊分」的算法结果合理
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("D:/AI/Hanako/usage-ledger.sqlite", { readOnly: true });
const rows = db.prepare("select stat_day d, sum(total_tokens) tokens, sum(cache_read_tokens) hit, sum(input_tokens) inn from usage_daily_rollups group by stat_day").all();
const DAY_MS = 86400000, now = Date.now();
const rollDays = new Map();
for (const r of rows) rollDays.set(r.d, { tokens: Number(r.tokens || 0), hit: Number(r.hit || 0), inn: Number(r.inn || 0) });

// 与补丁同一套逻辑
const fillSpan = (arr, spanMs, pick) => {
  const start = now - spanMs, cellMs = spanMs / 256;
  for (let i = 0; i < 256; i++) {
    if (arr[i]) continue;
    const t0 = start + i * cellMs, t1 = t0 + cellMs;
    let v = 0;
    for (const [d, agg] of rollDays) {
      const ds = Date.parse(d + "T00:00:00+08:00");
      if (!Number.isFinite(ds)) continue;
      const ov = Math.min(t1, ds + DAY_MS) - Math.max(t0, ds);
      if (ov > 0) v += pick(agg, d) * (ov / DAY_MS);
    }
    if (v > 0) arr[i] = Math.round(v);
  }
  return arr;
};
const sum = (a) => a.reduce((x, y) => x + y, 0);
const nz = (a) => a.filter((v) => v > 0).length;

const t7 = fillSpan(Array(256).fill(0), 7 * 86400e3, (a) => a.tokens);
const t30 = fillSpan(Array(256).fill(0), 30 * 86400e3, (a) => a.tokens);

// 参照：最近 7 天 / 30 天的汇总总量
const dayMs = (d) => Date.parse(d + "T00:00:00+08:00");
let ref7 = 0, ref30 = 0;
for (const [d, a] of rollDays) {
  const ds = dayMs(d);
  if (ds + DAY_MS > now - 7 * 86400e3) ref7 += a.tokens;
  if (ds + DAY_MS > now - 30 * 86400e3) ref30 += a.tokens;
}
console.log("汇总天数:", rollDays.size);
console.log("d7  桶: 非空格 " + nz(t7) + "/256   总量 " + (sum(t7) / 1e6).toFixed(1) + "M   参照(最近7天汇总) " + (ref7 / 1e6).toFixed(1) + "M   比值 " + (sum(t7) / ref7).toFixed(3));
console.log("d30 桶: 非空格 " + nz(t30) + "/256   总量 " + (sum(t30) / 1e6).toFixed(1) + "M   参照(最近30天汇总) " + (ref30 / 1e6).toFixed(1) + "M   比值 " + (sum(t30) / ref30).toFixed(3));
console.log("d7 末 16 格(M):", t7.slice(-16).map((v) => (v / 1e6).toFixed(1)).join(" "));
db.close();
