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

async function apiFetch(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (ss) headers.set("X-Hana-App-Surface-Session", ss);
  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    signal: AbortSignal.timeout(8000),
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

/* ── 关于：检查更新与源码仓库（原工作台顶部两个按钮搬到这里）── */
const GITHUB_URL = "https://github.com/youyongdemao";
const aboutUpdateEl = document.getElementById("aboutUpdate");
const aboutGithubEl = document.getElementById("aboutGithub");
const aboutVersionEl = document.getElementById("aboutVersion");
const aboutStatusEl = document.getElementById("aboutStatus");
let pendingVersion = null;

function setAboutStatus(text, cls = "") {
  if (!aboutStatusEl) return;
  aboutStatusEl.textContent = text;
  aboutStatusEl.className = "st-status" + (cls ? " " + cls : "");
}

async function checkUpdate() {
  aboutUpdateEl.disabled = true;
  setAboutStatus("检查中…");
  try {
    const info = await apiFetch("api/check-update");
    if (aboutVersionEl && info?.currentVersion) aboutVersionEl.textContent = info.currentVersion;
    if (!info?.updateAvailable) {
      setAboutStatus("已是最新版本", "ok");
      window.setTimeout(() => {
        if (aboutStatusEl?.textContent === "已是最新版本") setAboutStatus("");
      }, 2400);
      return;
    }
    pendingVersion = info.latestVersion;
    aboutUpdateEl.textContent = "更新到 v" + info.latestVersion;
    setAboutStatus("发现新版本 v" + info.latestVersion);
  } catch (error) {
    setAboutStatus("检查失败：" + String(error?.message || error), "err");
  } finally {
    aboutUpdateEl.disabled = false;
  }
}

async function applyUpdateNow() {
  aboutUpdateEl.disabled = true;
  setAboutStatus("更新中…");
  try {
    const headers = { "content-type": "application/json" };
    if (ss) headers["X-Hana-App-Surface-Session"] = ss;
    const res = await fetch(apiUrl("api/apply-update"), {
      method: "POST",
      headers,
      body: JSON.stringify({ version: pendingVersion }),
      signal: AbortSignal.timeout(120000),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || !result.ok) throw new Error(result.error || "HTTP " + res.status);
    setAboutStatus("已更新，正在重新加载…", "ok");
    const next = new URL(location.href);
    next.searchParams.set("hot", Date.now().toString(36));
    location.replace(next.toString());
  } catch (error) {
    aboutUpdateEl.disabled = false;
    setAboutStatus("更新失败：" + String(error?.message || error), "err");
  }
}

aboutUpdateEl?.addEventListener("click", () => {
  if (pendingVersion) applyUpdateNow();
  else checkUpdate();
});

aboutGithubEl?.addEventListener("click", (ev) => {
  // 拦下默认行为，改走宿主的外链能力：iframe 沙箱下直接新开标签可能被拦
  ev.preventDefault();
  try {
    hana.external.open({ url: GITHUB_URL });
  } catch {
    window.open(GITHUB_URL, "_blank", "noopener");
  }
});