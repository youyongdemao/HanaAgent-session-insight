// assets/settings.js — Session Insight 设置页
// 必须 import SDK 并调用 hana.ready()：宿主收到这条 ready 消息才认页面就绪，
// 5 秒内收不到就一律显示「应用加载失败」（宿主对设置页传的 readyOnTimeout 为 false）。
// 只 import 而不调用 ready，页面会一直卡在失败态。
import { hana } from "./sdk.js";

hana.ready();

const APP_ID = "session-insight-v2";
const ss = new URLSearchParams(location.search).get("appSurfaceSession") || "";
// 保存后写一个一次性标记，卡片那边轮询到配置变化就重排
const BROADCAST_KEY = "si-live-layout";

function apiUrl(path) {
  return `${location.origin}/api/apps/${APP_ID}/routes/${path}`;
}

async function apiFetch(path, init = {}, timeoutMs = 8000) {
  const headers = new Headers(init.headers || {});
  if (ss) headers.set("X-Hana-App-Surface-Session", ss);
  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : null;
}

const listEl = document.getElementById("stList");
const saveEl = document.getElementById("stSave");
const resetEl = document.getElementById("stReset");
const statusEl = document.getElementById("stStatus");

let items = [];   // [{id,label,group,desc}]
let onSet = new Set();
let dirty = false;

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = "st-status" + (cls ? " " + cls : "");
}

function markDirty() {
  dirty = true;
  saveEl.disabled = false;
  setStatus("");
}

function render() {
  listEl.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "st-item" + (onSet.has(it.id) ? "" : " off");
    li.dataset.id = it.id;

    const main = document.createElement("div");
    main.className = "st-item-main";
    const title = document.createElement("div");
    title.className = "st-item-title";
    title.textContent = it.label;
    const desc = document.createElement("div");
    desc.className = "st-item-desc";
    desc.textContent = it.desc || "";
    main.append(title, desc);

    const ctl = document.createElement("div");
    ctl.className = "st-item-ctl";
    const sw = document.createElement("label");
    sw.className = "st-sw";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = onSet.has(it.id);
    cb.setAttribute("aria-label", it.label);
    cb.addEventListener("change", () => {
      if (cb.checked) onSet.add(it.id);
      else onSet.delete(it.id);
      li.classList.toggle("off", !cb.checked);
      markDirty();
    });
    const track = document.createElement("i");
    sw.append(cb, track);
    ctl.append(sw);

    li.append(main, ctl);
    listEl.append(li);
  }
}

/** 顺序由清单本身决定，这里只管开关，保存时用 items 自带的顺序。 */
function currentOrder() {
  return items.map((it) => it.id);
}

async function load() {
  saveEl.disabled = true;
  try {
    const cfg = await apiFetch("api/live-config");
    items = cfg.items || [];
    const order = Array.isArray(cfg.order) ? cfg.order : items.map((i) => i.id);
    const known = new Map(items.map((i) => [i.id, i]));
    // 按持久化顺序排列；后端已补齐新增项，这里再兜一层
    items = order.filter((id) => known.has(id)).map((id) => known.get(id));
    for (const it of known.values()) if (!items.includes(it)) items.push(it);
    onSet = new Set(cfg.on || []);
    dirty = false;
    render();
    setStatus("");
  } catch (error) {
    setStatus("读取配置失败：" + String(error?.message || error), "err");
  }
}

saveEl.addEventListener("click", async () => {
  saveEl.disabled = true;
  setStatus("保存中…");
  try {
    // 界面设置两块一起提交：本轮速览（输入栏五项）与实时用量（卡片区块）。
    // 两块共用一个保存键，避免出现“按了保存只存了一半”。
    await apiFetch("api/live-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: currentOrder(), on: [...onSet] }),
    });
    await apiFetch("api/widget-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: [...wOnSet] }),
    });
    dirty = false;
    setStatus("已保存", "ok");
    broadcastWidgetLayout();
    try {
      localStorage.setItem(BROADCAST_KEY, String(Date.now()));
    } catch {
      /* 广播失败不影响保存结果 */
    }
    window.setTimeout(() => {
      if (statusEl.textContent === "已保存") setStatus("");
    }, 2400);
  } catch (error) {
    saveEl.disabled = false;
    setStatus("保存失败：" + String(error?.message || error), "err");
  }
});

