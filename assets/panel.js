// assets/panel.js — Session Insight 前端
// widget: 常驻状态条；page: 指标 + 图表可视化

const PROTOCOL = "hana.plugin.ui";
const VERSION = 1;
let seq = 0;

function targetOrigin() {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("hana-host-origin");
  if (explicit) return explicit;
  try {
    return new URL(document.referrer).origin;
  } catch {
    return "*";
  }
}

function post(message) {
  window.parent.postMessage(message, targetOrigin());
}

function event(type, payload) {
  post({ protocol: PROTOCOL, version: VERSION, kind: "event", type, payload });
}

function request(type, payload, timeoutMs = 10000) {
  const id = `hana-plugin-${Date.now()}-${++seq}`;
  const origin = targetOrigin();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`Host request timed out: ${type}`));
    }, timeoutMs);

    function onMessage(evt) {
      if (evt.source !== window.parent) return;
      if (origin !== "*" && evt.origin !== origin) return;
      const msg = evt.data || {};
      if (msg.protocol !== PROTOCOL || msg.version !== VERSION || msg.id !== id || msg.type !== type) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (msg.kind === "error") reject(new Error(msg.error?.message || `Host request failed: ${type}`));
      else resolve(msg.payload);
    }

    window.addEventListener("message", onMessage);
    post({ protocol: PROTOCOL, version: VERSION, id, kind: "request", type, payload });
  });
}

function currentPluginId() {
  const match = /^\/api\/plugins\/([^/]+)(?:\/|$)/.exec(window.location.pathname || "");
  if (!match) throw new Error("Plugin API helper requires an iframe route under /api/plugins/:pluginId/.");
  return decodeURIComponent(match[1]);
}

function normalizePluginApiPath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Invalid plugin API path.");
  const trimmed = input.trim();
  if (
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.includes("#") ||
    trimmed.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) throw new Error("Invalid plugin API path.");

  const stripped = trimmed.replace(/^\/+/, "");
  if (!stripped || stripped.startsWith("./") || stripped === "api/plugins" || stripped.startsWith("api/plugins/")) {
    throw new Error("Invalid plugin API path. Use a route path relative to the current plugin.");
  }
  const queryIndex = stripped.indexOf("?");
  const rawPath = queryIndex >= 0 ? stripped.slice(0, queryIndex) : stripped;
  const segments = rawPath.split("/");
  for (const segment of segments) {
    if (!segment) throw new Error("Invalid plugin API path.");
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("Invalid plugin API path.");
    }
  }
  const parsed = new URL(`http://hana.local/${stripped}`);
  return `${segments.map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/")}${parsed.search}`;
}

function pluginApiUrl(path) {
  return `${window.location.origin}/api/plugins/${encodeURIComponent(currentPluginId())}/${normalizePluginApiPath(path)}`;
}

function pluginApiFetch(path, init = {}) {
  const surfaceSession = new URLSearchParams(window.location.search).get("pluginSurfaceSession");
  if (!surfaceSession) throw new Error("hana.api.fetch requires pluginSurfaceSession in the iframe URL.");
  const headers = new Headers(init.headers || {});
  headers.set("X-Hana-Plugin-Surface-Session", surfaceSession);
  return fetch(pluginApiUrl(path), { ...init, headers });
}

const hana = {
  ready: () => event("hana.ready"),
  ui: { resize: (size) => event("ui.resize", size) },
  api: { url: pluginApiUrl, fetch: pluginApiFetch },
  toast: { show: (input) => request("toast.show", input) },
};

const root = document.getElementById("root");
const surface = root?.dataset.surface || "page";

/* ── 宿主主题同步：iframe 不重载时也实时跟随 HanaAgent ── */
function applyHostTheme(theme) {
  const raw = typeof theme === "string" ? theme.trim() : "";
  const next = raw && raw !== "inherit" && raw !== "auto" ? raw : "warm-paper";
  if (document.documentElement.dataset.theme !== next) document.documentElement.dataset.theme = next;
  if (document.body.dataset.hanaTheme !== next) document.body.dataset.hanaTheme = next;
}

function initHostThemeSync() {
  const initial = new URLSearchParams(window.location.search).get("hana-theme")
    || document.body.dataset.hanaTheme
    || "warm-paper";
  applyHostTheme(initial);

  try {
    const hostWindow = window.parent;
    const hostDocument = hostWindow.document;
    const hostRoot = hostDocument.documentElement;
    const media = hostWindow.matchMedia?.("(prefers-color-scheme: dark)");

    const readHostTheme = () => {
      // 用户在设置里选择的主题优先；避免宿主切换过程中 data-theme 短暂保留旧值。
      const saved = hostWindow.localStorage?.getItem("hana-theme")?.trim();
      if (saved && saved !== "auto") return saved;
      if (saved === "auto") return media?.matches ? "midnight" : "warm-paper";
      const attr = hostRoot.getAttribute("data-theme")?.trim()
        || hostDocument.body?.getAttribute("data-theme")?.trim();
      if (attr) return attr;
      return initial && initial !== "inherit" ? initial : "warm-paper";
    };

    const sync = () => applyHostTheme(readHostTheme());
    sync();

    const observer = new MutationObserver(sync);
    observer.observe(hostRoot, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    if (hostDocument.body) {
      observer.observe(hostDocument.body, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    }
    hostWindow.addEventListener("storage", sync);
    hostWindow.addEventListener("hana-settings", sync);
    media?.addEventListener?.("change", sync);
    const timer = hostWindow.setInterval(sync, 500);

    window.addEventListener("beforeunload", () => {
      observer.disconnect();
      hostWindow.removeEventListener("storage", sync);
      hostWindow.removeEventListener("hana-settings", sync);
      media?.removeEventListener?.("change", sync);
      hostWindow.clearInterval(timer);
    }, { once: true });
  } catch {
    // 跨域或宿主限制时保留 URL 初始主题，不影响插件加载
  }
}

initHostThemeSync();

// 真实插件 iframe 可能与宿主跨域；以宿主 postMessage 为权威主题源。
function onHostThemeMessage(evt) {
  if (evt.source !== window.parent) return;
  const origin = targetOrigin();
  if (origin !== "*" && evt.origin !== origin) return;
  const msg = evt.data || {};
  if (msg.type !== "hana.host.theme" && msg.type !== "hana.host.context") return;
  const theme = msg.payload?.theme;
  if (typeof theme === "string" && theme.trim()) applyHostTheme(theme);
}
window.addEventListener("message", onHostThemeMessage);

/* ── SVG 图表（零依赖手绘） ───────────────────────────── */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function providerStatusSummary(item) {
  if (!item) return "–";
  if (item.summary) return String(item.summary);
  if (item.total != null) {
    const symbol = item.currency === "USD" ? "$" : "¥";
    return `${symbol}${Number(item.total).toFixed(2)}`;
  }
  return "–";
}

function providerStatusDetail(item, model) {
  if (!item) return `当前模型：${model || "未知"}`;
  const parts = [];
  if (Array.isArray(item.windows)) {
    for (const window of item.windows) {
      const name = window.name || (window.type === "TOKENS_LIMIT" ? "Token" : window.type === "TIME_LIMIT" ? "时段" : "额度");
      if (window.remainingPercent != null) parts.push(`${name}剩余 ${Number(window.remainingPercent).toFixed(0)}%`);
    }
  }
  if (item.credits != null) parts.push(`Credits ${Number(item.credits).toFixed(2)}`);
  if (item.plan) parts.push(String(item.plan));
  if (!parts.length) parts.push(`当前模型：${model || "未知"}`);
  return parts.join(" · ");
}

function gridLines(w, h, pad, n = 3) {
  let out = "";
  for (let g = 0; g < n; g++) {
    const y = pad + g * ((h - pad * 2) / (n - 1));
    out += `<line x1="${pad}" y1="${y.toFixed(1)}" x2="${w - pad}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="0.5" opacity="0.55"/>`;
  }
  return out;
}

// y 轴刻度：左侧留 axisW 宽放数字，画 n 条刻度线 + 文字
function yAxis(values, opts) {
  const { h, axisW, plotL, plotR, topPad = 8, botPad = 8, yMax, format, n = 3 } = opts;
  const rawMax = values.length ? Math.max(...values) : 1;
  const max = yMax || (rawMax <= 0 ? 1 : rawMax * 1.08);
  let out = "";
  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 1 : i / (n - 1);
    const y = h - botPad - frac * (h - botPad - topPad);
    const val = max * frac;
    out += `<line x1="${plotL}" y1="${y.toFixed(1)}" x2="${plotR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="0.5" opacity="0.45"/>`;
    out += `<text x="${axisW - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" font-weight="500" font-family="var(--font-ui)" fill="var(--text-light)">${esc(format ? format(val) : Math.round(val))}</text>`;
  }
  return out;
}

// x 轴首尾标签
function xAxisEnds(n, opts) {
  const { h, plotL, plotR, pad, label } = opts;
  const y = h - 4;
  return `<text x="${plotL}" y="${y}" font-size="12" font-weight="500" font-family="var(--font-ui)" fill="var(--text-light)">1</text>` +
    `<text x="${plotR}" y="${y}" text-anchor="end" font-size="12" font-weight="500" font-family="var(--font-ui)" fill="var(--text-light)">${esc(label || n)}</text>`;
}

function lineChart(values, opts = {}) {
  const plotH = opts.h || 170;
  const xPad = 16; // 底部 x 轴标签区
  const w = opts.w || 640, h = plotH + xPad;
  const axisW = opts.axisW ?? 44, pad = 8;
  const plotL = axisW + pad, plotR = w - pad;
  const topPad = 34, botPad = 8; // 顶部留白：保证 100% 刻度与峰值标注不被裁
  const top = topPad, bottom = plotH - botPad;
  const stroke = opts.stroke || "var(--accent)";
  const fill = opts.fill || "rgba(83,125,150,0.10)";
  const format = opts.format;
  const fmtTip = opts.tipFormat || format || ((v) => String(Math.round(v)));
  const n = values.length;
  if (n < 2) return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg"><text x="${w/2}" y="${h/2}" text-anchor="middle" font-size="12" fill="var(--text-muted)">数据不足</text></svg>`;
  const rawMax = Math.max(...values);
  const max = opts.yMax || (rawMax <= 0 ? 1 : rawMax * 1.08);
  const step = (plotR - plotL) / (n - 1);
  const Y = (v) => bottom - (v / max) * (bottom - top);
  const pts = values.map((v, i) => [plotL + i * step, Y(v)]);
  const path = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join("");
  const area = path + ` L${(plotL + (n - 1) * step).toFixed(1)},${bottom} L${plotL},${bottom} Z`;
  const last = pts[pts.length - 1];
  const lastLabel = format ? esc(format(values[values.length - 1])) : "";
  const lx = Math.max(axisW + 24, Math.min(last[0], plotR - 24));
  let dots = "";
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    dots += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="var(--bg-card)" stroke="${stroke}" stroke-width="1" opacity="0"><title>第 ${i + 1} 轮：${esc(fmtTip(values[i]))}</title></circle>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg">
  ${yAxis(values, { h: plotH, axisW, plotL, plotR, topPad, botPad, yMax: opts.yMax, format, n: opts.ticks || 3 })}
  <path class="si-area" d="${area}" fill="${fill}" stroke="none"/>
  <path class="si-line" d="${path}" pathLength="1" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  ${lastLabel ? `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5" fill="${stroke}"/><text x="${lx.toFixed(1)}" y="${Math.max(14, last[1] - 10).toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="500" font-family="var(--font-ui)" fill="var(--text)">${lastLabel}</text>` : ""}
  ${xAxisEnds(n, { h, plotL, plotR, pad, label: opts.xLabel || (n + " 轮") })}
  </svg>`;
}

function barChart(values, opts = {}) {
  const plotH = opts.h || 170;
  const xPad = 16;
  const w = opts.w || 640, h = plotH + xPad;
  const axisW = opts.axisW ?? 44, pad = 8;
  const plotL = axisW + pad, plotR = w - pad;
  const topPad = 34, botPad = 8; // 顶部留白：保证峰值刻度/标注不被裁
  const top = topPad, bottom = plotH - botPad;
  const fill = opts.fill || "rgba(83,125,150,0.55)";
  const format = opts.format;
  const fmtTip = opts.tipFormat || format || ((v) => String(Math.round(v)));
  const n = values.length;
  if (n === 0) return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg"><text x="${w/2}" y="${h/2}" text-anchor="middle" font-size="12" fill="var(--text-muted)">暂无数据</text></svg>`;
  const rawMax = Math.max(...values);
  const max = opts.yMax || (rawMax <= 0 ? 1 : rawMax * 1.08);
  const slot = (plotR - plotL) / n;
  const bw = Math.max(2, Math.min(12, slot * 0.62));
  let bars = "";
  let maxIdx = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v > values[maxIdx]) maxIdx = i;
    const bh = Math.max(v <= 0 ? 0.5 : (v / max) * (bottom - top), 0.5);
    const x = plotL + i * slot + (slot - bw) / 2;
    const y = bottom - bh;
    bars += `<rect class="si-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${fill}"><title>第 ${i + 1} 轮：${esc(fmtTip(v))}</title></rect>`;
  }
  const mx = plotL + maxIdx * slot + slot / 2;
  const my = bottom - (values[maxIdx] / max) * (bottom - top);
  const maxLabel = format ? esc(format(values[maxIdx])) : "";
  // 标注文字中心限制在绘图区内，避免最右柱标注被 svg 裁切
  const labelX = Math.max(axisW + 24, Math.min(mx, plotR - 24));
  return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg">
  ${yAxis(values, { h: plotH, axisW, plotL, plotR, topPad, botPad, yMax: opts.yMax, format, n: opts.ticks || 3 })}
  ${bars}
  ${maxLabel ? `<text x="${labelX.toFixed(1)}" y="${(my - 4).toFixed(1)}" text-anchor="middle" font-size="12.5" font-weight="500" font-family="var(--font-ui)" fill="var(--accent)">${maxLabel}</text>` : ""}
  ${xAxisEnds(n, { h, plotL, plotR, pad, label: opts.xLabel || (n + " 轮") })}
  </svg>`;
}

function stackedBars(rows, opts = {}) {
  // rows: [{a, b, c}] → 堆积柱
  const plotH = opts.h || 170;
  const xPad = 16;
  const w = opts.w || 640, h = plotH + xPad;
  const axisW = opts.axisW ?? 44, pad = 8;
  const plotL = axisW + pad, plotR = w - pad;
  const top = pad, bottom = plotH - pad;
  const colors = opts.colors || ["rgba(83,125,150,0.75)", "rgba(83,125,150,0.35)", "rgba(143,134,123,0.45)"];
  const keys = opts.keys || ["a", "b", "c"];
  const keyLabels = opts.keyLabels || keys;
  const format = opts.format;
  const fmtTip = opts.tipFormat || format || ((v) => String(Math.round(v)));
  const n = rows.length;
  if (n === 0) return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg"><text x="${w/2}" y="${h/2}" text-anchor="middle" font-size="12" fill="var(--text-muted)">暂无数据</text></svg>`;
  const sums = rows.map((r) => keys.reduce((s, k) => s + (r[k] || 0), 0));
  const max = opts.yMax || (Math.max(...sums) * 1.08) || 1;
  const slot = (plotR - plotL) / n;
  const bw = Math.max(2, Math.min(12, slot * 0.62));
  let bars = "";
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    let yBottom = bottom;
    for (let k = 0; k < keys.length; k++) {
      const v = r[keys[k]] || 0;
      if (v <= 0) continue;
      const bh = (v / max) * (bottom - top);
      const y = yBottom - bh;
      const x = plotL + i * slot + (slot - bw) / 2;
      bars += `<rect class="si-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${colors[k % colors.length]}"><title>第 ${i + 1} 轮 · ${esc(keyLabels[k % keyLabels.length])}：${esc(fmtTip(v))}</title></rect>`;
      yBottom = y;
    }
  }
  return `<svg viewBox="0 0 ${w} ${h}" role="img" xmlns="http://www.w3.org/2000/svg">
  ${yAxis(sums, { h: plotH, axisW, plotL, plotR, pad, yMax: opts.yMax, format, n: opts.ticks || 3 })}
  ${bars}
  ${xAxisEnds(n, { h, plotL, plotR, pad, label: opts.xLabel || (n + " 轮") })}
  </svg>`;
}

