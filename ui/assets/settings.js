// assets/settings.js — Session Insight 设置页
// 必须 import SDK 并调用 hana.ready()：宿主收到这条 ready 消息才认页面就绪，
// 5 秒内收不到就一律显示「应用加载失败」（宿主对设置页传的 readyOnTimeout 为 false）。
// 只 import 而不调用 ready，页面会一直卡在失败态。
import { hana } from "./sdk.js";
import { apiFetch } from "./app-api.js";
import { initUpdateNotice, openUpdateNotice } from "./update-notice.js";
import { initHostThemeSync } from "./theme-sync.js";

initHostThemeSync();
hana.ready();

// 保存后写一个一次性标记，卡片那边轮询到配置变化就重排
const BROADCAST_KEY = "si-live-layout";

const listEl = document.getElementById("stList");

let items = [];   // [{id,label,group,desc}]
let onSet = new Set();

/**
 * 每个小节自己一套「保存 / 恢复默认 / 状态」：脏标记、按钮禁用与状态文字各管各的，
 * 改了一块不会把另一块的保存按钮也点亮。
 */
function makeSaver(saveId, statusId) {
  const saveEl = document.getElementById(saveId);
  const statusEl = document.getElementById(statusId);
  const setStatus = (text, cls = "") => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = "st-status" + (cls ? " " + cls : "");
  };
  if (saveEl) saveEl.disabled = true;
  return {
    saveEl,
    setStatus,
    markDirty() {
      if (saveEl) saveEl.disabled = false;
      setStatus("");
    },
    // 设置写进 App 配置后，已挂载的界面不一定立刻反映出来，提示一句要重载插件
    saved(msg = "已保存 · 需重载插件生效") {
      if (saveEl) saveEl.disabled = true;
      setStatus(msg, "ok");
      window.setTimeout(() => {
        if (statusEl && statusEl.textContent === msg) setStatus("");
      }, 3600);
    },
    failed(error) {
      if (saveEl) saveEl.disabled = false;
      setStatus("保存失败：" + String(error?.message || error), "err");
    },
  };
}

const liveCtl = makeSaver("stSaveLive", "stStatusLive");
const widgetCtl = makeSaver("stSaveWidget", "stStatusWidget");
const homeCtl = makeSaver("stSaveHome", "stStatusHome");

function render() {
  listEl.innerHTML = "";
  for (const it of items) {
    listEl.append(
      makeToggleRow({
        label: it.label,
        desc: it.desc,
        checked: onSet.has(it.id),
        onChange: (on) => {
          if (on) onSet.add(it.id);
          else onSet.delete(it.id);
          liveCtl.markDirty();
        },
      })
    );
  }
}

/** 顺序由清单本身决定，这里只管开关，保存时用 items 自带的顺序。 */
function currentOrder() {
  return items.map((it) => it.id);
}

async function load() {
  try {
    const cfg = await apiFetch("api/live-config");
    items = cfg.items || [];
    const order = Array.isArray(cfg.order) ? cfg.order : items.map((i) => i.id);
    const known = new Map(items.map((i) => [i.id, i]));
    // 按持久化顺序排列；后端已补齐新增项，这里再兜一层
    items = order.filter((id) => known.has(id)).map((id) => known.get(id));
    for (const it of known.values()) if (!items.includes(it)) items.push(it);
    onSet = new Set(cfg.on || []);
    render();
    liveCtl.setStatus("");
  } catch (error) {
    liveCtl.setStatus("读取配置失败：" + String(error?.message || error), "err");
  }
}

/* ── 本轮速览：保存与恢复默认 ── */
liveCtl.saveEl?.addEventListener("click", async () => {
  liveCtl.setStatus("保存中…");
  try {
    await apiFetch("api/live-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: currentOrder(), on: [...onSet] }),
    });
    liveCtl.saved();
    // 输入栏那边开着时接到广播就地重排
    try {
      localStorage.setItem(BROADCAST_KEY, String(Date.now()));
    } catch {
      /* 广播失败不影响保存结果 */
    }
  } catch (error) {
    liveCtl.failed(error);
  }
});

