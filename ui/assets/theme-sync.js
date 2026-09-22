/* assets/theme-sync.js — 宿主主题跟随（页面共用）
 *
 * 为什么单独抽出来：宿主塞进 iframe URL 的那份主题只是**创建那一刻的初值**，
 * 之后它会经 SDK（hana.theme.changed）把当前主题推过来。只读一次 URL 参数，
 * 页面就会永远停在初值上——设置页当初就是这么停在默认主题（暖纸）而显示成浅色的。
 * 面板页订阅了 SDK 所以正常，设置页没订阅所以不对，逻辑本来只写了一份。
 *
 * 三件事：
 *   1) 主题名写到 html / body 的 data-theme 上（宿主同款属性名，CSS 里按它分支）；
 *   2) 宿主签发的样式表挂到 #hana-theme-css（属性名由宿主定，参数不要自己改）；
 *   3) 按 --bg 的亮度标出 color-mode，供需要区分深浅的样式用。
 */
import { hana } from "./sdk.js";

const THEME_LINK_ID = "hana-theme-css";

/** 要从宿主窗口镜像过来的变量。
 *  取的是「宿主 :root 上确实定义过」∩「本插件样式里引用到」的那批
 *  （--si-* 这类插件自有变量不在其中）。写成显式名单是有意的：不赌
 *  CSSStyleDeclaration 能不能枚举自定义属性（Chromium 各版本行为不一致），
 *  少抄一个只会少一个颜色，不会让整条路径失效。宿主换主题时名字不变、值变，
 *  这里不用跟着改。 */
const MIRROR_VARS = [
  "--bg",
  "--bg-card",
  "--text",
  "--text-light",
  "--text-muted",
  "--accent",
  "--border",
  "--green",
  "--danger",
  "--font-ui",
  "--font-mono",
];