/* ── 格式化 ─────────────────────────────────────── */

function fmtTokens(n) {
  if (n == null) return "–";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function fmtCny(n, digits = 4) {
  if (n == null || Number.isNaN(n)) return "–";
  return "¥" + Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "–";
  return n.toFixed(2) + "%";
}

function fmtCostVal(v) {
  if (v == null || Number.isNaN(v)) return "–";
  if (v === 0) return "0";
  if (v >= 0.01) return v.toFixed(2);
  if (v >= 0.001) return v.toFixed(3);
  return v.toFixed(4);
}

// 数字滚动：按类型格式化
function fmtDuration(min) {
  if (min == null || min < 0) return "–";
  if (min < 60) return min + " 分";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? h + " 时 " + m + " 分" : h + " 小时";
}

function fmtByKind(v, kind) {
  if (kind === "tokens") return fmtTokens(v);
  if (kind === "pct") return v.toFixed(2) + "%";
  if (kind === "cny") return fmtCny(v);
  if (kind === "dur") return fmtDuration(v);
  return String(Math.round(v));
}

// 转轮数字：每位数字独立滚轮滚动（0 → 目标位）
function renderOdometer(el, to, kind) {
  const str = fmtByKind(to, kind);
  const digits = [];
  const frag = document.createDocumentFragment();
  for (const ch of str) {
    if (/[0-9]/.test(ch)) {
      const od = document.createElement("span");
      od.className = "od";
      // 内联关键样式兜底：不依赖 CSS 文件是否加载，确保窗口裁剪
      od.style.display = "inline-block";
      od.style.overflow = "hidden";
      od.style.width = "0.62em";
      od.style.height = "1em";
      od.style.lineHeight = "1em";
      od.style.textAlign = "center";
      od.style.verticalAlign = "-0.06em";
      const strip = document.createElement("span");
      strip.className = "od-strip";
      strip.style.display = "flex";
      strip.style.flexDirection = "column";
      strip.style.willChange = "transform";
      const seq = "0123456789".repeat(3) + "0";
      for (const dc of seq) {
        const d = document.createElement("span");
        d.className = "od-d";
        d.style.display = "block";
        d.style.height = "1em";
        d.style.lineHeight = "1em";
        d.style.textAlign = "center";
        d.textContent = dc;
        strip.appendChild(d);
      }
      od.appendChild(strip);
      digits.push({ strip, d: parseInt(ch, 10) });
      frag.appendChild(od);
    } else {
      frag.appendChild(document.createTextNode(ch));
    }
  }
  el.textContent = "";
  el.appendChild(frag);
  // JS 逐帧驱动滚轮：0 → 目标位；页面后台/暂停恢复后直接算到最终值，不残留中间态
  const dur = 900;
  digits.forEach(({ strip, d }) => {
    strip.style.willChange = "transform"; // 动画期间临时提升合成层
    const start = performance.now();
    function frame(now) {
      const p = Math.min(1, (now - start) / dur);
      const ease = 1 - Math.pow(1 - p, 3);
      strip.style.transform = `translateY(${(-d * ease).toFixed(4)}em)`;
      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        strip.style.transform = `translateY(${-d}em)`; // 强制落定
        strip.style.willChange = ""; // 释放合成层，降低长期开销
      }
    }
    requestAnimationFrame(frame);
  });
}

// 容器内数字转轮滚动（无结尾放大）
function animateNumbers(rootEl) {
  if (!rootEl) return;
  const els = rootEl.querySelectorAll(".cnt");
  els.forEach((el) => {
    const to = parseFloat(el.dataset.to || "0") || 0;
    const kind = el.dataset.kind || "int";
    renderOdometer(el, to, kind);
  });
}

// 实心扇形图：segments [{v, color}]，从 12 点方向顺时针
function pieChart(segments, opts = {}) {
  const size = opts.size || 110;
  const cx = size / 2, cy = size / 2;
  const r = opts.r || size / 2 - 4;
  const total = segments.reduce((s, x) => s + (x.v || 0), 0) || 1;
  if (segments.length === 1) {
    return `<svg viewBox="0 0 ${size} ${size}" role="img" xmlns="http://www.w3.org/2000/svg"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${segments[0].color}"/></svg>`;
  }
  let ang = -90;
  let idx = 0;
  let paths = "";
  for (const seg of segments) {
    if (!seg.v || seg.v <= 0) continue;
    const frac = seg.v / total;
    const a1 = ang, a2 = ang + frac * 360;
    const rad = (a) => (a * Math.PI) / 180;
    const x1 = cx + r * Math.cos(rad(a1));
    const y1 = cy + r * Math.sin(rad(a1));
    const x2 = cx + r * Math.cos(rad(a2));
    const y2 = cy + r * Math.sin(rad(a2));
    const large = frac > 0.5 ? 1 : 0;
    paths += `<path class="si-sect-path" pathLength="1" style="animation-delay:${(idx * 0.12).toFixed(2)}s" d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${seg.color}" stroke="var(--bg-card)" stroke-width="1"/>`;
    ang = a2;
    idx++;
  }
  return `<svg viewBox="0 0 ${size} ${size}" role="img" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}

// 环形图：segments [{v, color}]，中心可放文字
function donutChart(segments, opts = {}) {
  const size = opts.size || 150;
  const r = opts.r || 54;
  const sw = opts.sw || 16;
  const cx = size / 2, cy = size / 2;
  const center = opts.center || "";
  const sub = opts.sub || "";
  const total = segments.reduce((s, x) => s + (x.v || 0), 0) || 1;
  const C = 2 * Math.PI * r;
  let offset = 0;
  let idx = 0;
  let arcs = "";
  for (const seg of segments) {
    if (!seg.v || seg.v <= 0) continue;
    const len = (seg.v / total) * C;
    // 初始 dashoffset = 目标 + 一整圈（隐藏），动画扫出 len 段
    arcs += `<circle class="si-sect" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset + C).toFixed(2)}" style="--si-sweep-to:${(-offset).toFixed(2)};animation-delay:${(idx * 0.12).toFixed(2)}s"/>`;
    offset += len;
    idx++;
  }
  return `<svg viewBox="0 0 ${size} ${size}" role="img" xmlns="http://www.w3.org/2000/svg" style="transform:rotate(-90deg)">
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="color-mix(in srgb, var(--text, #3b3d3f) 7%, transparent)" stroke-width="${sw}"/>
  ${arcs}
  </svg>` +
  `<div class="ua-donut-center"><span class="udc-v">${center}</span>${sub ? `<span class="udc-s">${sub}</span>` : ""}</div>`;
}

/* ── 数据获取 ───────────────────────────────────── */

async function fetchJson(path) {
  const res = await hana.api.fetch(path, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/* 纯插件主题同步：通过插件后端读取 user/preferences.json，不依赖宿主 renderer。 */
function initAppearancePolling() {
  let busy = false;
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const sync = async () => {
    if (busy) return;
    busy = true;
    try {
      const appearance = await fetchJson("/api/appearance");
      const configured = String(appearance?.theme || "").trim();
      if (!configured) return;
      const resolved = configured === "auto"
        ? (media?.matches ? "midnight" : "warm-paper")
        : configured;
      applyHostTheme(resolved);
    } catch {
      // 旧版宿主或文件不可读时，继续使用 URL / postMessage / parent 兜底。
    } finally {
      busy = false;
    }
  };
  sync();
  const timer = window.setInterval(sync, 500);
  const onSystemTheme = () => sync();
  media?.addEventListener?.("change", onSystemTheme);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(timer);
    media?.removeEventListener?.("change", onSystemTheme);
  }, { once: true });
}

initAppearancePolling();

function showUpdateNotice(title, message, buttonLabel = "知道了") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "si-update-overlay";
    overlay.innerHTML = `
      <div class="si-update-dialog" role="dialog" aria-modal="true" aria-labelledby="siUpdateTitle">
        <div class="si-update-mark">↻</div>
        <h3 id="siUpdateTitle">${esc(title)}</h3>
        <p>${esc(message)}</p>
        <button type="button" class="ghost si-update-confirm">${esc(buttonLabel)}</button>
      </div>`;
    const close = () => {
      overlay.classList.add("closing");
      window.setTimeout(() => overlay.remove(), 180);
      resolve();
    };
    overlay.querySelector(".si-update-confirm")?.addEventListener("click", close, { once: true });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));
    overlay.querySelector("button")?.focus();
  });
}

const getStats = (file) => fetchJson("/api/stats" + (file ? `?file=${encodeURIComponent(file)}` : ""));
const getBalance = () => fetchJson("/api/balance");
const getSessions = () => fetchJson("/api/sessions");
const getTotalCost = () => fetchJson("/api/total-cost");
const getLedgerStats = () => fetchJson("/api/ledger-stats");

/* ── widget 状态条 ──────────────────────────────── */

