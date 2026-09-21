// assets/settings.js — Session Insight 设置页
// 必须 import SDK 并调用 hana.ready()：宿主收到这条 ready 消息才认页面就绪，
// 5 秒内收不到就一律显示「应用加载失败」（宿主对设置页传的 readyOnTimeout 为 false）。
// 只 import 而不调用 ready，页面会一直卡在失败态。
import { hana } from "./sdk.js";
import { apiFetch } from "./app-api.js";
import { initUpdateNotice, openUpdateNotice } from "./update-notice.js";

hana.ready();

// 保存后写一个一次性标记，卡片那边轮询到配置变化就重排
const BROADCAST_KEY = "si-live-layout";

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

/* ── 本地供应商：程序路径 ──
   启动按钮用哪个程序由后端定（默认安装目录 → 这里指定的），这一块只负责让用户指定与清除。 */
const localBlockEl = document.getElementById("stLocalBlock");
const localListEl = document.getElementById("stLocalList");
const localStatusEl = document.getElementById("stLocalStatus");

function setLocalStatus(text, cls = "") {
  if (!localStatusEl) return;
  localStatusEl.textContent = text;
  localStatusEl.className = "st-status" + (cls ? " " + cls : "");
}

function renderLocalProviders(providers) {
  if (!localBlockEl || !localListEl) return;
  if (!Array.isArray(providers) || providers.length === 0) {
    localBlockEl.hidden = true;
    return;
  }
  localBlockEl.hidden = false;
  localListEl.innerHTML = "";

  for (const provider of providers) {
    const li = document.createElement("li");
    li.className = "st-item";

    const main = document.createElement("div");
    main.className = "st-item-main";
    const title = document.createElement("div");
    title.className = "st-item-title";
    title.textContent = provider.name || provider.id;
    const desc = document.createElement("div");
    desc.className = "st-item-desc";
    const where = provider.source === "configured" ? "（你指定的）" : "";
    desc.textContent = provider.program
      ? provider.program + where
      : "还没指定程序，启动时会先让你选一个";
    main.append(title, desc);

    const ctl = document.createElement("div");
    ctl.className = "st-item-ctl";

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "st-btn st-btn-sm";
    pick.textContent = provider.program ? "重新选择…" : "选择程序…";
    pick.addEventListener("click", () => pickLocalProgram(provider, pick));
    ctl.append(pick);

    if (provider.source === "configured") {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "st-btn st-btn-sm";
      clear.textContent = "清除";
      clear.addEventListener("click", () => saveLocalProgram(provider.id, ""));
      ctl.append(clear);
    }

    li.append(main, ctl);
    localListEl.append(li);
  }
}

async function loadLocalProviders() {
  if (!localBlockEl) return;
  try {
    const data = await apiFetch("api/local-providers", {}, 20000);
    renderLocalProviders(data?.providers || []);
  } catch {
    /* 读不到就先不显示这一块，不打扰界面设置那边 */
  }
}

async function pickLocalProgram(provider, btn) {
  btn.disabled = true;
  try {
    const picked = await hana.resources.pick({ mode: "file" });
    const ref = picked && Array.isArray(picked.resources) ? picked.resources[0] : null;
    const path = (ref && (ref.path || ref.localPath)) || null;
    if (path) await saveLocalProgram(provider.id, path);
  } catch (error) {
    setLocalStatus("没能选择程序：" + String(error?.message || error), "err");
  } finally {
    btn.disabled = false;
  }
}

async function saveLocalProgram(providerId, path) {
  try {
    await apiFetch(
      "api/local-program",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: providerId, path }),
      },
      15000
    );
    setLocalStatus(path ? "已保存" : "已清除", "ok");
    window.setTimeout(() => {
      if (localStatusEl && /^已/.test(localStatusEl.textContent)) setLocalStatus("");
    }, 2400);
    await loadLocalProviders();
  } catch (error) {
    setLocalStatus("保存失败：" + String(error?.message || error), "err");
  }
}

loadLocalProviders();

/* ── 关于：版本、检查更新与源码仓库 ── */
const GITHUB_URL = "https://github.com/youyongdemao";
const aboutGithubEl = document.getElementById("aboutGithub");
const aboutVersionEl = document.getElementById("aboutVersion");
const aboutUpdateEl = document.getElementById("aboutUpdate");

function openExternal(url) {
  const fallback = () => window.open(url, "_blank", "noopener");
  try {
    const opened = hana.external.open({ url });
    if (opened && typeof opened.catch === "function") opened.catch(fallback);
  } catch {
    fallback();
  }
}

// 设置页自己秀一个本地版本号（纯本地，不联网）
async function loadVersion() {
  try {
    const info = await apiFetch("api/version");
    if (aboutVersionEl && info?.version) aboutVersionEl.textContent = "v" + info.version;
  } catch {
    /* 读不到就保持占位 */
  }
}

loadVersion();

// 「更新」按钮打开检查更新弹窗（窗口自己会查）。
// 弹窗本体、自检逻辑与另外两个页面共用 update-notice.js。
aboutUpdateEl?.addEventListener("click", () => openUpdateNotice());
initUpdateNotice();

aboutGithubEl?.addEventListener("click", (ev) => {
  // 拦下默认行为，改走宿主的外部打开能力。
  // v2 App 不能拉起外部进程，/api/open 在 App 里已降级为空操作，
  // 所以把地址交给系统默认浏览器只能靠这一条。
  ev.preventDefault();
  openExternal(GITHUB_URL);
});