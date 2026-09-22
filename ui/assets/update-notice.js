// assets/update-notice.js — 检查更新弹窗（工作台 / 实时用量 / 设置页共用）
// 进页面自检一次：有新版才弹，没有就什么都不做。窗里写明版本与更新日志，并可跳到下载页。
// 弹窗尺寸跟着宿主给的空间走：空间不够先压更新日志区，按钮始终留在窗内。
import { hana } from "./sdk.js";
import { apiFetch } from "./app-api.js";

const RELEASE_PAGE_URL = "https://github.com/youyongdemao/HanaAgent-session-insight/releases/latest";

let modalEl = null;
let releaseUrl = RELEASE_PAGE_URL;
let currentVersion = "";

/** "2026-09-22T01:00:00Z" → "9/22"（本地时区） */
function shortDate(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getMonth() + 1}/${at.getDate()}`;
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

function build() {
  const wrap = document.createElement("div");
  wrap.className = "si-upd";
  wrap.id = "siUpdateModal";
  wrap.hidden = true;
  // 静态骨架，没有外部数据，用 innerHTML 比逐个 createElement 好读
  wrap.innerHTML = `
    <div class="si-upd-mask" data-si-upd-close></div>
    <div class="si-upd-card" role="dialog" aria-modal="true" aria-labelledby="siUpdateTitle">
      <div class="si-upd-head">
        <h2 class="si-upd-title" id="siUpdateTitle">检查更新</h2>
        <button class="si-upd-x" type="button" data-si-upd-close aria-label="关闭">✕</button>
      </div>
      <div class="si-upd-verdict" id="siUpdateVerdict">检查中…</div>
      <ul class="si-upd-rows">
        <li><span>当前版本</span><span class="si-upd-num" id="siUpdateCurrent">v–</span></li>
        <li><span>最新版本</span><span class="si-upd-num" id="siUpdateLatest">—</span></li>
      </ul>
      <div class="si-upd-notes" id="siUpdateNotes" hidden></div>
      <div class="si-upd-foot">
        <button class="si-upd-btn" type="button" data-si-upd-close>关闭</button>
        <button class="si-upd-btn si-upd-btn-primary" type="button" id="siUpdateRelease">前往下载更新</button>
      </div>
    </div>`;
  document.body.append(wrap);
  for (const el of wrap.querySelectorAll("[data-si-upd-close]")) {
    el.addEventListener("click", close);
  }
  wrap.querySelector("#siUpdateRelease")?.addEventListener("click", () => openExternal(releaseUrl));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });
  modalEl = wrap;
}

const el = (id) => document.getElementById(id);

function setVerdict(text, cls = "") {
  const node = el("siUpdateVerdict");
  if (!node) return;
  node.textContent = text;
  node.className = "si-upd-verdict" + (cls ? " " + cls : "");
}

/** 更新日志：分组标题 + 圆点条目，后端已经把 markdown 整理成 [{ title, items }] */
function renderNotes(groups) {
  const box = el("siUpdateNotes");
  if (!box) return;
  box.innerHTML = "";
  if (!Array.isArray(groups) || groups.length === 0) {
    box.hidden = true;
    return;
  }

  const label = document.createElement("div");
  label.className = "si-upd-notes-label";
  label.textContent = "更新内容";
  box.append(label);

  for (const group of groups) {
    if (group?.title) {
      const head = document.createElement("div");
      head.className = "si-upd-group";
      head.textContent = group.title;
      box.append(head);
    }
    const list = document.createElement("ul");
    list.className = "si-upd-list";
    for (const item of group?.items ?? []) {
      const li = document.createElement("li");
      li.textContent = item;
      list.append(li);
    }
    box.append(list);
  }

  box.hidden = false;
  box.scrollTop = 0;
}

function applyResult(info) {
  if (info.releaseUrl) releaseUrl = info.releaseUrl;
  currentVersion = info.currentVersion || "";
  const current = el("siUpdateCurrent");
  if (current) current.textContent = currentVersion ? "v" + currentVersion : "v–";
  const latest = el("siUpdateLatest");
  if (!latest) return;
  // 只有真有新版本时才给下载入口，免得「已是最新版本」旁边挂一个前往下载
  const rel = el("siUpdateRelease");
  if (rel) rel.hidden = !info.updateAvailable;

  if (info.updateAvailable) {
    latest.textContent = `v${info.latestVersion}${info.publishedAt ? " · " + shortDate(info.publishedAt) : ""}`;
    setVerdict("有新版本可用", "new");
    renderNotes(info.noteGroups);
    return;
  }

  latest.textContent = `v${info.latestVersion}`;
  setVerdict("已是最新版本");
  renderNotes(null);
}

async function check({ silent = false } = {}) {
  let info = null;
  try {
    info = await apiFetch("api/update-check", {}, 14000);
  } catch (error) {
    if (!silent) setVerdict("检查失败：" + String(error?.message || error), "err");
    return null;
  }
  if (!info?.ok) {
    if (!silent) setVerdict("检查失败：" + (info?.message || "未知错误"), "err");
    return null;
  }
  if (!silent) applyResult(info);
  return info;
}

function open(info, focusButton = true) {
  if (!modalEl) build();
  modalEl.hidden = false;
  releaseUrl = RELEASE_PAGE_URL;
  setVerdict("检查中…");
  renderNotes(null);
  const current = el("siUpdateCurrent");
  if (current) current.textContent = currentVersion ? "v" + currentVersion : "v–";
  const latest = el("siUpdateLatest");
  if (latest) latest.textContent = "—";
  // 结论出来前先收起下载入口：已是最新版本时这按钮没意义
  const rel0 = el("siUpdateRelease");
  if (rel0) rel0.hidden = true;

  if (info) applyResult(info);
  // 自检自动弹出时不抢焦点：用户可能正在拨开关
  if (focusButton) { const r = el("siUpdateRelease"); if (r && !r.hidden) r.focus(); }
  if (!info) check();
}

function close() {
  if (modalEl) modalEl.hidden = true;
}

/** 建好弹窗并自检一次；只在有新版时弹出。返回自检结果（失败或已是最新时为 null）。 */
export async function initUpdateNotice() {
  if (document.getElementById("siUpdateModal")) return null;
  build();
  const info = await check({ silent: true });
  if (info?.updateAvailable) {
    open(info, false);
    return info;
  }
  return null;
}

/** 手动打开：设置页「更新」按钮用。窗口先开，里面自己查。 */
export function openUpdateNotice() {
  open();
}