async function renderWidget() {
  if (!root) return;
  root.innerHTML = `
    <div class="panel widget-panel">
      <section class="widget-card">
        <header class="w-head">
          <div class="w-identity">
            <span class="dot" id="dot"></span>
            <div class="w-id-copy">
              <div class="w-title" id="barTitle">正在读取当前会话</div>
              <div class="model" id="model">加载中…</div>
            </div>
          </div>
          <span class="w-turns" id="wTurns">– 轮</span>
        </header>

        <div class="w-overview">
          <div class="w-ring" id="wRing">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle class="w-ring-track" cx="50" cy="50" r="42"></circle>
              <circle class="w-ring-progress" id="wRingProgress" cx="50" cy="50" r="42" pathLength="100"></circle>
            </svg>
            <div class="w-ring-core">
              <strong id="wContextPct">0%</strong>
              <span>上下文</span>
            </div>
          </div>
          <div class="w-money">
            <div class="w-money-row"><span>会话 tokens</span><b id="wOverviewTokens">–</b></div>
            <div class="w-money-row"><span>会话费用</span><b class="bal" id="wCost">–</b></div>
          </div>
        </div>

        <div class="w-context">
          <div class="w-section-head"><span>上下文窗口</span><b id="wContextText">– / –</b></div>
          <div class="w-context-track"><i id="wContextFill"></i><em id="wContextThreshold"></em></div>
          <div class="w-context-note" id="wContextNote">压缩阈值 80%</div>
        </div>

        <div class="w-grid" id="metrics">
          <div class="w-metric"><span>本次命中</span><b id="wHit">–</b></div>
          <div class="w-metric"><span>平均命中</span><b id="wAvgHit">–</b></div>
          <div class="w-metric"><span>会话 tokens</span><b id="wTokens">–</b></div>
          <div class="w-metric"><span>运行时长</span><b id="wDuration">–</b></div>
        </div>

        <div class="w-composition">
          <div class="w-section-head"><span>用量结构</span><b id="wCompTotal">–</b></div>
          <div class="w-comp-track" id="wCompTrack"><i class="cache"></i><i class="input"></i><i class="output"></i></div>
          <div class="w-legend"><span><i class="cache"></i>缓存命中</span><span><i class="input"></i>未命中</span><span><i class="output"></i>输出</span></div>
        </div>

        <div class="w-providers">
          <div class="w-section-head"><span>本会话供应商</span><b id="wProviderCount">0 家</b></div>
          <div class="w-provider-list" id="wProviderList"></div>
        </div>
        <div class="w-error" id="meta"></div>
      </section>
    </div>`;

  const dot = document.getElementById("dot");
  const modelEl = document.getElementById("model");
  const titleEl = document.getElementById("barTitle");
  const metaEl = document.getElementById("meta");
  const ringProgressEl = document.getElementById("wRingProgress");
  const contextPctEl = document.getElementById("wContextPct");
  const contextTextEl = document.getElementById("wContextText");
  const contextFillEl = document.getElementById("wContextFill");
  const contextThresholdEl = document.getElementById("wContextThreshold");
  const contextNoteEl = document.getElementById("wContextNote");
  const turnsEl = document.getElementById("wTurns");
  const costEl = document.getElementById("wCost");
  const overviewTokensEl = document.getElementById("wOverviewTokens");
  const providerCountEl = document.getElementById("wProviderCount");
  const providerListEl = document.getElementById("wProviderList");
  const hitEl = document.getElementById("wHit");
  const avgHitEl = document.getElementById("wAvgHit");
  const tokensEl = document.getElementById("wTokens");
  const durationEl = document.getElementById("wDuration");
  const compTotalEl = document.getElementById("wCompTotal");
  const compTrackEl = document.getElementById("wCompTrack");

  let activeSessionFile = null;
  let refreshSeq = 0;

  function sessionFileFromPath(sessionPath) {
    if (typeof sessionPath !== "string" || !sessionPath.trim()) return null;
    const name = sessionPath.trim().replace(/\\/g, "/").split("/").pop();
    return name && name.endsWith(".jsonl") ? name : null;
  }

  async function tick() {
    const thisRefresh = ++refreshSeq;
    try {
      const requestedFile = activeSessionFile;
      const stats = await getStats(requestedFile);
      const balance = await getBalance().catch(() => null);
      if (thisRefresh !== refreshSeq || requestedFile !== activeSessionFile) return;
      if (!stats || stats.error) throw new Error(stats?.error || "no data");

      dot.className = "dot";
      modelEl.textContent = stats.model || "unknown";
      if (stats.models && stats.models.length > 1) {
        modelEl.textContent = (stats.model || "unknown") + " ×" + stats.models.length;
        modelEl.title = "会话内模型分布：\n" + stats.models.map((x) => `  ${x.model}：${x.turns} 轮`).join("\n");
      } else {
        modelEl.title = "";
      }
      titleEl.textContent = stats.title ? stats.title : "当前会话";
      titleEl.title = stats.title || "";

      const balances = balance?.balances || [];
      const unsupported = balance?.unsupported || [];
      const pct = Math.max(0, Math.min(100, Number(stats.contextPercent) || 0));
      const threshold = Math.round((stats.compactThreshold ?? 0.8) * 100);
      const remain = Math.max(0, Number(stats.remainingToCompact) || 0);
      ringProgressEl.style.strokeDasharray = `${pct} ${100 - pct}`;
      contextPctEl.textContent = fmtPct(pct);
      contextTextEl.textContent = `${fmtTokens(stats.lastWindowTokens || 0)} / ${fmtTokens(stats.contextWindow || 0)}`;
      contextFillEl.style.width = pct + "%";
      contextThresholdEl.style.left = threshold + "%";
      contextNoteEl.textContent = `距压缩约 ${fmtTokens(remain)} · 阈值 ${threshold}%`;

      turnsEl.textContent = `${stats.turns || 0} 轮`;
      overviewTokensEl.textContent = fmtTokens(stats.sessionTokens);

      const providerNames = { deepseek: "DeepSeek", moonshot: "Moonshot", mimo: "MiMo", zhipu: "智谱", agnes: "Agnes", openai: "OpenAI", gemini: "Gemini", "openai-codex": "ChatGPT Plus / Pro", "xai-oauth": "xAI Grok" };
      const usedProviders = Array.isArray(stats.providers) && stats.providers.length
        ? stats.providers
        : [{ provider: stats.provider || "unknown", turns: stats.turns || 0, tokens: stats.sessionTokens || 0, cost: stats.sessionCostCny, costComplete: stats.sessionCostCny != null }];
      const hasUnpricedProvider = usedProviders.some((p) => p.cost == null || p.costComplete === false);
      costEl.textContent = fmtCny(stats.sessionCostCny) + (hasUnpricedProvider ? "+" : "");
      costEl.title = hasUnpricedProvider ? "仅包含已有定价的供应商费用；订阅制或未定价供应商未计入" : "";
      providerCountEl.textContent = `${usedProviders.length} 家`;
      const usedProviderTokens = usedProviders.reduce((sum, p) => sum + (Number(p.tokens) || 0), 0) || 1;
      providerListEl.innerHTML = usedProviders
        .sort((a, b) => (b.tokens || 0) - (a.tokens || 0))
        .map((p) => {
          const bal = balances.find((b) => b.provider === p.provider && b.status === "ok");
          const uns = unsupported.find((u) => u.provider === p.provider);
          const oauth = p.provider === "openai-codex" || p.provider === "xai-oauth";
          const costText = p.cost == null ? (oauth ? "订阅制" : "未定价") : `${fmtCny(p.cost)}${p.costComplete === false ? "+" : ""}`;
          const balanceText = bal ? providerStatusSummary(bal) : (oauth ? "订阅账户" : (uns ? "不可查询" : "–"));
          const balanceLabel = bal?.label || "账户";
          const share = Math.max(0, Math.min(100, ((Number(p.tokens) || 0) / usedProviderTokens) * 100));
          return `<div class="w-provider-row" title="${esc((p.models || []).map((m) => `${m.model}：${m.turns} 轮`).join("\n"))}">` +
            `<div class="w-provider-share"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="w-share-track" cx="50" cy="50" r="42"></circle><circle class="w-share-progress" cx="50" cy="50" r="42" pathLength="100" style="stroke-dasharray:${share.toFixed(2)} ${(100 - share).toFixed(2)}"></circle></svg><span>${share >= 10 ? share.toFixed(0) : share.toFixed(1)}%</span></div>` +
            `<div class="w-provider-name"><strong>${esc(providerNames[p.provider] || p.provider)}</strong><span>${p.turns || 0} 轮</span></div>` +
            `<div class="w-provider-values">` +
              `<div class="w-provider-stat"><span>tokens</span><b>${fmtTokens(p.tokens || 0)}</b></div>` +
              `<div class="w-provider-stat"><span>费用</span><b>${costText}</b></div>` +
              `<div class="w-provider-stat balance"><span>${esc(balanceLabel)}</span><b>${esc(balanceText)}</b></div>` +
            `</div>` +
            `</div>`;
        }).join("");

      hitEl.textContent = fmtPct(stats.lastHitPercent);
      avgHitEl.textContent = fmtPct(stats.avgHitPercent);
      tokensEl.textContent = fmtTokens(stats.sessionTokens);
      durationEl.textContent = fmtDuration(stats.durationMinutes);

      const cache = Math.max(0, Number(stats.sumCacheRead) || 0);
      const input = Math.max(0, Number(stats.sumInput) || 0);
      const output = Math.max(0, (Number(stats.sumOutput) || 0) + (Number(stats.sumReasoning) || 0));
      const total = cache + input + output || 1;
      compTotalEl.textContent = fmtTokens(cache + input + output);
      compTrackEl.querySelector(".cache").style.width = (cache / total) * 100 + "%";
      compTrackEl.querySelector(".input").style.width = (input / total) * 100 + "%";
      compTrackEl.querySelector(".output").style.width = (output / total) * 100 + "%";
      metaEl.textContent = "";
      requestAnimationFrame(() => hana.ui.resize({ height: Math.ceil(root.scrollHeight + 8) }));

      dot.classList.remove("pulse");
      void dot.offsetWidth;
      dot.classList.add("pulse");
    } catch (e) {
      dot.className = "dot err";
      modelEl.textContent = "数据不可用";
      titleEl.textContent = "无法读取当前会话";
      metaEl.innerHTML = `<span class="err-text">${esc(e.message || e)}</span>`;
    }
  }

  function onHostContext(evt) {
    if (evt.source !== window.parent) return;
    const origin = targetOrigin();
    if (origin !== "*" && evt.origin !== origin) return;
    const msg = evt.data || {};
    if (msg.type !== "hana.host.context") return;
    const nextFile = sessionFileFromPath(msg.payload?.sessionPath);
    if (!nextFile || nextFile === activeSessionFile) return;
    activeSessionFile = nextFile;
    tick();
  }

  window.addEventListener("message", onHostContext);
  await tick();
  setInterval(tick, 30000);
}

/* ── page 可视化 ────────────────────────────────── */

