// probe-poll-jump-report.js —— 在页面里执行：按槽位比较每次响应的规范化 JSON
// 复刻 dataSig() 的 drop 规则，回答「同一个接口的两次响应是否真的不同」。
(() => {
  const rec = window.__siRec || [];
  const drop = (k, v) => (/^(updatedAt|updated_at|checkedAt|fetchedAt|ts|time|at|now|elapsedMs|ageMs)$/.test(k) ? undefined : v);
  const S = (o) => { try { return JSON.stringify(o, drop) || ""; } catch (e) { return ""; } };
  const slotOf = (p) => {
    const m = /\/api\/([a-z-]+)$/.exec(p);
    const x = m ? m[1] : "";
    return x === "ledger-stats" ? "ledger" : x === "stats" ? "stats" : x === "total-cost" ? "totalCost"
      : x === "sessions" ? "sessions" : x === "events" ? "events" : x === "balance" ? "balance"
      : x === "pricing" ? "pricing" : x === "providers" ? "providers" : x === "rules" ? "rules" : null;
  };
  const by = {};
  for (const r of rec) {
    const s = slotOf(r.path);
    if (!s) continue;
    (by[s] = by[s] || []).push({ t: r.t, v: S(r.j) });
  }
  const out = [];
  for (const k of Object.keys(by)) {
    const arr = by[k];
    const uniq = [...new Set(arr.map((x) => x.v))];
    out.push({
      slot: k, n: arr.length, times: arr.map((x) => x.t), variants: uniq.length,
      sample: uniq.length > 1 ? [uniq[0].slice(0, 300), uniq[1].slice(0, 300)] : null,
    });
  }
  return { total: rec.length, slots: out };
})();
