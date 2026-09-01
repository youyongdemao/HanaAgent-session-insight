export default function registerPluginUiRoutes(app, ctx) {
  app.get("/page", (c) => c.html(renderShell(c, ctx, "page")));
  app.get("/widget", (c) => c.html(renderShell(c, ctx, "widget")));
  app.get("/card", (c) => c.html(renderShell(c, ctx, "card")));
}

function renderShell(c, ctx, surface) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  const token = c.req.query("token") || "";
  const hot = c.req.query("hot") || "";
  const base = `/api/plugins/${encodeURIComponent(ctx.pluginId)}`;
  const title = "会话用量";
  const v2 = c.req.query("v") !== "1";
  const withToken = (url) => {
    let u = url;
    if (token) u += `${u.includes("?") ? "&" : "?"}${new URLSearchParams({ token })}`;
    u += `${u.includes("?") ? "&" : "?"}si_v=v2-glassdrop-20260901d&${new URLSearchParams({ hot })}`;
    return u;
  };
  const panelCss = withToken(`${base}/assets/${v2 ? "panel-v2.css" : "panel.css"}`);
  const panelJs = withToken(`${base}/assets/${v2 ? "panel-v2.js" : "panel.js"}`);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${hanaCss ? `<link id="hana-theme-css" rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  <link rel="stylesheet" href="${escapeAttr(panelCss)}">
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="${surface}">
  <div id="root" data-surface="${surface}"></div>
  <script>
    window.addEventListener("error", function (e) {
      var root = document.getElementById("root");
      if (root && !root.innerHTML) {
        root.innerHTML = '<div class="empty">面板加载失败：' + (e.message || "脚本错误") + "</div>";
      }
    });
  </script>
  <script type="module" src="${escapeAttr(panelJs)}"></script>
</body>
</html>`;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return escapeAttr(value).replace(/>/g, "&gt;");
}