async function renderPage() {
  if (!root) return;
  root.innerHTML = `
    <div class="panel">
    <div class="head">
      <h1>会话用量</h1>
      <span class="badge" id="modelBadge">–</span>
      <div class="sel" id="selRoot">
        <button type="button" class="sel-btn" id="selBtn"><span class="sel-tx" id="selText">加载中…</span><span class="sel-arrow">▾</span></button>
        <div class="sel-pop" id="selPop"></div>
      </div>
      <button class="ghost" id="refreshBtn" type="button"><span class="btn-ic" id="btnIc">↻</span><span class="btn-tx" id="btnTx">刷新</span></button>
      <button class="ghost update-check-btn" id="updateCheckBtn" type="button" title="检查 Session Insight 更新"><span class="btn-ic" id="updateCheckIc">⇧</span><span class="btn-tx" id="updateCheckTx">检查更新</span></button>
      <button class="ghost github-btn" id="githubBtn" type="button" title="打开 GitHub 仓库主页"><svg class="btn-ic gh-ic" viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg><span class="btn-tx">GitHub</span></button>
      <span class="spacer"></span>
      <span class="badge ok" id="balBadge">总消费 –</span>
    </div>
    <div class="top-row">
      <div class="balance-block" id="balanceBlock"></div>
    </div>
    <div class="hero-metrics" id="heroMetrics"></div>
    <div class="chart-card glass" id="ctxCard"></div>
    <div class="chart-card glass" id="usageCard"></div>
    <div class="chart-grid si-anim">
      <div class="chart-card glass" data-chart="tokens"><h3>每轮 tokens <span class="cc-zoom" title="放大查看">⤢</span></h3><div id="chTokens">加载中…</div></div>
      <div class="chart-card glass" data-chart="hit"><h3>缓存命中率趋势 <span class="cc-zoom" title="放大查看">⤢</span></h3><div id="chHit">加载中…</div></div>
      <div class="chart-card glass" data-chart="cost"><h3>每轮费用（元） <span class="cc-zoom" title="放大查看">⤢</span></h3><div id="chCost">加载中…</div></div>
      <div class="chart-card glass" data-chart="stack"><h3>输入构成：未命中 / 缓存命中 / 输出 <span class="cc-zoom" title="放大查看">⤢</span></h3><div id="chStack">加载中…</div></div>
    </div>
    <div class="chart-card glass" id="ledgerCard"></div>
    <div class="foot" id="foot"></div>
    </div>
  `;

  const modelBadge = document.getElementById("modelBadge");
  const balBadge = document.getElementById("balBadge");
  const selRoot = document.getElementById("selRoot");
  const selBtn = document.getElementById("selBtn");
  const selPop = document.getElementById("selPop");
  const selText = document.getElementById("selText");
  const refreshBtn = document.getElementById("refreshBtn");
  const updateCheckBtn = document.getElementById("updateCheckBtn");
  const githubBtn = document.getElementById("githubBtn");
  const foot = document.getElementById("foot");
  let acctOpen = true; // 其他账户菜单默认展开
  let bbOpen = false; // 主余额供应商切换下拉
  let lastBalance = null;
  let viewProvider = sessionStorage.getItem("si-hot-view-provider") || null; // 热更新后恢复供应商视图
  let selectedFile = sessionStorage.getItem("si-hot-selected-file") || null; // 热更新后恢复会话
  let lastStats = null; // 最近一次统计（图表放大用）
  let lastLedger = null; // 全局用量总览数据（放大详情用）

  // 宿主会话切换事件：必须在首个 await 之前同步注册，否则宿主 ready 消息早于监听器而丢失
  function sessionFileFromPath(sessionPath) {
    if (typeof sessionPath !== "string" || !sessionPath.trim()) return null;
    const name = sessionPath.trim().replace(/\\/g, "/").split("/").pop();
    return name && name.endsWith(".jsonl") ? name : null;
  }
  function onHostContext(evt) {
    if (evt.source !== window.parent) return;
    const origin = targetOrigin();
    if (origin !== "*" && evt.origin !== origin) return;
    const msg = evt.data || {};
    if (msg.type !== "hana.host.context") return;
    const file = sessionFileFromPath(msg.payload?.sessionPath);
    if (!file || file === selectedFile) return;
    selectedFile = file;
    setSelected(file);
    loadData(file);
  }
  window.addEventListener("message", onHostContext);

  const PROVIDER_CN = { deepseek: "DeepSeek", moonshot: "Moonshot", mimo: "MiMo", zhipu: "智谱", agnes: "Agnes", openai: "OpenAI", gemini: "Gemini", "openai-codex": "ChatGPT Plus / Pro", "xai-oauth": "xAI Grok", xai: "xAI API" };
  // 供应商列表：默认兜底，打开插件时从 HanaAgent 的 models.json 动态同步（含 API Key 与 OAuth）
  let providerOrder = ["deepseek", "moonshot", "mimo", "zhipu", "agnes", "openai", "gemini"];
  function cycleProvider() {
    const cur = viewProvider || (lastStats && lastStats.provider) || "deepseek";
    const idx = providerOrder.indexOf(cur);
    const next = providerOrder[(idx + 1) % providerOrder.length];
    selectProvider(next);
  }
  let lastBgProvider = null; // 记录上一个背景供应商，切换时才播放面板过渡
  let siSwitchTimer = null; // 切换动效播完后的清理计时器
  function setProviderBg(provider) {
    const changed = provider !== lastBgProvider;
    lastBgProvider = provider;
    providerOrder.forEach((p) => document.body.classList.remove("si-bg-" + p));
    if (provider) document.body.classList.add("si-bg-" + provider);
    // 供应商切换动效：仅供应商真正变化时播放，刷新不触发（避免页面下沉）
    if (changed) {
      const p = root.querySelector(".panel");
      if (p) {
        p.classList.remove("si-switch");
        void p.offsetWidth;
        p.classList.add("si-switch");
        // 动效播完（最长 0.47s delay + 0.5s = ~1s）后移除，避免动画常驻导致
        // 余额面板每次重渲染都重新淡入（下拉菜单变透明不可点）
        clearTimeout(siSwitchTimer);
        siSwitchTimer = setTimeout(() => p.classList.remove("si-switch"), 1100);
      }
    }
  }

  // 打开插件时同步 HanaAgent 供应商配置：新增/改动/删减自动适配（重渲染余额块/账户菜单/徽章/背景）
  async function syncProviders() {
    try {
      const res = await fetchJson("/api/providers");
      const list = res && Array.isArray(res.providers) ? res.providers.map((p) => p && p.id).filter(Boolean) : [];
      if (!list.length) return;
      providerOrder = list;
      // 后端同时返回每家已加载模型，动态补全模型→供应商归属（支持 OAuth 与后续新增供应商）
      for (const p of res.providers) {
        for (const model of p.models || []) MODEL_PROVIDER[model] = p.id;
      }
      if (lastBalance) {
        const cur = viewProvider || (lastStats && lastStats.provider);
        renderBalanceBlock(lastBalance, cur, lastStats && lastStats.model);
        renderAcctMenu(lastBalance, cur);
        setProviderBg(cur);
        const badge = document.getElementById("modelBadge");
        if (badge && lastStats && lastStats.model) badge.textContent = (PROVIDER_CN[cur] || cur || "") + " · " + lastStats.model;
      }
    } catch (e) {}
  }

  function fmtNum(n) {
    return Number(n).toFixed(2).replace(/\.?0+$/, "");
  }



  // 全局用量总览：agent 消耗饼图 / 每日费用趋势 / 延迟分布 / 模型对比
  function renderLedger(ls) {
    const el = document.getElementById("ledgerCard");
    if (!el) return;
    if (!ls || ls.empty || !ls.calls) {
      el.innerHTML = `<h3>全局用量总览</h3><div class="empty">暂无全局数据</div>`;
      return;
    }
    const AGENT_COLORS = {
      "session:hanako": "rgba(83,125,150,0.8)",
      "automation:ming": "rgba(157,95,77,0.75)",
      "automation:hanako": "rgba(27,54,93,0.75)",
      "automation:butter": "rgba(74,107,74,0.8)",
      "session:ming": "rgba(143,134,123,0.7)",
      "memory:hanako": "rgba(83,125,150,0.5)",
      "session:butter": "rgba(167,139,250,0.7)",
      "utility:hanako": "rgba(157,95,77,0.5)",
    };
    const agents = Object.entries(ls.agents || {}).sort((a, b) => b[1].cost - a[1].cost).slice(0, 6);
    const agentSegs = agents.map(([k, v]) => ({ v: v.cost, color: AGENT_COLORS[k] || "rgba(143,134,123,0.6)" }));
    const agentLegend = agents
      .map(([k, v]) => `<span><i class="fb-dot" style="background:${AGENT_COLORS[k] || "rgba(143,134,123,0.6)"}"></i>${esc(k.replace(":", "·"))} ${fmtCny(v.cost)} · ${v.calls} 次</span>`)
      .join("");
    const days = Object.keys(ls.days || {});
    const dayCost = days.map((d) => ls.days[d].cost);
    const dayToks = days.map((d) => ls.days[d].tokens);
    const dayLabel = days.length > 0 ? days[0].slice(5) + "~" + days[days.length - 1].slice(5) + " · " + days.length + " 天" : "";
    const lb = (ls.latency && ls.latency.buckets) || {};
    const latVals = [lb.lt1 || 0, lb["1_3"] || 0, lb["3_10"] || 0, lb.gt10 || 0];
    const models = Object.entries(ls.models || {}).sort((a, b) => b[1].cost - a[1].cost);
    const modelVals = models.map(([, v]) => v.cost);
    const modelLegend = models
      .map(([m, v], i) => `<span><i class="fb-dot" style="background:${["rgba(83,125,150,0.75)", "rgba(157,95,77,0.7)", "rgba(74,107,74,0.8)", "rgba(167,139,250,0.7)"][i % 4]}"></i>${esc(m)} ${fmtCny(v.cost)} · ${v.calls} 次</span>`)
      .join("");
    const lat = ls.latency || {};
    el.innerHTML =
      `<h3>全局用量总览 <span class="lg-sub">${ls.calls} 次调用 · 错误 ${ls.errors} · 平均延迟 ${lat.avg ? (lat.avg / 1000).toFixed(1) + "s" : "–"}</span></h3>` +
      `<div class="lg-grid">` +
      `<div class="lg-cell" data-lg="agent" title="点击放大查看"><div class="lg-t">Agent 消耗</div>` +
      `<div class="ua-donut-wrap">` +
      `<div class="ua-donut">${pieChart(agentSegs, { size: 110 })}</div>` +
      `<div class="ua-lg">${agentLegend}</div>` +
      `</div></div>` +
      `<div class="lg-cell" data-lg="day" title="点击放大查看"><div class="lg-t">每日费用趋势</div>` +
      `<div class="lg-chart">${lineChart(dayCost, { h: 130, stroke: "var(--accent)", fill: "rgba(83,125,150,0.10)", format: fmtCostVal, xLabel: dayLabel })}</div>` +
      `<div class="lg-note">日 tokens：${fmtTokens(dayToks.reduce((a, b) => a + b, 0))}</div>` +
      `</div>` +
      `<div class="lg-cell" data-lg="lat" title="点击放大查看"><div class="lg-t">请求延迟分布</div>` +
      `<div class="lg-chart">${barChart(latVals, { h: 130, fill: "rgba(83,125,150,0.55)", format: (v) => String(v), xLabel: "<1s / 1-3s / 3-10s / >10s" })}</div>` +
      `<div class="lg-note">P50 ${lat.p50 ? (lat.p50 / 1000).toFixed(1) + "s" : "–"} · P95 ${lat.p95 ? (lat.p95 / 1000).toFixed(1) + "s" : "–"} · 峰值 ${lat.max ? (lat.max / 1000).toFixed(1) + "s" : "–"}</div>` +
      `</div>` +
      `<div class="lg-cell" data-lg="model" title="点击放大查看"><div class="lg-t">模型费用对比</div>` +
      `<div class="ua-donut-wrap">` +
      `<div class="ua-donut">${pieChart(modelVals.map((v, i) => ({ v, color: ["rgba(83,125,150,0.75)", "rgba(157,95,77,0.7)", "rgba(74,107,74,0.8)", "rgba(167,139,250,0.7)"][i % 4] })), { size: 110 })}</div>` +
      `<div class="ua-lg">${modelLegend}</div>` +
      `</div></div>` +
      `</div>`;
  }
  function renderFoot(stats) {
    const el = document.getElementById("foot");
    if (!stats) {
      el.innerHTML = "";
      return;
    }
    const im = stats.sumInput || 0;
    const ca = stats.sumCacheRead || 0;
    const ou = stats.sumOutput || 0;
    const re = stats.sumReasoning || 0;
    const tot = im + ca + ou + re || 1;
    const sid = stats.sessionId ? String(stats.sessionId).slice(0, 13) : "";
    el.innerHTML =
      `<div class="foot-file">${esc(sid ? sid + " · " : "")}${esc(stats.file || "")} · 起于 ${esc(stats.startTime || "?")}</div>` +
      `<div class="foot-bars">` +
      `<div class="fb-track">` +
      `<div class="fb-seg fb-in" data-pct="${((im / tot) * 100).toFixed(1)}" style="width:0"></div>` +
      `<div class="fb-seg fb-ca" data-pct="${((ca / tot) * 100).toFixed(1)}" style="width:0"></div>` +
      `<div class="fb-seg fb-ou" data-pct="${((ou / tot) * 100).toFixed(1)}" style="width:0"></div>` +
      (re > 0 ? `<div class="fb-seg fb-re" data-pct="${((re / tot) * 100).toFixed(1)}" style="width:0"></div>` : "") +
      `</div>` +
      `<div class="fb-legend">` +
      `<span class="fb-li"><i class="fb-dot" style="background:rgba(143,134,123,0.6)"></i>输入 <span class="cnt" data-to="${im}" data-kind="tokens">0</span></span>` +
      `<span class="fb-li"><i class="fb-dot" style="background:rgba(83,125,150,0.75)"></i>缓存 <span class="cnt" data-to="${ca}" data-kind="tokens">0</span></span>` +
      `<span class="fb-li"><i class="fb-dot" style="background:rgba(157,95,77,0.7)"></i>输出 <span class="cnt" data-to="${ou}" data-kind="tokens">0</span></span>` +
      (re > 0 ? `<span class="fb-li"><i class="fb-dot" style="background:rgba(27,54,93,0.7)"></i>推理 <span class="cnt" data-to="${re}" data-kind="tokens">0</span></span>` : "") +
      `</div>` +
      `</div>`;
    // 横条生长动画：先 0 宽度，下一帧过渡到目标
    requestAnimationFrame(() => {
      const segs = el.querySelectorAll(".fb-seg");
      segs.forEach((s) => {
        const pct = (parseFloat(s.dataset.pct || "0"));
        s.style.width = pct + "%";
      });
    });
  }

  function renderUsageAnalysis(stats) {
    const el = document.getElementById("usageCard");
    if (!el) return;
    if (!stats) {
      el.innerHTML = "";
      return;
    }
    const im = stats.sumInput || 0;
    const ca = stats.sumCacheRead || 0;
    const ou = stats.sumOutput || 0;
    const re = stats.sumReasoning || 0;
    const tot = im + ca + ou + re; // 含推理，与饼图各段总和一致（无数据时显示 0，不兜底）
    const hitTot = ca + im || 1;
    const hasData = tot > 0; // 无数据时不可放大
    const tokSegs = [
      { v: im, color: "rgba(143,134,123,0.65)" },
      { v: ca, color: "rgba(83,125,150,0.8)" },
      { v: ou, color: "rgba(157,95,77,0.75)" },
    ];
    if (re > 0) tokSegs.push({ v: re, color: "rgba(27,54,93,0.75)" });
    const hitSegs = [
      { v: ca, color: "rgba(74,107,74,0.85)" },
      { v: im, color: "rgba(157,95,77,0.7)" },
    ];
    const hitPct = hitTot > 0 ? ((ca / hitTot) * 100).toFixed(1) : "0.0";
    // 会话内模型分布：外部只显示当前所选供应商模型占比，完整图例进放大详情
    const models = stats.models && stats.models.length > 0 ? stats.models : null;
    let modelsHtml = "";
    if (models) {
      const totalTurns = models.reduce((a, x) => a + x.turns, 0) || 1;
      const dispProv = viewProvider || stats.provider || "unknown"; // 跟随当前所选供应商
      // 当前供应商模型合计轮次占比
      const provTurns = models.filter((x) => (x.provider || MODEL_PROVIDER[x.model]) === dispProv).reduce((a, x) => a + (x.turns || 0), 0);
      const provPct = ((provTurns / totalTurns) * 100).toFixed(1);
      const MODEL_COLORS = ["rgba(83,125,150,0.8)", "rgba(157,95,77,0.75)", "rgba(74,107,74,0.8)", "rgba(167,139,250,0.75)", "rgba(143,134,123,0.7)", "rgba(27,54,93,0.75)"];
      const segs = models.map((x, i) => ({ v: x.turns, color: MODEL_COLORS[i % MODEL_COLORS.length] }));
      modelsHtml =
        `<div class="ua-pie" data-ua="models" title="点击查看完整分布">` +
        `<div class="ua-pie-chart">${pieChart(segs, { size: 110 })}</div>` +
        `<div class="ua-pie-val"><span class="ua-pv">${esc(PROVIDER_CN[dispProv] || dispProv)} 占比</span><span class="ua-pv-num"><span class="cnt" data-to="${provPct}" data-kind="pct">0</span></span></div>` +
        `</div>`;
    }
    el.innerHTML =
      `<h3>用量分析</h3>` +
      `<div class="ua-row">` +
      (hasData
        ? `<div class="ua-pie" data-ua="tokens" title="点击放大查看">`
        : `<div class="ua-pie ua-disabled" title="暂无数据">`) +
      `<div class="ua-pie-chart">${pieChart(tokSegs, { size: 110 })}</div>` +
      `<div class="ua-pie-val"><span class="ua-pv">总计</span><span class="ua-pv-num"><span class="cnt" data-to="${tot}" data-kind="tokens">0</span></span></div>` +
      `</div>` +
      (hasData
        ? `<div class="ua-pie" data-ua="hit" title="点击放大查看">`
        : `<div class="ua-pie ua-disabled" title="暂无数据">`) +
      `<div class="ua-pie-chart">${pieChart(hitSegs, { size: 110 })}</div>` +
      `<div class="ua-pie-val"><span class="ua-pv">命中率</span><span class="ua-pv-num"><span class="cnt" data-to="${hitPct}" data-kind="pct">0</span></span></div>` +
      `</div>` +
      (models ? modelsHtml : "") +
      `</div>`;
  }

  function renderCtxBar(stats) {
    const el = document.getElementById("ctxCard");
    if (!el) return;
    const pct = Math.min(stats.contextPercent ?? 0, 100);
    const th = Math.round((stats.compactThreshold ?? 0.8) * 100);
    const win = fmtTokens(stats.contextWindow);
    const danger = pct >= th;
    el.innerHTML =
      `<h3>上下文窗口</h3>` +
      `<div class="ctx-bar">` +
      `<div class="ctx-track">` +
      `<div class="ctx-fill${danger ? " near" : ""}" style="width:0"></div>` +
      `<div class="ctx-th" style="left:${th}%"></div>` +
      `</div>` +
      `<div class="ctx-labels">` +
      `<span>已用 <span class="cnt" data-to="${stats.lastWindowTokens || 0}" data-kind="tokens">0</span> / ${win} · <span class="cnt" data-to="${pct}" data-kind="pct">0</span></span>` +
      `<span class="ctx-th-label">压缩阈值 ${th}%</span>` +
      `</div>` +
      `<div class="ctx-note">距压缩约 <span class="cnt" data-to="${stats.remainingToCompact || 0}" data-kind="tokens">0</span> tokens${danger ? " · 即将触发压缩" : ""}</div>` +
      `</div>`;
    // 进度条生长动画：先 0 宽度，下一帧过渡到目标
    requestAnimationFrame(() => {
      const fill = el.querySelector(".ctx-fill");
      if (fill) fill.style.width = Math.min(pct, 100) + "%";
    });
  }

  function renderBalanceBlock(balance, provider, model) {
    const el = document.getElementById("balanceBlock");
    if (!balance) {
      el.innerHTML = "";
      return;
    }
    const ok = (balance.balances || []).filter((b) => b.status === "ok");
    const unsupported = balance.unsupported || [];
    const current = ok.find((b) => b.provider === provider);
    const currentUnsupported = unsupported.find((item) => item.provider === provider);
    const currentName = current ? current.name : (PROVIDER_CN[provider] || provider);
    const site = PROVIDER_SITES[provider] || "";
    const linkHtml = site ? `<span class="bb-link" data-site="${site}" title="跳转官网">→</span>` : "";
    const valueHtml = current
      ? `<div class="bb-value">${esc(providerStatusSummary(current))}</div>`
      : `<div class="bb-value bb-na">${esc(currentUnsupported?.note || "暂无官方账户数据")}</div>`;
    const shortNote = {
      mimo: "本地估算",
      zhipu: "按量账户",
      agnes: "CSV 核对",
      openai: "需 Admin Key",
      gemini: "本地估算",
      "openai-codex": "实验性",
      "xai-oauth": "订阅账户",
      xai: "需 Management Key",
    };
    const statusProviders = ok.map((item) => item.provider);
    const optionProviders = [...new Set([...providerOrder, ...statusProviders])];
    const opts = optionProviders.map((p) => {
      const nm = PROVIDER_CN[p] || p;
      const b = ok.find((x) => x.provider === p);
      const note = b ? providerStatusSummary(b) : (shortNote[p] || "");
      const active = p === provider ? " active" : "";
      return `<button type="button" class="bb-opt${active}" data-provider="${p}"><span>${esc(nm)}</span><span class="bb-opt-note">${esc(note)}</span></button>`;
    }).join("");
    el.innerHTML =
      `<div class="bb-label" id="bbToggle" title="点击切换供应商">` +
      `<span>${esc(currentName)} ${esc(current?.label || "账户状态")}</span>` +
      `<span class="bb-switch">${bbOpen ? "▴" : "▾"}</span>` +
      linkHtml +
      `</div>` +
      `<div class="bb-pop${bbOpen ? " open" : ""}" id="bbPop">${opts}</div>` +
      valueHtml +
      `<div class="bb-note">${esc(providerStatusDetail(current, model))}</div>`;
  }

  function renderHeroMetrics(stats) {
    const el = document.getElementById("heroMetrics");
    if (!stats) {
      el.innerHTML = "";
      return;
    }
    const hms = [
      ["会话 tokens", stats.sessionTokens || 0, "tokens"],
      ["本次 tokens", stats.lastTurnTokens || 0, "tokens"],
      ["平均命中", stats.avgHitPercent || 0, "pct"],
      ["本次命中", stats.lastHitPercent || 0, "pct"],
      ["会话费用", stats.sessionCostCny || 0, "cny"],
      ["本次费用", stats.lastCostCny || 0, "cny"],
      ["轮数", stats.turns || 0, "int"],
      ["运行时长", stats.durationMinutes || 0, "dur"],
    ];
    el.innerHTML = hms
      .map(
        ([label, to, kind]) =>
          `<div class="hm"><span class="hml">${label}</span><span class="hmv"><span class="cnt" data-to="${to}" data-kind="${kind}">0</span></span></div>`
      )
      .join("");
  }

  const MODEL_PROVIDER = {
    "deepseek-v4-flash": "deepseek",
    "deepseek-v4-pro": "deepseek",
    "mimo-v2.5": "mimo",
    "mimo-v2.5-pro": "mimo",
    "mimo-v2.5-tts-voicedesign": "mimo",
    "mimo-v2-omni": "mimo",
    "glm-5.2": "zhipu",
    "glm-5.1": "zhipu",
    "glm-5": "zhipu",
    "glm-4-plus": "zhipu",
    "glm-4-flash": "zhipu",
    "glm-4-air": "zhipu",
    "gpt-4o": "openai",
    "gpt-5.5": "openai",
    "gpt-5.4-pro": "openai",
    "gemini-2.5-pro": "gemini",
    "gemini-2.5-flash": "gemini",
    "gemini-2.0-flash": "gemini",
    "agnes-2.0-flash": "agnes",
    "agnes-image-2.1-flash": "agnes",
    "agnes-video-v2.0": "agnes",
    "moonshot-v1": "moonshot",
  };

  const PROVIDER_SITES = {
    deepseek: "https://platform.deepseek.com",
    moonshot: "https://platform.kimi.com/console/account",
    mimo: "https://platform.xiaomimimo.com",
    zhipu: "https://bigmodel.cn/console/overview",
    agnes: "https://apihub.agnes-ai.com",
    openai: "https://platform.openai.com",
    gemini: "https://aistudio.google.com",
    "openai-codex": "https://chatgpt.com",
    "xai-oauth": "https://grok.com",
    xai: "https://console.x.ai",
  };

  function renderAcctMenu(balance, provider) {
    const el = document.getElementById("acctMenu");
    if (!balance) {
      el.innerHTML = "";
      return;
    }
    const ok = (balance.balances || []).filter((b) => b.status === "ok");
    const unsupported = balance.unsupported || [];
    const shortNote = {
      mimo: "本地估算",
      zhipu: "按量账户无余额",
      agnes: "CSV 导出核对",
      openai: "需 Admin Key",
      gemini: "本地估算",
      "openai-codex": "实验性配额未启用",
      "xai-oauth": "Grok 订阅账户",
      xai: "需 Management Key",
    };
    let html = `<button type="button" class="acct-toggle" id="acctToggle"><span class="tg-label">其他账户</span><span class="tg-count">${ok.length + unsupported.length}</span><span class="tg-arrow">${acctOpen ? "▴" : "▾"}</span></button>`;
    html += `<div class="acct-list${acctOpen ? " open" : ""}" id="acctList">`;
    const renderBtn = (b, dim, note) => {
      const active = !dim && b.provider === provider ? " active" : "";
      return `<button type="button" class="acct-btn${active}${dim ? " dim" : ""}" data-provider="${b.provider}"><span class="ab-n">${b.name}</span><span class="ab-v">${note}</span></button>`;
    };
    for (const b of ok) {
      html += renderBtn(b, false, esc(providerStatusSummary(b)));
    }
    for (const u of unsupported) {
      html += renderBtn({ provider: u.provider, name: PROVIDER_CN[u.provider] || u.provider }, true, esc(u.note || shortNote[u.provider]));
    }
    html += `</div>`;
    el.innerHTML = html;
  }

  function openExternal(url) {
    // 优先级：服务端系统默认打开（绕过内置窗口）→ 宿主 external.open → <a> 标签 → 提示
    const aFallback = () => {
      try {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        a.remove();
        return true;
      } catch (e) {
        return false;
      }
    };
    const hostFallback = () => {
      try {
        const p = hana.external.open({ url });
        const timer = setTimeout(aFallback, 1000);
        if (p && typeof p.then === "function") {
          p.then(
            () => clearTimeout(timer),
            () => {
              clearTimeout(timer);
              aFallback();
            }
          );
        }
      } catch (e) {
        aFallback();
      }
    };
    // 服务端 exec start（系统默认浏览器）
    fetchJson("/api/open?url=" + encodeURIComponent(url))
      .then((r) => {
        if (!r || r.ok !== true) hostFallback();
      })
      .catch(() => hostFallback());
  }

  function selectProvider(provider) {
    viewProvider = provider; // 供应商视图切换（只改余额面板，不切换会话）
    // 右上角徽章 + 页面背景跟随供应商
    setProviderBg(provider);
    balBadge.textContent = PROVIDER_CN[provider] || provider || "–";
    // 余额面板显示该供应商余额（保持当前会话数据不变）
    const sess = selectedFile ? sessions.find((x) => x.name === selectedFile) : null;
    const currentProvider = sess ? MODEL_PROVIDER[sess.model] : null;
    const note = currentProvider === provider ? "（当前会话）" : "（无会话）";
    renderBalanceBlock(lastBalance, provider, note);
    // 模型分布占比跟随所选供应商（重渲染用量分析）
    if (lastStats) renderUsageAnalysis(lastStats);
    animateNumbers(root); // 余额转轮数字滚动到目标
    // 异步刷新最新余额（防止竞态：仅当仍停留在该供应商时应用）
    const prov = provider;
    getBalance()
      .then((b) => {
        if (viewProvider !== prov || !b) return;
        lastBalance = b;
        renderBalanceBlock(b, prov, note);
        animateNumbers(root);
      })
      .catch(() => {});
    // 如果当前无选中会话，清空数据面板
    if (!selectedFile) {
      const zero = {
        sessionTokens: 0,
        lastTurnTokens: 0,
        avgHitPercent: 0,
        lastHitPercent: 0,
        sessionCostCny: 0,
        lastCostCny: 0,
        turns: 0,
        durationMinutes: 0,
        contextWindow: 0,
        contextPercent: 0,
        lastWindowTokens: 0,
        compactThreshold: 0.8,
        remainingToCompact: 0,
        series: [],
      };
      lastStats = zero;
      renderHeroMetrics(zero);
      renderCtxBar(zero);
      renderUsageAnalysis(zero);
      document.getElementById("chTokens").innerHTML = barChart([], { fill: "rgba(83,125,150,0.55)", format: fmtTokens });
      document.getElementById("chHit").innerHTML = lineChart([], { yMax: 100, format: (v) => v.toFixed(0) + "%" });
      document.getElementById("chCost").innerHTML = barChart([], { fill: "rgba(157,95,77,0.5)", format: fmtCostVal });
      document.getElementById("chStack").innerHTML = stackedBars([], {
        keys: ["cacheRead", "input", "output"],
        keyLabels: ["缓存命中", "未命中", "输出"],
        colors: ["rgba(83,125,150,0.75)", "rgba(83,125,150,0.32)", "rgba(143,134,123,0.5)"],
        format: fmtTokens,
      });
      foot.textContent = `${PROVIDER_CN[provider] || provider} · 暂无会话，消耗 ¥0.00`;
      animateNumbers(root);
    }
    // 有选中会话时不加载新数据，保持当前会话图表不变
  }



  // 全局用量总览放大详情
  function openLgModal(kind) {
    const ls = lastLedger;
    if (!ls || ls.empty || !ls.calls) return;
    const AGENT_COLORS = {
      "session:hanako": "rgba(83,125,150,0.8)",
      "automation:ming": "rgba(157,95,77,0.75)",
      "automation:hanako": "rgba(27,54,93,0.75)",
      "automation:butter": "rgba(74,107,74,0.8)",
      "session:ming": "rgba(143,134,123,0.7)",
      "memory:hanako": "rgba(83,125,150,0.5)",
      "session:butter": "rgba(167,139,250,0.7)",
      "utility:hanako": "rgba(157,95,77,0.5)",
    };
    let title = "";
    let body = "";
    if (kind === "agent") {
      title = "Agent 消耗";
      const agents = Object.entries(ls.agents || {}).sort((a, b) => b[1].cost - a[1].cost);
      const segs = agents.map(([k, v]) => ({ v: v.cost, color: AGENT_COLORS[k] || "rgba(143,134,123,0.6)" }));
      const legend = agents
        .map(([k, v]) => `<span><i class="fb-dot" style="background:${AGENT_COLORS[k] || "rgba(143,134,123,0.6)"}"></i>${esc(k.replace(":", "·"))} ${fmtCny(v.cost)} · ${v.calls} 次 · ${fmtTokens(v.tokens)}</span>`)
        .join("");
      body = `<div class="ua-donut" style="width:250px;height:250px">${pieChart(segs, { size: 250 })}</div><div class="ua-lg ua-lg-modal">${legend}</div>`;
    } else if (kind === "day") {
      title = "每日费用趋势";
      const days = Object.keys(ls.days || {});
      const dayCost = days.map((d) => ls.days[d].cost);
      const legend = days
        .map((d) => `<span>${esc(d.slice(5))} <b>${fmtCny(ls.days[d].cost)}</b> · ${ls.days[d].calls} 次 · ${fmtTokens(ls.days[d].tokens)}</span>`)
        .join("");
      body = `<div class="lg-chart" style="width:100%">${lineChart(dayCost, { w: 780, h: 260, stroke: "var(--accent)", fill: "rgba(83,125,150,0.10)", format: fmtCostVal, xLabel: (days[0] || "").slice(5) + "~" + (days[days.length - 1] || "").slice(5) })}</div><div class="ua-lg ua-lg-modal" style="margin-top:10px">${legend}</div>`;
    } else if (kind === "lat") {
      title = "请求延迟分布";
      const lb = (ls.latency && ls.latency.buckets) || {};
      const latVals = [lb.lt1 || 0, lb["1_3"] || 0, lb["3_10"] || 0, lb.gt10 || 0];
      const latSum = latVals.reduce((a, b) => a + b, 0) || 1;
      const l = ls.latency || {};
      const legend =
        `<span><i class="fb-dot" style="background:rgba(83,125,150,0.75)"></i>&lt;1s <b>${latVals[0]}</b> · ${((latVals[0] / latSum) * 100).toFixed(0)}%</span>` +
        `<span><i class="fb-dot" style="background:rgba(83,125,150,0.55)"></i>1-3s <b>${latVals[1]}</b> · ${((latVals[1] / latSum) * 100).toFixed(0)}%</span>` +
        `<span><i class="fb-dot" style="background:rgba(157,95,77,0.7)"></i>3-10s <b>${latVals[2]}</b> · ${((latVals[2] / latSum) * 100).toFixed(0)}%</span>` +
        `<span><i class="fb-dot" style="background:rgba(27,54,93,0.75)"></i>&gt;10s <b>${latVals[3]}</b> · ${((latVals[3] / latSum) * 100).toFixed(0)}%</span>` +
        `<span class="lg-detail">样本 ${l.n} · 平均 ${l.avg ? (l.avg / 1000).toFixed(1) + "s" : "–"} · P50 ${l.p50 ? (l.p50 / 1000).toFixed(1) + "s" : "–"} · P95 ${l.p95 ? (l.p95 / 1000).toFixed(1) + "s" : "–"} · 峰值 ${l.max ? (l.max / 1000).toFixed(1) + "s" : "–"}</span>`;
      body = `<div class="lg-chart" style="width:100%">${barChart(latVals, { w: 780, h: 260, fill: "rgba(83,125,150,0.55)", format: (v) => String(v), xLabel: "<1s / 1-3s / 3-10s / >10s" })}</div><div class="ua-lg ua-lg-modal" style="margin-top:10px">${legend}</div>`;
    } else if (kind === "model") {
      title = "模型费用对比";
      const models = Object.entries(ls.models || {}).sort((a, b) => b[1].cost - a[1].cost);
      const segs = models.map(([m, v], i) => ({ v: v.cost, color: ["rgba(83,125,150,0.75)", "rgba(157,95,77,0.7)", "rgba(74,107,74,0.8)", "rgba(167,139,250,0.7)"][i % 4] }));
      const legend = models
        .map(([m, v], i) => `<span><i class="fb-dot" style="background:${["rgba(83,125,150,0.75)", "rgba(157,95,77,0.7)", "rgba(74,107,74,0.8)", "rgba(167,139,250,0.7)"][i % 4]}"></i>${esc(m)} ${fmtCny(v.cost)} · ${v.calls} 次</span>`)
        .join("");
      body = `<div class="ua-donut" style="width:250px;height:250px">${pieChart(segs, { size: 250 })}</div><div class="ua-lg ua-lg-modal">${legend}</div>`;
    } else {
      return;
    }
    const modal = document.createElement("div");
    modal.className = "si-modal";
    modal.innerHTML =
      `<div class="si-modal-bg"></div>` +
      `<div class="si-modal-card glass">` +
      `<div class="si-modal-head"><h3>${esc(title)}</h3><button type="button" class="si-modal-close" title="关闭">×</button></div>` +
      `<div class="si-modal-body" style="display:flex;align-items:center;gap:32px;flex-wrap:wrap;justify-content:center">${body}</div>` +
      `</div>`;
    document.body.appendChild(modal);
    // 一次渲染完整内容（含图表）；双 rAF 等浏览器完成解析/布局/首绘后再启动动画，
    // 动画期间主线程空闲 → 放大全程纯合成，流畅无分步、无复读、无闪
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add("open")));
    const close = () => {
      modal.classList.remove("open");
      modal.classList.add("closing");
      setTimeout(() => modal.remove(), 220);
      document.removeEventListener("keydown", escHandler);
    };
    const escHandler = (e) => {
      if (e.key === "Escape") close();
    };
    modal.addEventListener("click", (e) => {
      if (e.target.closest(".si-modal-close") || e.target.classList.contains("si-modal-bg")) close();
    });
    document.addEventListener("keydown", escHandler);
  }
  // 用量分析放大详情（环形图大图）
  function openUaModal(kind) {
    if (!lastStats) return;
    const s = lastStats;
    const im = s.sumInput || 0, ca = s.sumCacheRead || 0, ou = s.sumOutput || 0, re = s.sumReasoning || 0;
    const tot = im + ca + ou + re || 1; // 含推理，与环形图总和不一致问题修复
    const pct = (n) => ((n / tot) * 100).toFixed(1) + "%";
    let title = "";
    let donut = "";
    let legend = "";
    let detail = "";
    if (kind === "tokens") {
      title = "Token 构成";
      const segs = [
        { v: im, color: "rgba(143,134,123,0.6)" },
        { v: ca, color: "rgba(83,125,150,0.75)" },
        { v: ou, color: "rgba(157,95,77,0.7)" },
      ];
      if (re > 0) segs.push({ v: re, color: "rgba(27,54,93,0.7)" });
      donut = donutChart(segs, { size: 250, r: 92, sw: 24, center: fmtTokens(tot), sub: "总计" });
      legend =
        `<div class="ua-lg ua-lg-modal">` +
        `<span><i class="fb-dot" style="background:rgba(143,134,123,0.6)"></i>输入 ${fmtTokens(im)} · ${pct(im)}</span>` +
        `<span><i class="fb-dot" style="background:rgba(83,125,150,0.75)"></i>缓存 ${fmtTokens(ca)} · ${pct(ca)}</span>` +
        `<span><i class="fb-dot" style="background:rgba(157,95,77,0.7)"></i>输出 ${fmtTokens(ou)} · ${pct(ou)}</span>` +
        (re > 0 ? `<span><i class="fb-dot" style="background:rgba(27,54,93,0.7)"></i>推理 ${fmtTokens(re)} · ${pct(re)}</span>` : "") +
        `</div>`;
      detail = `总计 ${fmtTokens(tot)} · 缓存率 ${fmtPct(s.avgHitPercent)} · 费用 ${fmtCny(s.sessionCostCny)}`;
    } else if (kind === "models") {
      title = "会话模型分布";
      const models = (s.models || []).filter((x) => x && x.model);
      const totalTurns = models.reduce((a, x) => a + (x.turns || 0), 0) || 1;
      const MODEL_COLORS = ["rgba(83,125,150,0.8)", "rgba(157,95,77,0.75)", "rgba(74,107,74,0.8)", "rgba(167,139,250,0.75)", "rgba(143,134,123,0.7)", "rgba(27,54,93,0.75)"];
      const segs = models.map((x, i) => ({ v: x.turns, color: MODEL_COLORS[i % MODEL_COLORS.length] }));
      donut = donutChart(segs, { size: 250, r: 92, sw: 24, center: String(totalTurns), sub: "总轮次" });
      legend =
        `<div class="ua-lg ua-lg-modal">` +
        models
          .map((x, i) => `<span><i class="fb-dot" style="background:${MODEL_COLORS[i % MODEL_COLORS.length]}"></i>${esc(x.model)} <b>${x.turns}</b> 轮 · ${((x.turns / totalTurns) * 100).toFixed(0)}%</span>`)
          .join("") +
        `</div>`;
      detail = `${models.length} 个模型 · 主模型 ${esc(s.model || "未知")} · 会话费用 ${fmtCny(s.sessionCostCny)}`;
    } else {
      title = "命中 / 未命中";
      const hitTot = ca + im || 1;
      const hitPct = ((ca / hitTot) * 100).toFixed(1);
      donut = donutChart(
        [
          { v: ca, color: "rgba(74,107,74,0.85)" },
          { v: im, color: "rgba(157,95,77,0.7)" },
        ],
        { size: 250, r: 92, sw: 24, center: hitPct + "%", sub: "命中率" }
      );
      legend =
        `<div class="ua-lg ua-lg-modal">` +
        `<span><i class="fb-dot" style="background:rgba(74,107,74,0.85)"></i>命中 ${fmtTokens(ca)} · ${hitPct}%</span>` +
        `<span><i class="fb-dot" style="background:rgba(157,95,77,0.7)"></i>未命中 ${fmtTokens(im)}</span>` +
        `</div>`;
      detail = `输入侧总计 ${fmtTokens(hitTot)} · 命中 ${fmtTokens(ca)} · 未命中 ${fmtTokens(im)}`;
    }
    const modal = document.createElement("div");
    modal.className = "si-modal";
    modal.innerHTML =
      `<div class="si-modal-bg"></div>` +
      `<div class="si-modal-card glass">` +
      `<div class="si-modal-head"><h3>${esc(title)}</h3><button type="button" class="si-modal-close" title="关闭">×</button></div>` +
      `<div class="si-modal-body" style="display:flex;align-items:center;gap:32px;flex-wrap:wrap;justify-content:center">` +
      `<div class="ua-donut" style="width:250px;height:250px">${donut}</div>` +
      `<div style="flex:1;min-width:220px">${legend}<div class="ua-detail" style="margin-top:14px">${esc(detail)}</div></div>` +
      `</div>` +
      `</div>`;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add("open"));
    const close = () => {
      modal.classList.remove("open");
      modal.classList.add("closing");
      setTimeout(() => modal.remove(), 220);
      document.removeEventListener("keydown", escHandler);
    };
    const escHandler = (e) => {
      if (e.key === "Escape") close();
    };
    modal.addEventListener("click", (e) => {
      if (e.target.closest(".si-modal-close") || e.target.classList.contains("si-modal-bg")) close();
    });
    document.addEventListener("keydown", escHandler);
  }

  // 图表放大详情页（更详细的数据）
  // 图表放大详情：同步渲染（立即响应），调用方决定是否后台升级
  function showChartModal(stats, chart, title) {
    if (!stats || !stats.series || stats.series.length === 0) return;
    const series = stats.series;
    const values = series.map((s) =>
      chart === "tokens" ? s.total : chart === "hit" ? s.hit : chart === "cost" ? s.cost : s.total
    );
    const maxV = Math.max(...values);
    const maxIdx = values.indexOf(maxV) + 1;
    const avgV = values.reduce((a, b) => a + b, 0) / values.length;
    const lastV = values[values.length - 1];
    const fmtV = chart === "hit" ? (v) => v.toFixed(1) + "%" : chart === "cost" ? fmtCostVal : fmtTokens;
    const summary =
      `<div class="si-modal-sum">` +
      `<span><b>${series.length}</b> 轮</span>` +
      `<span>峰值 <b>${fmtV(maxV)}</b>（第 ${maxIdx} 轮）</span>` +
      `<span>平均 <b>${fmtV(avgV)}</b></span>` +
      `<span>末值 <b>${fmtV(lastV)}</b></span>` +
      `</div>`;
    const legend =
      `<div class="legend">` +
      `<span><i style="background:rgba(83,125,150,0.75)"></i>缓存命中</span>` +
      `<span><i style="background:rgba(83,125,150,0.32)"></i>未命中</span>` +
      `<span><i style="background:rgba(143,134,123,0.5)"></i>输出</span>` +
      `</div>`;
    let inner = "";
    if (chart === "tokens") {
      inner = barChart(series.map((s) => s.total), { w: 880, h: 300, fill: "rgba(83,125,150,0.55)", format: fmtTokens, ticks: 5 });
    } else if (chart === "hit") {
      inner = lineChart(series.map((s) => s.hit), {
        w: 880, h: 300, stroke: "var(--green)", fill: "rgba(74,107,74,0.10)", yMax: 100, ticks: 5,
        format: (v) => v.toFixed(0) + "%",
      });
    } else if (chart === "cost") {
      inner = barChart(series.map((s) => s.cost), { w: 880, h: 300, fill: "rgba(157,95,77,0.5)", format: fmtCostVal, ticks: 5 });
    } else if (chart === "stack") {
      inner = legend + stackedBars(series, {
        w: 880, h: 300, ticks: 5,
        keys: ["cacheRead", "input", "output"],
        keyLabels: ["缓存命中", "未命中", "输出"],
        colors: ["rgba(83,125,150,0.75)", "rgba(83,125,150,0.32)", "rgba(143,134,123,0.5)"],
        format: fmtTokens,
      });
    }
    const modal = document.createElement("div");
    modal.className = "si-modal";
    // 已有同图表 modal（500 轮数据升级）：直接更新内容，不重建，避免动画中途被移除重放
    const existing = document.querySelector('.si-modal[data-chart="' + chart + '"]');
    if (existing) {
      const mb = existing.querySelector(".si-modal-body");
      if (mb) mb.innerHTML = body;
      return;
    }
    modal.dataset.chart = chart;
    modal.innerHTML =
      `<div class="si-modal-bg"></div>` +
      `<div class="si-modal-card glass">` +
      `<div class="si-modal-head"><h3>${esc(title)}</h3><button type="button" class="si-modal-close" title="关闭">×</button></div>` +
      summary +
      `<div class="si-modal-body">${inner}</div>` +
      `</div>`;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add("open"));
    const close = () => {
      modal.classList.remove("open");
      modal.classList.add("closing");
      setTimeout(() => modal.remove(), 220);
      document.removeEventListener("keydown", escHandler);
    };
    const escHandler = (e) => {
      if (e.key === "Escape") close();
    };
    modal.addEventListener("click", (e) => {
      if (e.target.closest(".si-modal-close") || e.target.classList.contains("si-modal-bg")) close();
    });
    document.addEventListener("keydown", escHandler);
  }

  // 打开图表详情：立即用已有数据弹出，后台拉 500 轮升级
  function openChartModal(chart, title) {
    showChartModal(lastStats, chart, title);
    if (selectedFile) {
      fetchJson("/api/stats?file=" + encodeURIComponent(selectedFile) + "&limit=500")
        .then((res) => {
          if (res && !res.error && res.series && res.series.length > 0) showChartModal(res, chart, title);
        })
        .catch(() => {});
    }
  }

  function setLoading(on) {
    refreshBtn.disabled = on;
    const ic = document.getElementById("btnIc");
    const tx = document.getElementById("btnTx");
    if (on) {
      refreshBtn.classList.add("loading");
      if (tx) tx.textContent = "刷新中";
    } else {
      refreshBtn.classList.remove("loading");
      if (ic) {
        ic.textContent = "✓";
        ic.classList.add("done");
      }
      if (tx) tx.textContent = "已刷新";
      setTimeout(() => {
        if (ic && !refreshBtn.classList.contains("loading")) {
          ic.textContent = "↻";
          ic.classList.remove("done");
        }
        if (tx && !refreshBtn.classList.contains("loading")) tx.textContent = "刷新";
      }, 1000);
    }
  }

  let sessions = [];

  function sessLabel(s) {
    const d = new Date(s.mtime);
    const dd = String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const t = s.title ? (s.title.length >= 30 ? s.title + "…" : s.title) : "";
    return t ? `${t} · ${dd} ${hh}` : `${dd} ${hh} · ${s.model || "未知模型"}`;
  }

  function setSelected(file) {
    selectedFile = file;
    const pop = document.getElementById("selPop");
    if (pop) {
      for (const opt of pop.querySelectorAll(".sel-opt")) {
        opt.classList.toggle("sel-on", opt.dataset.file === file);
      }
    }
    if (selText) {
      const cur = sessions.find((s) => s.name === file);
      selText.textContent = cur ? sessLabel(cur) : "选择会话";
    }
  }

  function renderSelOptions() {
    if (!selPop) return;
    const now = new Date();
    const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dow = now.getDay() || 7; // 周日视作 7
    const week0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + 1).getTime();
    const optHtml = (s) =>
      `<div class="sel-opt${s.name === selectedFile ? " sel-on" : ""}" data-file="${s.name}"><span class="so-tx">${esc(sessLabel(s))}</span></div>`;
    const groups = [
      { label: "今天", list: sessions.filter((s) => s.mtime >= today0) },
      { label: "本周", list: sessions.filter((s) => s.mtime >= week0 && s.mtime < today0) },
      { label: "更早", list: sessions.filter((s) => s.mtime < week0) },
    ].filter((g) => g.list.length > 0);
    selPop.innerHTML = groups
      .map((g) => `<div class="sel-grp"><div class="sel-grp-t">${g.label}</div>${g.list.map(optHtml).join("")}</div>`)
      .join("");
    if (selText) {
      const cur = sessions.find((s) => s.name === selectedFile);
      selText.textContent = cur ? sessLabel(cur) : "选择会话";
    }
  }

  function toggleSel(open) {
    selRoot.classList.toggle("open", open);
    const arrow = selRoot.querySelector(".sel-arrow");
    if (arrow) arrow.textContent = open ? "▴" : "▾";
  }

  async function loadSessions() {
    try {
      const data = await getSessions();
      sessions = data.sessions || [];
      if (sessions.length > 0 && !selectedFile) selectedFile = sessions[0].name;
      renderSelOptions();
    } catch (e) {
      if (selPop) selPop.innerHTML = "";
    }
  }

  async function loadData(file, opts = {}) {
    try {
      const [stats, total, ledger] = await Promise.all([
        getStats(file),
        getTotalCost().catch(() => null),
        getLedgerStats().catch(() => null),
      ]);
      if (!stats || stats.error) throw new Error(stats?.error || "no usage data");
      if (!opts.preserveView) viewProvider = null; // 切会话时重置视图；刷新时保留手动选的供应商
      lastStats = stats;
      const dispProvider = viewProvider || stats.provider; // 显示用供应商：手动选优先，否则取会话所属
      setProviderBg(dispProvider);
      modelBadge.textContent = stats.model || "unknown";
      // 多模型会话：badge 加标记，tooltip 显示完整分布
      if (stats.models && stats.models.length > 1) {
        modelBadge.textContent = (stats.model || "unknown") + " ×" + stats.models.length;
        modelBadge.title = "会话内模型分布：\n" + stats.models.map((x) => `  ${x.model}：${x.turns} 轮`).join("\n");
      } else {
        modelBadge.title = "";
      }
      balBadge.textContent = PROVIDER_CN[dispProvider] || dispProvider || "–";
      renderBalanceBlock(lastBalance, dispProvider, stats.model);
      // 余额单独异步刷新，不阻塞主体渲染（8 家供应商查询较慢）
      getBalance()
        .then((b) => {
          if (!b) return;
          lastBalance = b;
          renderBalanceBlock(b, viewProvider || dispProvider, stats.model);
          animateNumbers(root);
        })
        .catch(() => {});
      renderHeroMetrics(stats);
      renderCtxBar(stats);
      renderUsageAnalysis(stats);

      const series = stats.series || [];
      const totals = series.map((s) => s.total);
      const hits = series.map((s) => s.hit);
      const costs = series.map((s) => s.cost);
      const fmtCost = fmtCostVal;
      const legend =
        `<div class="legend">` +
        `<span><i style="background:rgba(83,125,150,0.75)"></i>缓存命中</span>` +
        `<span><i style="background:rgba(83,125,150,0.32)"></i>未命中</span>` +
        `<span><i style="background:rgba(143,134,123,0.5)"></i>输出</span>` +
        `</div>`;

      document.getElementById("chTokens").innerHTML = barChart(totals, { fill: "rgba(83,125,150,0.55)", format: fmtTokens });
      document.getElementById("chHit").innerHTML = lineChart(hits, {
        stroke: "var(--green)",
        fill: "rgba(74,107,74,0.10)",
        yMax: 100,
        format: (v) => v.toFixed(0) + "%",
      });
      document.getElementById("chCost").innerHTML = barChart(costs, { fill: "rgba(157,95,77,0.5)", format: fmtCost });
      document.getElementById("chStack").innerHTML = legend + stackedBars(series, {
        keys: ["cacheRead", "input", "output"],
        keyLabels: ["缓存命中", "未命中", "输出"],
        colors: ["rgba(83,125,150,0.75)", "rgba(83,125,150,0.32)", "rgba(143,134,123,0.5)"],
        format: fmtTokens,
      });
      // 首次进入的图表动画只播一次，刷新/切换不重播（避免页面跳动）
      const gridEl = document.querySelector(".chart-grid");
      if (gridEl) gridEl.classList.remove("si-anim");

      try {
        renderLedger(ledger);
        if (ledger && !ledger.empty) lastLedger = ledger;
      } catch (e) {
        const lc = document.getElementById("ledgerCard");
        if (lc) lc.innerHTML = `<h3>全局用量总览</h3><div class="empty">渲染错误：${esc(e.message || e)}</div>`;
      }
      renderFoot(stats);
      invalidateGlowCache();
      animateNumbers(root);
    } catch (e) {
      const metricsEl = document.getElementById("heroMetrics");
      if (metricsEl) metricsEl.innerHTML = `<div class="empty">${esc(e.message || e)}</div>`;
      document.getElementById("chTokens").innerHTML = "";
      document.getElementById("chHit").innerHTML = "";
      document.getElementById("chCost").innerHTML = "";
      document.getElementById("chStack").innerHTML = "";
    }
  }

  selBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSel(!selRoot.classList.contains("open"));
  });
  // F5 快捷刷新（window 捕获阶段 + 自动聚焦，确保 iframe 内键盘事件到达）
  root.setAttribute("tabindex", "-1");
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "F5") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        refreshBtn.click();
      }
    },
    true
  );
  root.addEventListener("pointerdown", () => root.focus());
  root.focus();
  githubBtn?.addEventListener("click", () => {
    openExternal("https://github.com/youyongdemao/HanaAgent-session-insight");
  });

  updateCheckBtn.addEventListener("click", async () => {
    updateCheckBtn.disabled = true;
    updateCheckBtn.classList.add("loading");
    const ic = document.getElementById("updateCheckIc");
    const tx = document.getElementById("updateCheckTx");
    if (ic) ic.textContent = "↻";
    if (tx) tx.textContent = "检查中";

    try {
      const info = await fetchJson("/api/check-update");
      if (!info.updateAvailable) {
        await showUpdateNotice("已是最新版本", `当前版本 v${info.currentVersion || "未知"}`);
        return;
      }
      if (!info.hasInstallAsset) throw new Error("新版 Release 中没有找到 ZIP 安装包");

      await showUpdateNotice(
        `检查到新版本 v${info.latestVersion}`,
        `当前版本 v${info.currentVersion}，关闭提示后开始热更新。`,
        "开始更新"
      );

      if (selectedFile) sessionStorage.setItem("si-hot-selected-file", selectedFile);
      else sessionStorage.removeItem("si-hot-selected-file");
      if (viewProvider) sessionStorage.setItem("si-hot-view-provider", viewProvider);
      else sessionStorage.removeItem("si-hot-view-provider");
      if (tx) tx.textContent = "更新中";

      const response = await hana.api.fetch("/api/apply-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: info.latestVersion }),
        signal: AbortSignal.timeout(120000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);

      const next = new URL(window.location.href);
      next.searchParams.set("hot", Date.now().toString(36));
      window.location.replace(next.toString());
    } catch (error) {
      await showUpdateNotice("检查更新失败", String(error?.message || error), "关闭");
    } finally {
      updateCheckBtn.disabled = false;
      updateCheckBtn.classList.remove("loading");
      if (ic) ic.textContent = "⇧";
      if (tx) tx.textContent = "检查更新";
    }
  });

  refreshBtn.addEventListener("click", async () => {
    setLoading(true);
    try {
      if (selectedFile) {
        // 有选中会话 → 重新加载数据（保持当前供应商视图，不切回默认）
        await loadData(selectedFile, { preserveView: true });
      } else if (viewProvider) {
        // 无会话，有供应商视图 → 只刷新余额
        const balance = await getBalance().catch(() => null);
        lastBalance = balance;
        renderBalanceBlock(balance, viewProvider, "（无会话）");
      }
    } finally {
      setLoading(false);
    }
  });

  await loadSessions();
  if (sessions.length > 0 && !selectedFile) selectedFile = sessions[0].name;
  await loadData(selectedFile);
  syncProviders(); // 打开时同步 HanaAgent 供应商配置（新增/删减自动适配）

  // 事件委托：下拉选择 + 折叠菜单 + 官网跳转 + 供应商切换
  root.addEventListener("click", (e) => {
    const opt = e.target.closest(".sel-opt");
    if (opt) {
      setSelected(opt.dataset.file);
      toggleSel(false);
      loadData(opt.dataset.file);
      return;
    }
    const toggle = e.target.closest("#acctToggle");
    if (toggle) {
      acctOpen = !acctOpen;
      const list = document.getElementById("acctList");
      const arrow = toggle.querySelector(".tg-arrow");
      if (list) list.classList.toggle("open", acctOpen);
      if (arrow) arrow.textContent = acctOpen ? "▴" : "▾";
      return;
    }
    const bblink = e.target.closest(".bb-link");
    if (bblink) {
      const site = bblink.dataset.site;
      if (site) openExternal(site);
      return;
    }
    const bbToggle = e.target.closest("#bbToggle");
    if (bbToggle) {
      bbOpen = !bbOpen;
      const pop = document.getElementById("bbPop");
      const arr = bbToggle.querySelector(".bb-switch");
      if (pop) pop.classList.toggle("open", bbOpen);
      if (arr) arr.textContent = bbOpen ? "▴" : "▾";
      return;
    }
    const bbOpt = e.target.closest(".bb-opt[data-provider]");
    if (bbOpt) {
      bbOpen = false;
      const pop = document.getElementById("bbPop");
      if (pop) pop.classList.remove("open");
      selectProvider(bbOpt.dataset.provider);
      return;
    }
    const chartCard = e.target.closest(".chart-card[data-chart]");
    if (chartCard) {
      const chart = chartCard.dataset.chart;
      const title = chartCard.querySelector("h3") ? chartCard.querySelector("h3").textContent.replace(/⤢$/, "").trim() : chart;
      openChartModal(chart, title);
      return;
    }
    const uaPane = e.target.closest(".ua-pie[data-ua]");
    if (uaPane) {
      openUaModal(uaPane.dataset.ua);
      return;
    }
    const lgCell = e.target.closest(".lg-cell[data-lg]");
    if (lgCell) {
      openLgModal(lgCell.dataset.lg);
      return;
    }
    const btn = e.target.closest(".acct-btn[data-provider]");
    if (btn) {
      // 卡片点击：切换该供应商视图（无会话显示消耗 0）
      selectProvider(btn.dataset.provider);
      return;
    }
  });

  // 卡片按下回弹动效：mousedown 压缩，mouseup/移出回弹（带 overshoot）
  const cardSel = ".hm, .chart-card, .ua-pie, .lg-cell, .w-overview, .w-metric, .w-provider-row";
  const pressCard = (el) => {
    if (el.classList.contains("ua-disabled")) return;
    el.classList.remove("si-release");
    el.classList.add("si-press");
  };
  const releaseCard = (el) => {
    if (!el || !el.classList.contains("si-press")) return;
    el.classList.remove("si-press");
    el.classList.add("si-release");
    clearTimeout(el.__siRel);
    el.__siRel = setTimeout(() => el.classList.remove("si-release"), 650);
  };
  document.addEventListener("mousedown", (e) => {
    const card = e.target.closest(cardSel);
    if (card) pressCard(card);
  }, true);
  document.addEventListener("mouseup", (e) => {
    const card = e.target.closest(cardSel);
    if (card) releaseCard(card);
  }, true);
  document.addEventListener("mouseleave", (e) => {
    const card = e.target.closest(cardSel);
    if (card) releaseCard(card);
  }, true);
  document.addEventListener("touchstart", (e) => {
    const card = e.target.closest(cardSel);
    if (card) pressCard(card);
  }, true);
  document.addEventListener("touchend", (e) => {
    const card = e.target.closest(cardSel);
    if (card) releaseCard(card);
  }, true);

  // 点击外部关闭下拉（供应商切换 + 会话选择）
  document.addEventListener("click", (e) => {
    if (bbOpen && !e.target.closest("#bbToggle") && !e.target.closest("#bbPop")) {
      bbOpen = false;
      const pop = document.getElementById("bbPop");
      const arr = document.querySelector("#bbToggle .bb-switch");
      if (pop) pop.classList.remove("open");
      if (arr) arr.textContent = "▾";
    }
    if (!selRoot.contains(e.target)) toggleSel(false);
  });
}