document.getElementById("stResetLive")?.addEventListener("click", async () => {
  liveCtl.setStatus("恢复中…");
  try {
    // 空对象走后端默认分支：五项全开
    const cfg = await apiFetch("api/live-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    items = cfg.items || items;
    const known = new Map(items.map((i) => [i.id, i]));
    items = (cfg.order || []).filter((id) => known.has(id)).map((id) => known.get(id));
    onSet = new Set(cfg.on || []);
    render();
    liveCtl.saved("已恢复默认 · 需重载插件生效");
    try {
      localStorage.setItem(BROADCAST_KEY, String(Date.now()));
    } catch {
      /* 同上 */
    }
  } catch (error) {
    liveCtl.setStatus("恢复失败：" + String(error?.message || error), "err");
  }
});

load();

/* ── 工作台首页：用量页还是 API 管理页 ──
   只决定「打开时先停在哪个页面」，读不到或没设过就按默认用量页。 */
const homeViewEl = document.getElementById("stHomeView");
let homeView = "usage";

function renderHomeView() {
  if (!homeViewEl) return;
  const picked = homeViewEl.querySelector('input[name="homeView"][value="' + homeView + '"]');
  if (picked) picked.checked = true;
}

// 点卡片由 label + radio 自己完成，这里只接状态变化
homeViewEl?.addEventListener("change", (e) => {
  const input = e.target.closest('input[name="homeView"]');
  if (!input || input.value === homeView) return;
  homeView = input.value;
  homeCtl.markDirty();
});

async function loadHomeView() {
  if (!homeViewEl) return;
  try {
    const prefs = await apiFetch("api/panel-prefs");
    homeView = prefs?.homeView === "api" ? "api" : "usage";
    renderHomeView();
    homeCtl.setStatus("");
  } catch {
    /* 读不到就按默认，不打扰其它设置项 */
  }
}

homeCtl.saveEl?.addEventListener("click", async () => {
  homeCtl.setStatus("保存中…");
  try {
    await apiFetch("api/panel-prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeView }),
    });
    homeCtl.saved();
  } catch (error) {
    homeCtl.failed(error);
  }
});

loadHomeView();

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

/** 一行开关：本轮速览与实时用量共用（带子项样式时给 sub: true） */
function makeToggleRow({ label, desc, checked, sub, onChange }) {
  const li = document.createElement("li");
  li.className = "st-item" + (checked ? "" : " off") + (sub ? " sub" : "");

  const main = document.createElement("div");
  main.className = "st-item-main";
  const title = document.createElement("div");
  title.className = "st-item-title";
  title.textContent = label;
  main.append(title);
  if (desc) {
    const d = document.createElement("div");
    d.className = "st-item-desc";
    d.textContent = desc;
    main.append(d);
  }

  const ctl = document.createElement("div");
  ctl.className = "st-item-ctl";
  const sw = document.createElement("label");
  sw.className = "st-sw";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.setAttribute("aria-label", label);
  // 变灰的视觉只在这一处改，调用方只管状态
  cb.addEventListener("change", () => {
    li.classList.toggle("off", !cb.checked);
    onChange(cb.checked);
  });
  const track = document.createElement("i");
  sw.append(cb, track);
  ctl.append(sw);

  li.append(main, ctl);
  return li;
}

/**
 * 实时用量：同 group 的区块挂在一个母项下——母项一个开关管全部，子项各自可调。
 * 母项与其它未分组项同级。
 */
