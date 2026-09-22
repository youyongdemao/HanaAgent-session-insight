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

/** 跟随宿主主题；返回取消订阅的函数（页面卸载时用得上） */
export function initHostThemeSync() {
  let alive = true;
  try {
    hana.theme.subscribe((snap) => {
      if (alive) applyTheme(snap);
    });
  } catch {}
  // SDK 这条路没走通（老宿主或不在宿主里打开）时，退回 URL 初值，至少不是裸样式
  setTimeout(() => {
    if (!alive) return;
    if (!document.getElementById(THEME_LINK_ID)) applyTheme(fromUrlParams());
  }, 600);
  return () => {
    alive = false;
  };
}
