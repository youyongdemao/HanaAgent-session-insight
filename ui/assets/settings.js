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
    const tr = document.createElement("tr");
    tr.className = "st-trow" + (onSet.has(it.id) ? "" : " off");
    tr.dataset.id = it.id;

    const name = document.createElement("td");
    name.className = "st-tname";
    name.textContent = it.label;

    const desc = document.createElement("td");
    desc.className = "st-tdesc";
    desc.textContent = it.desc || "";

    const swCell = document.createElement("td");
    swCell.className = "st-col-sw";
    const sw = document.createElement("label");
    sw.className = "st-sw";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = onSet.has(it.id);
    cb.setAttribute("aria-label", it.label);
    cb.addEventListener("change", () => {
      if (cb.checked) onSet.add(it.id);
      else onSet.delete(it.id);
      tr.classList.toggle("off", !cb.checked);
      markDirty();
    });
    const track = document.createElement("i");
    sw.append(cb, track);
    swCell.append(sw);

    tr.append(name, desc, swCell);
    listEl.append(tr);
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
    const payload = { order: currentOrder(), on: [...onSet] };
    await apiFetch("api/live-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    dirty = false;
    setStatus("已保存", "ok");
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
    // 空对象走后端默认分支：回到"单轮六项"
    const cfg = await apiFetch("api/live-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    items = cfg.items || items;
    const known = new Map(items.map((i) => [i.id, i]));
    items = (cfg.order || []).filter((id) => known.has(id)).map((id) => known.get(id));
    onSet = new Set(cfg.on || []);
    dirty = false;
    render();
    setStatus("已恢复默认", "ok");
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
const wSaveEl = document.getElementById("wSave");
const wResetEl = document.getElementById("wReset");
const wStatusEl = document.getElementById("wStatus");

let wBlocks = [];
let wOnSet = new Set();

function setWStatus(text, cls = "") {
  if (!wStatusEl) return;
  wStatusEl.textContent = text;
  wStatusEl.className = "st-status" + (cls ? " " + cls : "");
}

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
  let lastGroup = null;
  for (const b of wBlocks) {
    if (b.group && b.group !== lastGroup) {
      lastGroup = b.group;
      const gr = document.createElement("tr");
      gr.className = "st-group-row";
      const gd = document.createElement("td");
      gd.colSpan = 3;
      gd.textContent = b.group;
      gr.append(gd);
      wBodyEl.append(gr);
    }
    const tr = document.createElement("tr");
    tr.className = "st-trow" + (wOnSet.has(b.id) ? "" : " off");

    const tdName = document.createElement("td");
    tdName.className = "st-tname" + (b.group ? " is-child" : "");
    tdName.textContent = b.label;

    const tdDesc = document.createElement("td");
    tdDesc.className = "st-tdesc";
    tdDesc.textContent = b.desc || "";

    const tdSw = document.createElement("td");
    tdSw.className = "st-col-sw";
    const sw = document.createElement("label");
    sw.className = "st-sw";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = wOnSet.has(b.id);
    cb.setAttribute("aria-label", b.label);
    cb.addEventListener("change", () => {
      if (cb.checked) wOnSet.add(b.id);
      else wOnSet.delete(b.id);
      tr.classList.toggle("off", !cb.checked);
      if (wSaveEl) wSaveEl.disabled = false;
      setWStatus("");
    });
    const track = document.createElement("i");
    sw.append(cb, track);
    tdSw.append(sw);

    tr.append(tdName, tdDesc, tdSw);
    wBodyEl.append(tr);
  }
}

async function loadWidgetConfig() {
  if (!wBodyEl) return;
  if (wSaveEl) wSaveEl.disabled = true;
  try {
    const cfg = await apiFetch("api/widget-config");
    wBlocks = cfg.blocks || [];
    wOnSet = new Set(cfg.on || []);
    renderWidgetTable();
    setWStatus("");
  } catch (error) {
    setWStatus("读取配置失败：" + String(error?.message || error), "err");
  }
}

wSaveEl?.addEventListener("click", async () => {
  wSaveEl.disabled = true;
  setWStatus("保存中…");
  try {
    const cfg = await apiFetch("api/widget-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: [...wOnSet] }),
    });
    if (cfg && Array.isArray(cfg.on)) wOnSet = new Set(cfg.on);
    setWStatus("已保存", "ok");
    broadcastWidgetLayout();
    window.setTimeout(() => {
      if (wStatusEl?.textContent === "已保存") setWStatus("");
    }, 2400);
  } catch (error) {
    wSaveEl.disabled = false;
    setWStatus("保存失败：" + String(error?.message || error), "err");
  }
});

wResetEl?.addEventListener("click", async () => {
  wSaveEl.disabled = true;
  setWStatus("恢复中…");
  try {
    const cfg = await apiFetch("api/widget-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    wBlocks = cfg.blocks || wBlocks;
    wOnSet = new Set(cfg.on || []);
    renderWidgetTable();
    setWStatus("已恢复默认", "ok");
    broadcastWidgetLayout();
  } catch (error) {
    wSaveEl.disabled = false;
    setWStatus("恢复失败：" + String(error?.message || error), "err");
  }
});

loadWidgetConfig();