function parseThemeRgb(v) {
  const raw = String(v || "").trim();
  let m = raw.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = raw.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map((x) => parseInt(x + x, 16));
  m = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

/** 由背景色亮度判断当前是深色还是浅色主题，写到 data-color-mode */
export function syncComputedColorMode() {
  try {
    const s = getComputedStyle(document.body);
    const rgb = parseThemeRgb(s.getPropertyValue("--bg")) || parseThemeRgb(s.backgroundColor);
    if (!rgb) return;
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const mode = lum < 145 ? "dark" : "light";
    document.documentElement.dataset.colorMode = mode;
    document.body.dataset.colorMode = mode;
  } catch {}
}

/** auto 跟随系统；inherit / 空 视为未知 */
export function resolveThemeIntent(t) {
  const raw = typeof t === "string" ? t.trim() : "";
  if (raw === "auto") return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "midnight" : "warm-paper";
  if (!raw || raw === "inherit") return "";
  return raw;
}

/** 主题自带深浅两套调色板时，按宿主声明的 appearance 选对应那套 */
function pickTheme(snap) {
  const palettes = snap && snap.palettes;
  if (snap && snap.appearance === "dark" && palettes?.dark?.cssUrl) return palettes.dark;
  if (snap && snap.appearance === "light" && palettes?.light?.cssUrl) return palettes.light;
  return { theme: snap?.theme, cssUrl: snap?.cssUrl };
}

function applyTheme(snap) {
  if (!snap) return;
  const picked = pickTheme(snap);
  const theme = resolveThemeIntent(picked.theme);
  if (theme && document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
  if (theme && document.body.dataset.hanaTheme !== theme) document.body.dataset.hanaTheme = theme;
  const cssUrl = typeof picked.cssUrl === "string" ? picked.cssUrl : "";
  if (cssUrl) {
    let link = document.getElementById(THEME_LINK_ID);
    if (!link) {
      link = document.createElement("link");
      link.id = THEME_LINK_ID;
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    if (link.getAttribute("href") !== cssUrl) {
      link.addEventListener("load", syncComputedColorMode, { once: true });
      link.setAttribute("href", cssUrl);
    }
  }
  requestAnimationFrame(syncComputedColorMode);
}

/** 从宿主窗口把当前主题的真值抄过来：主题名 + 它正在用的那套颜色。
 *  设置页当初就是卡在「宿主塞进 URL 的初值」上（那是默认主题，不是用户在用的），
 *  而宿主只在主题变化时才推送，推不到就永远错。直接读宿主窗口反而最可靠：
 *  它自己就是拿这些变量画的。读不到（不在宿主里、跳域）返回 null。 */
function readHostWindowTheme() {
  try {
    const hw = window.parent;
    if (!hw || hw === window) return null;
    const hd = hw.document;
    const root = hd && hd.documentElement;
    if (!root) return null;
    const cs = hw.getComputedStyle(root);
    const vars = {};
    for (const name of MIRROR_VARS) {
      const v = cs.getPropertyValue(name).trim();
      if (v) vars[name] = v;
    }
    const raw = (root.dataset.theme || (hd.body && hd.body.dataset.theme) || "").trim();
    let stored = "";
    try { stored = (hw.localStorage.getItem("hana-theme") || "").trim(); } catch {}
    const theme = resolveThemeIntent(raw || stored) || "";
    if (!Object.keys(vars).length && !theme) return null;
    return { vars, theme };
  } catch (e) {
    // 跨域 / 不在宿主里时读 window.parent.document 会直接抛，留个可查的痕迹
    try { window.__themeDiag = "host-window failed: " + (e && e.name) + ": " + (e && e.message); } catch {}
    return null;
  }
}

/** 把宿主窗口那套颜色与主题名写到当前文档上（inline 变量优先于任何主题表） */
function applyHostWindowTheme(m) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(m.vars)) root.style.setProperty(name, value);
  if (m.theme) {
    root.dataset.theme = m.theme;
    document.body.dataset.hanaTheme = m.theme;
  }
  // 背景不要自己画：保持透明，露出宿主窗口自己的底色（它已经是当前主题了）
  const old = document.getElementById(THEME_LINK_ID);
  if (old) old.remove();
  root.dataset.themeSource = "host-window";
  try { window.__themeDiag = "host-window ok: " + Object.keys(m.vars).length + " vars, theme=" + (m.theme || "-"); } catch {}
  syncComputedColorMode();
}

/** 盯着宿主窗口：它换主题（属性变化 / localStorage / 系统外观）就重新抄一遍 */
function watchHostWindow(refresh) {
  let timer = 0;
  let obs = null;
  try {
    const hw = window.parent;
    const hd = hw.document;
    obs = new MutationObserver(refresh);
    obs.observe(hd.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    if (hd.body) obs.observe(hd.body, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    hw.addEventListener("storage", refresh);
    hw.addEventListener("hana-settings", refresh);
    try { hw.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refresh); } catch {}
    timer = hw.setInterval(refresh, 500);
  } catch {}
  window.addEventListener(
    "beforeunload",
    () => {
      try { obs && obs.disconnect(); } catch {}
      try { window.parent.clearInterval(timer); } catch {}
    },
    { once: true }
  );
}

/** 读 iframe URL 里的初值（SDK 不可用时的兜底，也是首屏最快的一笔） */
function fromUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const cssUrl = p.get("hana-css") || "";
  const light = p.get("hana-palette-light-theme") && p.get("hana-palette-light-css") ? { theme: p.get("hana-palette-light-theme"), cssUrl: p.get("hana-palette-light-css") } : null;
  const dark = p.get("hana-palette-dark-theme") && p.get("hana-palette-dark-css") ? { theme: p.get("hana-palette-dark-theme"), cssUrl: p.get("hana-palette-dark-css") } : null;
  const raw = p.get("hana-theme-appearance");
  return {
    theme: p.get("hana-theme") || "",
    cssUrl,
    appearance: raw === "light" || raw === "dark" ? raw : undefined,
    palettes: light && dark ? { light, dark } : undefined,
  };
}

/** 跟随宿主主题；返回取消订阅的函数（页面卸载时用得上）
 *  优先级：宿主窗口的真实变量 > 宿主 SDK 下发的主题 > iframe URL 里的初值。
 *  第一档最可靠：那就是宿主当前正在用的颜色，不依赖宿主什么时候推、推不推。 */
export function initHostThemeSync() {
  let alive = true;
  const refresh = () => {
    if (!alive) return;
    try {
      const m = readHostWindowTheme();
      if (m) applyHostWindowTheme(m);
    } catch (e) {
      try { window.__themeDiag = String(e && e.name + ": " + e.message); } catch {}
    }
  };
  refresh();
  if (document.documentElement.dataset.themeSource === "host-window") {
    watchHostWindow(refresh);
    return () => { alive = false; };
  }
  try {
    hana.theme.subscribe((snap) => {
      if (alive) applyTheme(snap);
    });
  } catch {}
  // SDK 这条路也没走通（老宿主，或页面不在宿主里打开）时退回 URL 初值，至少不是裸样式
  setTimeout(() => {
    if (!alive) return;
    if (!document.getElementById(THEME_LINK_ID)) applyTheme(fromUrlParams());
  }, 600);
  return () => {
    alive = false;
  };
}