/* ── 入口 ───────────────────────────────────────── */

// 鼠标跟踪光晕：以鼠标为光源，局部跟随（卡片内，不溢出外围）
function ensureGlowSpot(card) {
  if (!card.querySelector(".si-glow-spot")) {
    const spot = document.createElement("div");
    spot.className = "si-glow-spot";
    card.prepend(spot);
  }
  if (!card.querySelector(".si-border-glow")) {
    const border = document.createElement("div");
    border.className = "si-border-glow";
    card.prepend(border);
  }
}

/* ── 文字提亮位置缓存：消除 mousemove 时逐元素 getBoundingClientRect 的 layout thrash ── */
let glowCache = null;
const GLOW_SEL = ".hm .hml, .hm .hmv, h3, .legend span, .ua-t, .ua-pv, .ua-pv-num, .ua-lg span, .ua-detail span, .ctx-labels span, .ctx-note, .lg-t, .lg-sub, .ab-n, .ab-v, .foot-file, .fb-li, .model, .w-title, .w-turns, .w-money-row span, .w-money-row b, .w-section-head span, .w-section-head b, .w-context-note, .w-metric span, .w-metric b, .w-legend span, .w-provider-share span, .w-provider-name strong, .w-provider-name span, .w-provider-stat span, .w-provider-stat b";
function buildGlowCache(card) {
  const r = card.getBoundingClientRect();
  const els = card.querySelectorAll(GLOW_SEL);
  // 提亮范围：光晕半径与卡片尺寸取较小值，避免小卡片整卡都在半径内导致"未靠近就亮"
  const glowR = parseFloat(getComputedStyle(card).getPropertyValue("--glow-r")) || 175;
  const cardSize = Math.max(r.width, r.height);
  glowCache = {
    card,
    maxD: Math.min(glowR, cardSize * 0.5),
    els: Array.from(els, (el) => {
      const er = el.getBoundingClientRect();
      return { el, rx: er.left + er.width / 2 - r.left, ry: er.top + er.height / 2 - r.top };
    }),
  };
}
function invalidateGlowCache() {
  glowCache = null;
}