resetEl.addEventListener("click", async () => {
  saveEl.disabled = true;
  setStatus("恢复中…");
  try {
    // 空对象走后端默认分支：两块都回到默认（全部显示）
    const cfg = await apiFetch("api/live-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    items = cfg.items || items;
    const known = new Map(items.map((i) => [i.id, i]));
    items = (cfg.order || []).filter((id) => known.has(id)).map((id) => known.get(id));
    onSet = new Set(cfg.on || []);

    const wcfg = await apiFetch("api/widget-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    wBlocks = wcfg.blocks || wBlocks;
    wOnSet = new Set(wcfg.on || []);

    dirty = false;
    render();
    renderWidgetTable();
    setStatus("已恢复默认", "ok");
    broadcastWidgetLayout();
    try {
      localStorage.setItem(BROADCAST_KEY, String(Date.now()));
    } catch {
      /* 同上 */
    }
  } catch (error) {
    saveEl.disabled = false;
    setStatus("恢复失败：" + String(error?.message || error), "err");
  }
});

load();

/* ── 实时用量：卡片内各区块的开关（含分组子项）── */
const W_BROADCAST_KEY = "si-widget-layout";
const wBodyEl = document.getElementById("wTableBody");

let wBlocks = [];
let wOnSet = new Set();

function broadcastWidgetLayout() {
  try {
    localStorage.setItem(W_BROADCAST_KEY, String(Date.now()));
  } catch {
    /* 广播失败不影响保存结果 */
  }
}

function renderWidgetTable() {
  if (!wBodyEl) return;
  wBodyEl.innerHTML = "";
  for (const b of wBlocks) {
    const li = document.createElement("li");
    li.className = "st-item" + (wOnSet.has(b.id) ? "" : " off");

    const main = document.createElement("div");
    main.className = "st-item-main";
    const title = document.createElement("div");
    title.className = "st-item-title";
    title.textContent = b.label;
    const desc = document.createElement("div");
    desc.className = "st-item-desc";
    desc.textContent = b.desc || "";
    main.append(title, desc);

    const ctl = document.createElement("div");
    ctl.className = "st-item-ctl";
    const sw = document.createElement("label");
    sw.className = "st-sw";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = wOnSet.has(b.id);
    cb.setAttribute("aria-label", b.label);
    cb.addEventListener("change", () => {
      if (cb.checked) wOnSet.add(b.id);
      else wOnSet.delete(b.id);
      li.classList.toggle("off", !cb.checked);
      markDirty();
    });
    const track = document.createElement("i");
    sw.append(cb, track);
    ctl.append(sw);

    li.append(main, ctl);
    wBodyEl.append(li);
  }
}

async function loadWidgetConfig() {
  if (!wBodyEl) return;
  try {
    const cfg = await apiFetch("api/widget-config");
    wBlocks = cfg.blocks || [];
    wOnSet = new Set(cfg.on || []);
    renderWidgetTable();
  } catch (error) {
    setStatus("读取实时用量配置失败：" + String(error?.message || error), "err");
  }
}

// 保存与恢复默认都由「界面设置」底部那一对按钮统管（见上），这里不再单设。

loadWidgetConfig();

/* ── 关于：版本、更新与源码仓库 ── */
const GITHUB_URL = "https://github.com/youyongdemao";
const aboutGithubEl = document.getElementById("aboutGithub");
const aboutVersionEl = document.getElementById("aboutVersion");
const aboutUpdateEl = document.getElementById("aboutUpdate");
const aboutNoteEl = document.getElementById("aboutVersionNote");

// 检查更新走 GitHub Release，比对本地清单里的版本号；
// 装新版本仍走「设置 → 扩展」——应用的安装目录对自己只读，改不了自己。
async function loadVersion() {
  try {
    const info = await apiFetch("api/version");
    if (aboutVersionEl && info?.version) aboutVersionEl.textContent = "v" + info.version;
  } catch {
    /* 读不到就保持占位 */
  }
}

function setNote(text, cls = "") {
  if (!aboutNoteEl) return;
  aboutNoteEl.textContent = text;
  aboutNoteEl.className = "st-item-desc" + (cls ? " " + cls : "");
  aboutNoteEl.hidden = !text;
}

function idleButton() {
  if (!aboutUpdateEl) return;
  aboutUpdateEl.disabled = false;
  aboutUpdateEl.className = "st-btn st-btn-sm";
  aboutUpdateEl.textContent = "更新";
}

/** "2026-09-22T01:00:00Z" → "9/22"（本地时区） */
function shortDate(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getMonth() + 1}/${at.getDate()}`;
}

// 最近一次检查的结论；按钮第二下要用它决定是“去下载”还是“再查一次”
let updateInfo = null;

function showAvailable(info) {
  updateInfo = info;
  if (!aboutUpdateEl) return;
  aboutUpdateEl.disabled = false;
  aboutUpdateEl.className = "st-btn st-btn-sm st-btn-primary";
  aboutUpdateEl.textContent = `更新到 v${info.latestVersion}`;
  const at = info.publishedAt ? " · " + shortDate(info.publishedAt) : "";
  setNote(`新版本 v${info.latestVersion}${at}`);
}

function openExternal(url) {
  const fallback = () => window.open(url, "_blank", "noopener");
  try {
    const opened = hana.external.open({ url });
    if (opened && typeof opened.catch === "function") opened.catch(fallback);
  } catch {
    fallback();
  }
}

async function runUpdateCheck() {
  if (!aboutUpdateEl) return;
  aboutUpdateEl.disabled = true;
  aboutUpdateEl.textContent = "检查中…";
  setNote("");

  let info = null;
  try {
    info = await apiFetch("api/update-check", {}, 14000);
  } catch (error) {
    idleButton();
    setNote("检查更新失败：" + String(error?.message || error), "err");
    return;
  }

  if (!info?.ok) {
    idleButton();
    setNote("检查更新失败：" + (info?.message || "未知错误"), "err");
    return;
  }

  if (info.updateAvailable) {
    showAvailable(info);
    return;
  }

  updateInfo = info;
  aboutUpdateEl.disabled = true;
  aboutUpdateEl.textContent = "已是最新";
  setNote(`v${info.currentVersion} 已是最新`);
  window.setTimeout(() => {
    if (aboutUpdateEl.textContent === "已是最新") {
      idleButton();
      setNote("");
    }
  }, 2400);
}

loadVersion().then(() => {
  // 打开设置页时静默查一次：有新版本就把按钮直接摆成可更新的样子，没有就当没发生过
  apiFetch("api/update-check", {}, 14000)
    .then((info) => {
      if (info?.ok && info.updateAvailable) showAvailable(info);
    })
    .catch(() => {
      /* 后台静默检查，失败不打扰 */
    });
});

aboutUpdateEl?.addEventListener("click", () => {
  if (updateInfo?.updateAvailable) {
    openExternal(updateInfo.url);
    setNote(`已在浏览器打开 v${updateInfo.latestVersion}，下载后在「扩展」里重新安装`);
    return;
  }
  runUpdateCheck();
});

aboutGithubEl?.addEventListener("click", (ev) => {
  // 拦下默认行为，改走宿主的外部打开能力。
  // v2 App 不能拉起外部进程，/api/open 在 App 里已降级为空操作，
  // 所以把地址交给系统默认浏览器只能靠这一条。
  ev.preventDefault();
  openExternal(GITHUB_URL);
});