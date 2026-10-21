// assets/subscriptions.js — 套餐有效期与分摊（设置页内嵌模块）
// 只做本地账本编辑与展示：金额、日期留在本机，投稿与逐轮费用计算都不读这里。
// 依赖页面已加载 custom-pricing.css（cp-dialog / cp-input 等），本文件只补 sc-* 结构样式。
import { apiFetch } from './app-api.js';
import { attachPricingSuggestions } from './pricing-combobox.js';

const EVENT = 'si-subscriptions-changed';
const STATUS_LABEL = {
  ok: '已同步',
  success: '已同步',
  synced: '已同步',
  skipped: '已跳过',
  no_key: '未配置管理凭据',
  'missing-credentials': '未配置 AK/SK',
  'no-credentials': '未配置 AK/SK',
  'missing-credential': '未配置 AK/SK',
  unauthorized: '凭据无效',
  auth: '凭据签名失败',
  permission: '缺少只读权限',
  'not-configured': '未配置',
  empty: '未查到订阅',
  ambiguous: '需人工确认',
  parse_failed: '无法确认到期',
  error: '查询失败',
  failed: '查询失败',
  network: '查询失败',
  unsupported: '不支持自动查询',
  unavailable: '暂不可用',
};
const STATUS_TONE = {
  ok: 'ok', success: 'ok', synced: 'ok',
  no_key: 'warn', empty: 'warn', ambiguous: 'warn', 'parse_failed': 'warn', permission: 'warn',
  auth: 'bad', network: 'bad', error: 'bad', failed: 'bad',
};

let serial = 0;

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const button = (text, fn, primary = false) => {
  const b = node('button', 'cp-btn' + (primary ? ' cp-primary' : ''), text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
};
const post = (path, body, timeoutMs) =>
  apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
const errorText = (e) => e?.message || String(e);
const friendly = (e) => {
  if (e?.status === 409) return '订阅记录已被另一窗口修改，请刷新后重试';
  if (e?.status === 404) return '订阅接口尚未接入：' + errorText(e);
  return errorText(e);
};

function dialog(title) {
  const el = node('dialog', 'cp-dialog sc-dialog');
  const head = node('header', 'cp-dialog-head');
  const h = node('h2', '', title);
  h.id = `sc-title-${++serial}`;
  el.setAttribute('aria-labelledby', h.id);
  const close = button('关闭', () => el.close());
  head.append(h, close);
  const body = node('div', 'cp-dialog-body');
  el.append(head, body);
  document.body.append(el);
  el.addEventListener('close', () => el.remove(), { once: true });
  el.showModal();
  return { el, body, close };
}

const pad = (n) => String(n).padStart(2, '0');
const validDate = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
};
function fmtDate(iso) {
  const d = validDate(iso);
  if (!d) return '未知';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}