function renderWidgetTable() {
  if (!wBodyEl) return;
  wBodyEl.innerHTML = "";
  const rendered = new Set();

  for (const b of wBlocks) {
    if (rendered.has(b.id)) continue;

    if (!b.group) {
      rendered.add(b.id);
      wBodyEl.append(
        makeToggleRow({
          label: b.label,
          desc: b.desc,
          checked: wOnSet.has(b.id),
          onChange: (on) => {
            if (on) wOnSet.add(b.id);
            else wOnSet.delete(b.id);
            widgetCtl.markDirty();
          },
        })
      );
      continue;
    }

    const siblings = wBlocks.filter((x) => x.group === b.group);
    for (const x of siblings) rendered.add(x.id);

    wBodyEl.append(
      makeToggleRow({
        label: b.group,
        checked: siblings.every((x) => wOnSet.has(x.id)),
        onChange: (on) => {
          for (const x of siblings) {
            if (on) wOnSet.add(x.id);
            else wOnSet.delete(x.id);
          }
          widgetCtl.markDirty();
          renderWidgetTable();
        },
      })
    );

    for (const x of siblings) {
      wBodyEl.append(
        makeToggleRow({
          label: x.label,
          desc: x.desc,
          checked: wOnSet.has(x.id),
          sub: true,
          onChange: (on) => {
            if (on) wOnSet.add(x.id);
            else wOnSet.delete(x.id);
            // 子项单独改了，母项的「全开/全关」跟着变，所以整块重画一次
            widgetCtl.markDirty();
            renderWidgetTable();
          },
        })
      );
    }
  }
}

async function loadWidgetConfig() {
  if (!wBodyEl) return;
  try {
    const cfg = await apiFetch("api/widget-config");
    wBlocks = cfg.blocks || [];
    wOnSet = new Set(cfg.on || []);
    renderWidgetTable();
    widgetCtl.setStatus("");
  } catch (error) {
    widgetCtl.setStatus("读取实时用量配置失败：" + String(error?.message || error), "err");
  }
}

/* ── 实时用量：保存与恢复默认 ── */
widgetCtl.saveEl?.addEventListener("click", async () => {
  widgetCtl.setStatus("保存中…");
  try {
    await apiFetch("api/widget-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: [...wOnSet] }),
    });
    widgetCtl.saved();
    broadcastWidgetLayout();
  } catch (error) {
    widgetCtl.failed(error);
  }
});