function initGlow(container) {
  const selector = ".hm, .chart-card, .bar, .foot, .w-overview, .w-metric, .w-provider-row";
  let raf = null;
  let mx = 0, my = 0;
  container.addEventListener("mousemove", (e) => {
    mx = e.clientX;
    my = e.clientY;
    if (raf) return;
    // rAF 节流：快速滑动时每帧只处理一次，避免高频强制重排
    raf = requestAnimationFrame(() => {
      raf = null;
      const card = document.elementFromPoint(mx, my)?.closest(selector);
      if (!card) return;
      ensureGlowSpot(card);
      const r = card.getBoundingClientRect();
      const x = (((mx - r.left) / r.width) * 100).toFixed(1);
      const y = (((my - r.top) / r.height) * 100).toFixed(1);
      card.style.setProperty("--mx", x + "%");
      card.style.setProperty("--my", y + "%");
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const ang = (Math.atan2(my - cy, mx - cx) * 180) / Math.PI + 90;
      card.style.setProperty("--ang", ang.toFixed(1) + "deg");
      // 文字提亮跟随鼠标：位置缓存 + 亮度量化，效果不变但消除 layout thrash
      if (!glowCache || glowCache.card !== card) buildGlowCache(card);
      if (glowCache.els.length) {
        const rl = r.left, rt = r.top;
        for (const item of glowCache.els) {
          const dx = item.rx - (mx - rl);
          const dy = item.ry - (my - rt);
          const g = 1 - Math.sqrt(dx * dx + dy * dy) / glowCache.maxD;
          const q = g > 0 ? Math.round(Math.max(0, g) * 20) / 20 : 0; // 0.05 步进量化，减少 filter 重绘
          if (item.el.__glow !== q) {
            item.el.__glow = q;
            item.el.style.setProperty("--glow", q.toFixed(2));
          }
        }
      }
    });
  });
}

if (surface === "widget") {
  renderWidget();
  hana.ui.resize({ height: 760 });
} else {
  renderPage();
  hana.ui.resize({ height: 900 });
}
initGlow(root);
hana.ready();
