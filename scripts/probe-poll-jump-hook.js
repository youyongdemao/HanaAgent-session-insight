// probe-poll-jump-hook.js —— 注入到页面（文档脚本之前），拦截 loadPage 关心的 /api 请求
// 只做记录，结果由 probe-poll-jump-report.js 读取分析。
(() => {
  if (window.__siRec) return;
  window.__siRec = [];
  const orig = window.fetch;
  window.fetch = async function (...a) {
    const res = await orig.apply(this, a);
    try {
      const u = String((a[0] && a[0].url) || a[0] || "");
      if (u.indexOf("/api/") >= 0) {
        const path = u.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        if (/\/(stats|ledger-stats|total-cost|sessions|events|balance|pricing|providers|rules)$/.test(path)) {
          res.clone().json().then((j) => { window.__siRec.push({ t: Math.round(performance.now()), path, j }); }).catch(() => {});
        }
      }
    } catch (e) {}
    return res;
  };
})();