document.getElementById("stResetWidget")?.addEventListener("click", async () => {
  widgetCtl.setStatus("恢复中…");
  try {
    // 空对象走后端默认分支：区块全开
    const wcfg = await apiFetch("api/widget-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    wBlocks = wcfg.blocks || wBlocks;
    wOnSet = new Set(wcfg.on || []);
    renderWidgetTable();
    widgetCtl.saved("已恢复默认 · 需重载插件生效");
    broadcastWidgetLayout();
  } catch (error) {
    widgetCtl.setStatus("恢复失败：" + String(error?.message || error), "err");
  }
});

// 保存由「界面设置」底部的按钮统管（见上），这里不再单设。

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

/** 两类内容共用一个列表：本地程序路径（program）+ 额度查询凭据（cred）。
 *  清理时只删自己那一类，任一类有内容就显示这一块。 */
function clearProviderRows(kind) {
  if (!localListEl) return;
  [...localListEl.querySelectorAll('[data-kind="' + kind + '"]')].forEach((el) => el.remove());
}

function syncProviderBlock() {
  if (!localBlockEl) return;
  localBlockEl.hidden = !localListEl || localListEl.children.length === 0;
}

function renderLocalProviders(providers) {
  if (!localBlockEl || !localListEl) return;
  clearProviderRows("program");
  for (const provider of providers || []) {
    const li = document.createElement("li");
    li.className = "st-item";
    li.dataset.kind = "program";

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
      : "未指定程序，启动时将提示选择";
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
  syncProviderBlock();
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
    setLocalStatus("无法选择程序：" + String(error?.message || error), "err");
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

/* ── 额度查询凭据（并入「供应商设置」同一块）──
   主 API Key 查不到余额的那几家（OpenAI Admin Key、xAI Management Key + Team ID、火山 AK/SK）
   在这里单独配。后端只返回用户已经添加过的供应商，没添加的不出现。 */

function setCredStatus(text, cls = "") {
  if (!localStatusEl) return;
  localStatusEl.textContent = text;
  localStatusEl.className = "st-status" + (cls ? " " + cls : "");
}

async function saveQueryCredential(providerId, keyId, value, btn) {
  if (btn) btn.disabled = true;
  try {
    await apiFetch(
      "api/query-credentials",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: providerId, key: keyId, value }),
      },
      15000
    );
    setCredStatus(value ? "已保存" : "已清除", "ok");
    window.setTimeout(() => {
      if (localStatusEl && /^已/.test(localStatusEl.textContent)) setCredStatus("");
    }, 2400);
    await loadQueryCredentials();
  } catch (error) {
    setCredStatus("保存失败：" + String(error?.message || error), "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderQueryCredentials(providers) {
  if (!localListEl) return;
  const rows = [];
  for (const p of providers || []) for (const k of p.keys || []) rows.push({ p, k });
  clearProviderRows("cred");

  for (const { p, k } of rows) {
    const li = document.createElement("li");
    li.className = "st-item";
    li.dataset.kind = "cred";

    const main = document.createElement("div");
    main.className = "st-item-main";
    const title = document.createElement("div");
    title.className = "st-item-title";
    title.textContent = p.name + " · " + k.label;
    const desc = document.createElement("div");
    desc.className = "st-item-desc";
    desc.textContent = k.configured ? "已配置" : (k.desc || p.via || "未配置");
    main.append(title, desc);

    const ctl = document.createElement("div");
    ctl.className = "st-item-ctl";

    const input = document.createElement("input");
    input.type = k.secret ? "password" : "text";
    input.className = "st-cred-input";
    input.autocomplete = "off";
    input.placeholder = k.configured ? "重新输入以覆盖" : "粘贴 " + k.label;

    const save = document.createElement("button");
    save.type = "button";
    save.className = "st-btn st-btn-sm";
    save.textContent = "保存";
    save.addEventListener("click", () => saveQueryCredential(p.id, k.id, input.value, save));

    ctl.append(input, save);

    if (k.configured) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "st-btn st-btn-sm";
      clear.textContent = "清除";
      clear.addEventListener("click", () => saveQueryCredential(p.id, k.id, "", clear));
      ctl.append(clear);
    }

    li.append(main, ctl);
    localListEl.append(li);
  }
  syncProviderBlock();
}

async function loadQueryCredentials() {
  if (!localListEl) return;
  try {
    const data = await apiFetch("api/query-credentials", {}, 15000);
    const providers = data?.providers || [];
    credSig = credSignature(providers);
    renderQueryCredentials(providers);
  } catch {
    /* 读不到就先不显示这一部分，不打扰界面设置那边 */
  }
}

/* 跟供应商配置走：宿主里增删供应商或改了凭据，这里最多 4 秒跟着变。
   只比指纹，指纹没变就不重画；万一输入框里还写着没保存的内容，也不去动它。 */
let credSig = null;
function credSignature(providers) {
  return (providers || [])
    .map((p) => p.id + ":" + (p.keys || []).map((k) => k.id + (k.configured ? "1" : "0")).join(","))
    .join("|");
}

loadQueryCredentials();

async function pollQueryCredentials() {
  if (!localListEl || document.hidden) return;
  try {
    const data = await apiFetch("api/query-credentials", {}, 15000);
    const providers = data?.providers || [];
    const sig = credSignature(providers);
    if (sig === credSig) return;
    const typing = [...localListEl.querySelectorAll("input")].some((i) => i.value.trim());
    if (typing) return;
    credSig = sig;
    renderQueryCredentials(providers);
  } catch {
    /* 轮询失败就算了，下一轮再试 */
  }
}

window.setInterval(pollQueryCredentials, 4000);

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