/** ISO → 本地 datetime-local 值；空值保持空，绝不落到 1970。 */
function toLocalInput(iso) {
  const d = validDate(iso);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** datetime-local 按用户本地时区解释，存的时候转成带时区的 ISO。 */
function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function money(n, cur = 'CNY') {
  if (n == null || !Number.isFinite(n)) return '—';
  return (cur === 'USD' ? '$' : '¥') + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function missingFields(entry) {
  const missing = [];
  if (!entry.validFrom) missing.push('起始时间');
  if (!entry.validTo) missing.push('到期时间');
  if (entry.amount == null) missing.push('实付金额');
  if (entry.currency === 'USD' && !(Number(entry.fxRate) > 0)) missing.push('汇率');
  return missing;
}
/** 已过去的部分占总有效期的比例，以及折算金额。缺项返回 null，不计费。 */
function amortize(entry, now = Date.now()) {
  if (entry.amount == null || !entry.validFrom || !entry.validTo) return { cost: null, ratio: null, days: null };
  const start = Date.parse(entry.validFrom);
  const end = Date.parse(entry.validTo);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { cost: null, ratio: null, days: null };
  const total = end - start;
  const elapsed = Math.min(end, Math.max(start, now)) - start;
  const ratio = total > 0 ? elapsed / total : 0;
  return {
    cost: entry.amount * (Number(entry.fxRate) > 0 ? Number(entry.fxRate) : 1) * ratio,
    ratio,
    days: { elapsed: Math.floor(elapsed / 86400000), total: Math.max(1, Math.round(total / 86400000)) },
  };
}
function localSummary(entries) {
  let costCny = 0, paidCny = 0, incompleteCount = 0;
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const part = amortize(entry);
    if (part.cost != null) costCny += part.cost;
    if (entry.amount != null) paidCny += entry.amount * (Number(entry.fxRate) > 0 ? Number(entry.fxRate) : 1);
    if (missingFields(entry).length) incompleteCount += 1;
  }
  return { costCny, paidCny, incompleteCount };
}
function diagTone(status) {
  const s = String(status || '').toLowerCase();
  if (STATUS_TONE[s]) return STATUS_TONE[s];
  if (/missing|credential|unauthorized|auth|config/.test(s)) return 'warn';
  return 'bad';
}
function diagLabel(status) {
  return STATUS_LABEL[String(status || '').toLowerCase()] || status || '未知状态';
}
function renderDiagnostics(container, diagnostics, detailed = false) {
  container.replaceChildren();
  const rows = Array.isArray(diagnostics) ? diagnostics : [];
  if (!rows.length) {
    container.append(node('p', 'cp-note sc-diag-empty', detailed ? '这次同步没有返回供应商状态。' : ''));
    return;
  }
  for (const item of rows) {
    const row = node('div', 'sc-diag');
    row.append(
      node('span', 'sc-diag-prov', item.providerName || item.providerId || '供应商'),
      node('span', 'sc-diag-state sc-' + diagTone(item.status), diagLabel(item.status))
    );
    if (item.note) row.append(node('span', 'sc-diag-note', String(item.note)));
    container.append(row);
  }
}
const providerName = (providers, id) => providers.find((p) => p.id === id)?.name || id;

export function mountSubscriptionsManager(container) {
  if (!container) return { refresh: async () => {}, dispose() {} };
  let data = null;
  let providers = [];
  let loadSeq = 0;
  let selfRevision = null;
  const openDialogs = new Set();

  container.classList.add('cp-manager', 'sc-manager');
  container.replaceChildren();

  const help = node('p', 'cp-note', '自动同步目前只支持火山方舟个人 Coding Plan（管理端 AK/SK 在「设置 → 供应商设置」配置），其他供应商请手动补录。套餐只登记在计费类型为「订阅」的供应商上；按量计费的供应商要先给套内模型改成订阅，否则会与逐 Token 费用重复计算。金额与到期资料只保存在本机，不会投稿到公共价格库，也不会分摊回逐轮会话。');
  const toolbar = node('div', 'cp-toolbar');
  const search = node('input', 'cp-input cp-search sc-search');
  search.type = 'search';
  search.placeholder = '搜索套餐或供应商';
  search.setAttribute('aria-label', '搜索套餐');
  const add = button('添加套餐', () => openEditor(null), true);
  const sync = button('同步到期（只读）', () => openSync());
  const reload = button('刷新', refresh);
  toolbar.append(search, add, sync, reload);

  const summary = node('div', 'sc-summary');
  summary.setAttribute('aria-live', 'polite');
  const diagnostics = node('div', 'sc-diags');
  const status = node('p', 'cp-status');
  status.setAttribute('role', 'status');
  const list = node('div', 'cp-list sc-list');
  const foot = node('p', 'cp-note sc-foot', '自动同步只读取到期时间，起始时间与实付金额需补录；官网标价不等于实付，请按账单填写。火山 AK/SK 与套餐额度查询共用，本页不另收密钥、不显示密钥内容。');

  container.append(help, toolbar, summary, diagnostics, status, list, foot);
  search.addEventListener('input', render);

  function showError(e) {
    status.classList.add('cp-error');
    status.textContent = friendly(e);
  }
  function clearError() {
    status.classList.remove('cp-error');
  }

  async function refresh() {
    const seq = ++loadSeq;
    reload.disabled = true;
    add.disabled = true;
    sync.disabled = true;
    clearError();
    status.textContent = '正在读取套餐…';
    try {
      const [subs, prov] = await Promise.all([
        apiFetch('api/subscriptions'),
        apiFetch('api/providers').catch(() => ({ providers: [] })),
      ]);
      if (seq !== loadSeq) return;
      data = subs && typeof subs === 'object' ? subs : { entries: [], revision: 0, diagnostics: [], summary: null };
      data.entries = Array.isArray(data.entries) ? data.entries : [];
      providers = Array.isArray(prov?.providers) ? prov.providers : [];
      render();
      const enabled = data.entries.filter((e) => e.enabled).length;
      const missing = data.entries.filter((e) => missingFields(e).length).length;
      status.textContent = `${data.entries.length} 条套餐 · ${enabled} 条启用${missing ? ` · ${missing} 条缺项暂不计费` : ''}`;
    } catch (e) {
      if (seq !== loadSeq) return;
      data = null;
      summary.replaceChildren();
      diagnostics.replaceChildren();
      render();
      showError(e);
    } finally {
      if (seq === loadSeq) {
        reload.disabled = false;
        add.disabled = false;
        sync.disabled = false;
      }
    }
  }

  function renderSummary() {
    summary.replaceChildren();
    if (!data) return;
    const fallback = localSummary(data.entries);
    const s = data.summary || {};
    const paid = Number.isFinite(s.paidCny) ? s.paidCny : fallback.paidCny;
    const cost = Number.isFinite(s.costCny) ? s.costCny : fallback.costCny;
    const incomplete = Number.isFinite(s.incompleteCount) ? s.incompleteCount : fallback.incompleteCount;
    const enabled = data.entries.filter((e) => e.enabled).length;
    const cells = [
      ['实付合计', money(paid), `${enabled} 条启用`],
      ['累计分摊', money(cost), '按天 · 截至今天'],
      ['待补齐', String(incomplete), '缺项不计费'],
    ];
    for (const [label, value, sub] of cells) {
      const cell = node('div', 'sc-metric');
      cell.append(node('span', 'sc-metric-label', label), node('strong', 'sc-metric-value', value), node('span', 'sc-metric-sub', sub));
      summary.append(cell);
    }
  }

  function render() {
    renderSummary();
    if (data && Array.isArray(data.diagnostics)) {
      diagnostics.replaceChildren();
      if (data.diagnostics.length) {
        const head = node('div', 'sc-diag-head');
        head.append(node('span', '', '供应商状态'), node('span', 'cp-note', '只读'));
        diagnostics.append(head);
        renderDiagnostics(diagnostics, data.diagnostics);
      }
    }
    list.replaceChildren();
    if (!data) {
      list.append(node('p', 'cp-empty', '套餐数据尚未读取。'));
      return;
    }
    const q = search.value.trim().toLowerCase();
    const entries = data.entries.filter((entry) => {
      const hay = `${entry.planName || ''} ${entry.providerId || ''} ${providerName(providers, entry.providerId)}`.toLowerCase();
      return hay.includes(q);
    });
    if (!entries.length) {
      list.append(node('p', 'cp-empty', q ? '没有匹配的套餐' : '还没有套餐记录。点「添加套餐」手动录入，或先点「同步到期（只读）」读取火山套餐。'));
      return;
    }
    for (const entry of entries) list.append(renderEntry(entry));
  }

  function renderEntry(entry) {
    const row = node('article', 'cp-item sc-item' + (entry.enabled ? '' : ' cp-off'));
    const main = node('div', 'cp-item-main sc-item-main');
    const title = node('div', 'sc-title');
    title.append(node('strong', '', entry.planName || '未命名套餐'));
    if (entry.source === 'official') title.append(node('span', 'sc-badge', '官方同步'));
    main.append(title);

    const period = `${fmtDate(entry.validFrom)} → ${fmtDate(entry.validTo)}`;
    main.append(node('span', 'cp-note sc-line', `${providerName(providers, entry.providerId)} · ${period}` + (entry.enabled ? '' : ' · 已停用')));

    const part = amortize(entry);
    const missing = missingFields(entry);
    const incomplete = typeof entry.incomplete === 'boolean' ? entry.incomplete : missing.length > 0;
    const serverCost = Number.isFinite(entry.costCny) ? entry.costCny : null;
    const chips = node('div', 'sc-chips');
    const paidText =
      entry.amount == null
        ? '实付未知'
        : entry.currency === 'USD'
          ? `实付 ${money(entry.amount, 'USD')} × ${Number(entry.fxRate) > 0 ? entry.fxRate : '—'} = ${money(entry.amount * (Number(entry.fxRate) > 0 ? Number(entry.fxRate) : 1))}`
          : `实付 ${money(entry.amount)}${entry.amount === 0 ? '（免费）' : ''}`;
    chips.append(node('span', 'sc-chip', paidText));
    if (incomplete) {
      chips.append(node('span', 'sc-chip sc-chip-warn', '缺项未分摊'));
    } else {
      const cost = serverCost == null || !entry.enabled ? part.cost : serverCost;
      const tail = `${part.ratio != null ? ` · ${Math.round(part.ratio * 100)}%` : ''}${entry.enabled ? '' : '（未计入）'}`;
      chips.append(node('span', 'sc-chip', `已分摊 ${money(cost)}${tail}`));
    }
    if (missing.length) chips.append(node('span', 'sc-chip sc-chip-warn', '缺：' + missing.join('、')));
    else chips.append(node('span', 'sc-chip sc-chip-ok', '资料完整'));
    const billing = providers.find((p) => p.id === entry.providerId)?.billingType;
    if (billing && billing !== 'subscription') {
      chips.append(node('span', 'sc-chip sc-chip-warn', '供应商计费类型不是订阅，请先改成订阅以免重复计费'));
    }
    main.append(chips);

    if (part.ratio != null && part.days) {
      const progress = node('div', 'sc-progress');
      progress.setAttribute('role', 'img');
      progress.setAttribute('aria-label', `有效期已过 ${Math.round(part.ratio * 100)}%`);
      const fill = node('i');
      fill.style.width = Math.max(0, Math.min(100, part.ratio * 100)) + '%';
      progress.append(fill);
      main.append(progress);
      main.append(node('span', 'cp-note sc-days', `共 ${part.days.total} 天 · 已过 ${Math.min(part.days.elapsed, part.days.total)} 天`));
    }

    const actions = node('div', 'cp-actions sc-item-actions');
    actions.append(
      button('编辑', () => openEditor(entry)),
      button(entry.enabled ? '停用' : '启用', () =>
        confirmInline(actions, entry.enabled ? '停用后这条套餐不再计入分摊。' : '启用后按有效期重新计入分摊。', entry.enabled ? '确认停用' : '确认启用', () =>
          updateEntry({ ...entry, enabled: !entry.enabled })
        )
      ),
      button('删除', () =>
        confirmInline(
          actions,
          entry.source === 'official' ? '删除后不会随下次同步自动恢复（已保留删除标记），需要时只能重新录入。' : '删除后不可恢复，需要重新录入。',
          '确认删除',
          () => removeEntry(entry)
        )
      )
    );
    row.append(main, actions);
    return row;
  }

  function confirmInline(actions, prompt, label, run) {
    const original = [...actions.childNodes];
    const noteEl = node('span', 'cp-note sc-confirm-text', prompt);
    const yes = button(label, async () => {
      yes.disabled = true;
      const ok = await run();
      if (!ok && yes.isConnected) actions.replaceChildren(...original);
    }, true);
    actions.replaceChildren(noteEl, yes, button('取消', () => actions.replaceChildren(...original)));
  }

  async function updateEntry(entry) {
    clearError();
    status.textContent = '正在保存…';
    try {
      const r = await post('api/subscriptions', { entry, expectedRevision: data?.revision });
      if (r?.ok === false) throw new Error(r.error || '保存失败');
      await refresh();
      notify(r?.revision ?? data?.revision);
      return true;
    } catch (e) {
      showError(e);
      return false;
    }
  }

  async function removeEntry(entry) {
    clearError();
    status.textContent = '正在删除…';
    try {
      const r = await post('api/subscriptions/remove', { id: entry.id, expectedRevision: data?.revision });
      if (r?.ok === false) throw new Error(r.error || '删除失败');
      await refresh();
      notify(r?.revision ?? data?.revision);
      return true;
    } catch (e) {
      showError(e);
      return false;
    }
  }

  function notify(revision) {
    if (revision == null) return;
    selfRevision = revision;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { revision } }));
    // 跨 iframe：只广播版本号与时间，不写任何金额、日期或凭据。
    try {
      localStorage.setItem('si-subscriptions-revision', JSON.stringify({ revision, time: Date.now() }));
    } catch {
      /* 存储不可用时事件仍然有效 */
    }
  }

  /* ── 添加 / 编辑 ── */
  function openEditor(entry) {
    const isNew = !entry;
    const d = dialog(isNew ? '添加套餐' : '编辑套餐');
    openDialogs.add(d.el);
    d.el.addEventListener('close', () => openDialogs.delete(d.el), { once: true });

    const form = node('form', 'cp-form');
    const grid = node('div', 'cp-fields');
    const inputs = {};
    const fxUsd = Number(data?.fxUsd) > 0 ? Number(data.fxUsd) : null;

    function field(key, title, { type = 'text', value = '', required = false, wide = false, placeholder = '', readOnly = false, min, step } = {}) {
      const wrap = node('label', 'cp-field' + (wide ? ' cp-wide' : ''));
      wrap.append(node('span', '', title));
      const input = node('input', 'cp-input');
      input.name = key;
      input.type = type;
      input.value = value ?? '';
      input.required = required;
      input.readOnly = readOnly;
      if (placeholder) input.placeholder = placeholder;
      if (min != null) input.min = String(min);
      if (step != null) input.step = String(step);
      input.maxLength = 200;
      wrap.append(input);
      grid.append(wrap);
      inputs[key] = input;
      return input;
    }
    function selectField(key, title, values, value) {
      const wrap = node('label', 'cp-field');
      wrap.append(node('span', '', title));
      const sel = node('select', 'cp-input');
      sel.name = key;
      for (const [v, text] of Object.entries(values)) {
        const o = node('option', '', text);
        o.value = v;
        sel.append(o);
      }
      sel.value = value;
      wrap.append(sel);
      grid.append(wrap);
      inputs[key] = sel;
      return sel;
    }

    // 只锁官方确认过的日期（officialFrom/officialTo 为 true）。
    // 官方记录里用户手填的起始时间仍可更正，不能因为来源是 official 就一并锁住。
    const lockStart = entry?.officialFrom === true;
    const lockEnd = entry?.officialTo === true;

    const provider = field('providerId', '供应商 ID', {
      value: entry?.providerId || '',
      required: true,
      readOnly: entry?.source === 'official',
      placeholder: '例如 volcengine-coding',
    });
    provider.setAttribute('pattern', '[a-z0-9][a-z0-9._:-]{0,159}');
    provider.title = '小写字母、数字或 . _ : -，以字母或数字开头';
    const suggestions = attachPricingSuggestions(provider, {
      container: d.el,
      label: '供应商',
      getOptions: () => providers.map((p) => ({ value: p.id, label: p.name || p.id })),
    });
    const billingHint = node('p', 'cp-note sc-span sc-provider-hint');
    grid.append(billingHint);
    const BILLING_TEXT = { subscription: '订阅', payg: '按量计费', free: '免费', local: '本地' };
    function currentProvider() {
      const id = provider.value.trim().toLowerCase();
      return providers.find((p) => p.id === id) || null;
    }
    function updateBillingHint() {
      const p = currentProvider();
      billingHint.classList.remove('sc-warn-note');
      if (!p) {
        billingHint.textContent = '供应商不在当前接入列表里：保存时由后端校验计费类型，须为「订阅」才能登记套餐。';
        return;
      }
      if (p.billingType === 'subscription') {
        billingHint.textContent = '计费类型：订阅 · 可以登记套餐，套餐分摊与逐 Token 费用不会重复。';
        return;
      }
      billingHint.classList.add('sc-warn-note');
      billingHint.textContent = `当前计费类型：${BILLING_TEXT[p.billingType] || p.billingType || '未知'}。请先在「自定义计费」里把该供应商的套内模型改成「订阅」，否则套餐会和按量费用重复计算。`;
    }
    provider.addEventListener('input', updateBillingHint);
    provider.addEventListener('change', updateBillingHint);
    updateBillingHint();

    const planName = field('planName', '套餐名称', {
      value: entry?.planName || '',
      required: true,
      placeholder: '例如 火山方舟 Coding Plan',
    });

    // 记下初始的本地值：没动过的日期沿用原始 ISO，避免截断秒/毫秒导致官方日期“被修改”。
    const initialFrom = toLocalInput(entry?.validFrom);
    const initialTo = toLocalInput(entry?.validTo);
    const from = field('validFrom', lockStart ? '起始时间（官方）' : '起始时间', {
      type: 'datetime-local',
      value: initialFrom,
      readOnly: lockStart,
    });
    const to = field('validTo', lockEnd ? '到期时间（官方）' : '到期时间', {
      type: 'datetime-local',
      value: initialTo,
      readOnly: lockEnd,
    });
    const readDate = (input, initialLocal, originalIso, locked) =>
      locked || input.value === initialLocal ? (originalIso || null) : fromLocalInput(input.value);

    const amount = field('amount', '实付金额（可留空）', {
      type: 'number',
      value: entry?.amount == null ? '' : String(entry.amount),
      min: 0,
      step: 'any',
      placeholder: '留空 = 未知；0 = 免费',
    });
    const currency = selectField('currency', '币种', { CNY: '人民币 CNY', USD: '美元 USD' }, entry?.currency || 'CNY');
    const fx = field('fxRate', '美元入账汇率', {
      type: 'number',
      value: entry?.currency === 'USD' ? String(entry?.fxRate || fxUsd || '') : String(fxUsd || ''),
      min: 0,
      step: 'any',
      placeholder: fxUsd ? String(fxUsd) : '例如 7.10',
    });

    const moneyHint = node('p', 'cp-note sc-span');
    grid.append(moneyHint);

    const officialNote = node('p', 'cp-note sc-span');
    if (entry?.source === 'official') {
      officialNote.textContent = `来源：官方同步${lockStart || lockEnd ? '。官方已读到的日期为只读，下次同步会更新；与账单不符时请联系供应商核对' : ''}。金额请按实付补录，官网标价不能当实付。`;
      grid.append(officialNote);
    }

    const enabledLabel = node('label', 'cp-check cp-wide');
    const enabled = node('input');
    enabled.type = 'checkbox';
    enabled.checked = entry?.enabled !== false;
    enabledLabel.append(enabled, document.createTextNode('计入分摊'));
    grid.append(enabledLabel);
    inputs.enabled = enabled;

    form.append(grid);

    function updateFx() {
      const usd = currency.value === 'USD';
      fx.disabled = !usd;
      fx.required = usd;
      if (usd && !fx.value && fxUsd) fx.value = String(fxUsd);
    }
    function updateHint() {
      const draft = {
        validFrom: fromLocalInput(from.value),
        validTo: fromLocalInput(to.value),
        amount: amount.value.trim() === '' ? null : Number(amount.value),
        currency: currency.value,
        fxRate: Number(fx.value),
      };
      const miss = missingFields(draft).filter((x) => x !== '汇率');
      if (draft.amount === 0) moneyHint.textContent = '0 表示明确免费：会保留记录，但不产生分摊。';
      else if (miss.length) moneyHint.textContent = `保存后仍缺：${miss.join('、')}。缺项允许保存，但这几项不参与分摊。`;
      else moneyHint.textContent = '资料完整，将按天把实付分摊到当前总消耗。';
    }
    currency.addEventListener('change', updateFx);
    amount.addEventListener('input', updateHint);
    from.addEventListener('input', updateHint);
    to.addEventListener('input', updateHint);
    to.addEventListener('input', () => to.setCustomValidity(''));
    provider.addEventListener('change', () => suggestions.refresh());
    updateFx();
    updateHint();

    const statusEl = node('p', 'cp-status');
    statusEl.setAttribute('role', 'status');
    const actions = node('div', 'cp-actions');
    const save = node('button', 'cp-btn cp-primary', isNew ? '保存套餐' : '保存修改');
    save.type = 'submit';
    actions.append(save, button('取消', () => d.el.close()));
    form.append(statusEl, actions);
    d.body.append(form);

    function collect() {
      const raw = amount.value.trim();
      return {
        ...(entry?.id ? { id: entry.id } : {}),
        providerId: provider.value.trim().toLowerCase(),
        planName: planName.value.trim(),
        validFrom: readDate(from, initialFrom, entry?.validFrom, lockStart),
        validTo: readDate(to, initialTo, entry?.validTo, lockEnd),
        amount: raw === '' ? null : Number(raw),
        currency: currency.value,
        fxRate: currency.value === 'USD' ? Number(fx.value) : 1,
        enabled: enabled.checked,
      };
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const known = currentProvider();
      if (known && known.billingType !== 'subscription') {
        updateBillingHint();
        statusEl.classList.add('cp-error');
        statusEl.textContent = '该供应商的计费类型不是「订阅」。请先到「自定义计费」把套内模型改成订阅计费，再登记套餐，避免重复计费。';
        provider.focus();
        return;
      }
      const payload = collect();
      if (payload.validFrom && payload.validTo && Date.parse(payload.validTo) <= Date.parse(payload.validFrom)) {
        to.setCustomValidity('到期时间必须晚于起始时间');
        to.reportValidity();
        return;
      }
      to.setCustomValidity('');
      save.disabled = true;
      d.close.disabled = true;
      statusEl.classList.remove('cp-error');
      statusEl.textContent = '正在保存…';
      try {
        const r = await post('api/subscriptions', { entry: payload, expectedRevision: data?.revision });
        if (r?.ok === false) throw new Error(r.error || '保存失败');
        await refresh();
        notify(r?.revision ?? data?.revision);
        d.el.close();
      } catch (err) {
        statusEl.classList.add('cp-error');
        statusEl.textContent = '保存失败：' + friendly(err);
        save.disabled = false;
        d.close.disabled = false;
      }
    });
  }

  /* ── 同步到期：只读查询 ── */
  function openSync() {
    const d = dialog('同步套餐到期');
    openDialogs.add(d.el);
    d.el.addEventListener('close', () => openDialogs.delete(d.el), { once: true });

    d.body.append(
      node('p', 'cp-note', '只读查询：目前仅自动查询火山方舟个人 Coding Plan 的到期时间，不会修改金额、不会写入或上传任何凭据，也不会下载账单。其他供应商请手动补录。'),
      node('p', 'cp-note', '使用「设置 → 供应商设置」里已配置的火山管理端 AccessKey ID / SecretAccessKey（与额度查询共用）；模型 API Key 不适用。本页不收集密钥，也不显示密钥内容。'),
      node('p', 'cp-note', '官方只可靠返回到期时间，起始时间与实付金额仍需补录。新的到期会创建一个新的待补录周期，不会猜测续费金额；已删除的官方记录不会被同步复活。')
    );

    const result = node('div', 'sc-sync-result');
    const statusEl = node('p', 'cp-status');
    statusEl.setAttribute('role', 'status');
    const actions = node('div', 'cp-actions');
    const run = button('开始只读查询', async () => {
      run.disabled = true;
      d.close.disabled = true;
      statusEl.classList.remove('cp-error');
      statusEl.textContent = '正在向供应商查询…';
      try {
        const r = await post('api/subscriptions/sync', {}, 25000);
        await refresh();
        notify(r?.revision ?? data?.revision);
        statusEl.textContent = '查询完成，本地记录已更新。';
        renderSyncResult(result, r);
      } catch (e) {
        statusEl.classList.add('cp-error');
        statusEl.textContent = '查询失败：' + friendly(e);
      } finally {
        run.disabled = false;
        d.close.disabled = false;
      }
    }, true);
    actions.append(run, button('关闭', () => d.el.close()));
    d.body.append(statusEl, actions, result);
  }

  function renderSyncResult(container, r) {
    container.replaceChildren();
    const entries = Array.isArray(r?.entries) ? r.entries : [];
    const official = entries.filter((e) => e.source === 'official').length;
    const summaryEl = node('p', 'cp-note', `本地共 ${entries.length} 条记录，其中官方同步 ${official} 条。`);
    container.append(summaryEl);
    const box = node('div', 'sc-diags sc-diags-inline');
    renderDiagnostics(box, r?.diagnostics || [], true);
    container.append(box);
    factoryNote(container, r?.diagnostics || []);
  }

  function factoryNote(container, diagnostics) {
    const hasCredIssue = diagnostics.some((d) => String(d.status) === 'no_key' || /credential|auth|config/i.test(String(d.status)));
    if (!hasCredIssue) return;
    const note = node('p', 'cp-note sc-warn-note', '火山同步需要 AK/SK。到「设置 → 供应商设置」里填写已有的火山 AccessKey / SecretKey 后再同步，本模块不另收 Key。');
    container.append(note);
  }

  const onEvent = (ev) => {
    const rev = ev?.detail?.revision;
    if (rev != null && (rev === selfRevision || rev === data?.revision)) return;
    refresh();
  };
  window.addEventListener(EVENT, onEvent);

  refresh();
  return {
    refresh,
    dispose() {
      window.removeEventListener(EVENT, onEvent);
      loadSeq += 1;
      for (const el of [...openDialogs]) {
        try { el.close(); } catch { /* 已关闭 */ }
      }
      openDialogs.clear();
      container.replaceChildren();
    },
  };
}
