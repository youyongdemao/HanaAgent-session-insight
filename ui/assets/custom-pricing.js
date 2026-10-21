// Shared editor for Settings and the workbench. Prices are never stored in browser storage.
import { hana } from './sdk.js';
import { apiFetch } from './app-api.js';
import { attachPricingSuggestions } from './pricing-combobox.js';

const TYPES = { payg: '按量计费', subscription: '订阅', local: '本地', free: '免费' };
let serial = 0;
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (text, fn, primary = false) => { const b = node('button', 'cp-btn' + (primary ? ' cp-primary' : ''), text); b.type = 'button'; b.addEventListener('click', fn); return b; };
const post = (path, body) => apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errorText = e => e?.message || String(e);
const labelEntry = e => `${e.providerName || e.providerId} · ${e.modelId}`;
const changed = revision => { window.dispatchEvent(new CustomEvent('si-pricing-changed', { detail: { revision } })); };

function dialog(title) {
  const el = node('dialog', 'cp-dialog');
  const head = node('header', 'cp-dialog-head');
  const h = node('h2', '', title); h.id = `cp-title-${++serial}`;
  el.setAttribute('aria-labelledby', h.id);
  const close = button('关闭', () => el.close());
  head.append(h, close); const body = node('div', 'cp-dialog-body');
  el.append(head, body); document.body.append(el);
  el.addEventListener('close', () => el.remove(), { once: true });
  el.showModal();
  return { el, body, close };
}

async function loadCatalog() {
  const [local, providers, publicDb] = await Promise.all([
    apiFetch('api/custom-pricing'),
    apiFetch('api/providers').catch(() => ({ providers: [] })),
    apiFetch('api/pricing', {}, 15000).catch(() => ({ rows: [] })),
  ]);
  return { ...local, providers: providers.providers || [], rows: publicDb.rows || [] };
}

export async function openPricingEditor(seed = {}, onSaved) {
  const d = dialog('自定义计费');
  d.body.append(node('p', 'cp-note', '正在读取计费配置…'));
  let data;
  try { data = await loadCatalog(); } catch (e) { d.body.replaceChildren(node('p', 'cp-error', '读取失败：' + errorText(e)), button('重试', () => { d.el.close(); openPricingEditor(seed, onSaved); })); return; }
  if (!d.el.isConnected) return;
  const existing = (data.entries || []).find(e => e.providerId === seed.providerId && e.modelId === seed.modelId);
  const entry = existing || seed;
  const publicRow = data.rows.find(r => r.provider === seed.providerId && r.model === seed.modelId && r.tier === 'flat' && r.status !== 'unlisted');
  d.body.replaceChildren();
  const form = node('form', 'cp-form');
  form.append(node('p', 'cp-note', '本地规则优先于公共价格，保存后参与实际费用计算。只添加计费资料，不修改 Hana 的模型连接。'));
  const grid = node('div', 'cp-fields'); const inputs = {};
  function field(key, title, { type = 'text', value = '', required = false, wide = false } = {}) {
    const wrap = node('label', 'cp-field' + (wide ? ' cp-wide' : ''));
    wrap.append(node('span', '', title));
    const input = node('input', 'cp-input'); input.name = key; input.type = type; input.value = value ?? ''; input.required = required;
    if (type === 'number') { input.min = '0'; input.step = 'any'; }
    input.maxLength = key === 'sourceUrl' ? 1024 : 256;
    wrap.append(input); grid.append(wrap); inputs[key] = input; return input;
  }
  const provider = field('providerId', '供应商 ID', { value: entry.providerId, required: true });
  const model = field('modelId', '模型 ID（与实际调用一致）', { value: entry.modelId, required: true });
  if (existing) { provider.readOnly = true; model.readOnly = true; }
  attachPricingSuggestions(provider, { container: d.el, label: '供应商', getOptions: () => data.providers.map(p => ({ value: p.id, label: p.name || p.id })) });
  const modelSuggestions = attachPricingSuggestions(model, { container: d.el, label: '模型', getOptions: () => data.providers.find(p => p.id === provider.value.trim())?.models || [] });
  const name = field('providerName', '供应商显示名', { value: entry.providerName || data.providers.find(p => p.id === entry.providerId)?.name || entry.providerId, required: true });
  function selectField(key, title, values, value) {
    const wrap = node('label', 'cp-field'); wrap.append(node('span', '', title));
    const sel = node('select', 'cp-input'); sel.name = key;
    for (const [v, text] of Object.entries(values)) { const o = node('option', '', text); o.value = v; sel.append(o); }
    sel.value = value; wrap.append(sel); grid.append(wrap); inputs[key] = sel; return sel;
  }
  const type = selectField('billingType', '计费类型', TYPES, entry.billingType || 'payg');
  const currency = selectField('currency', '价格币种', { CNY: '人民币 CNY', USD: '美元 USD' }, entry.currency || 'CNY');
  const unit = node('p', 'cp-unit cp-wide'); grid.append(unit);
  const prices = entry.prices || (publicRow ? { inputMiss: publicRow.miss, inputHit: publicRow.hit, output: publicRow.out, cacheWrite: publicRow.cacheWrite } : {});
  field('inputMiss', '未命中输入 / 百万 Token', { type: 'number', value: prices.inputMiss });
  field('inputHit', '缓存读取 / 百万 Token', { type: 'number', value: prices.inputHit });
  field('output', '输出 / 百万 Token', { type: 'number', value: prices.output });
  field('cacheWrite', '缓存写入（留空沿用未命中价）', { type: 'number', value: prices.cacheWrite });
  field('sourceUrl', '公开定价来源（本地可选，投稿需有来源）', { type: 'url', value: entry.notes?.sourceUrl, wide: true });
  const noteWrap = node('label', 'cp-field cp-wide'); noteWrap.append(node('span', '', '备注（可选）'));
  const note = node('textarea', 'cp-input'); note.name = 'note'; note.value = entry.notes?.note || ''; note.maxLength = 1000; note.rows = 2; noteWrap.append(note); grid.append(noteWrap); inputs.note = note;
  const enabledLabel = node('label', 'cp-check cp-wide'); const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = entry.enabled !== false; enabledLabel.append(enabled, document.createTextNode('启用这条本地规则')); grid.append(enabledLabel);
  form.append(grid);
  const updateModels = () => { const p = data.providers.find(p => p.id === provider.value.trim()); modelSuggestions.refresh(); if (!existing && p && (!name.value || name.value === entry.providerName || name.value === entry.providerId)) name.value = p.name || p.id; };
  provider.addEventListener('change', updateModels); updateModels();
  const updateType = () => {
    const payg = type.value === 'payg';
    for (const k of ['inputMiss', 'inputHit', 'output', 'cacheWrite']) { inputs[k].disabled = !payg; inputs[k].required = payg && k !== 'cacheWrite'; }
    currency.disabled = !payg;
    unit.textContent = payg ? `单位：${currency.value === 'USD' ? '美元' : '元'} / 百万 Token。美元按当前公共汇率 ${data.fxUsd || '—'} 换算为人民币。0 表示明确免费；必填项不能留空。` : '订阅、本地及免费通道不计入按 Token 费用，仍保留真实 Token 用量。';
  };
  type.addEventListener('change', updateType); currency.addEventListener('change', updateType); updateType();
  form.append(node('p', 'cp-note', '已有明细可按当前价格重新估算；缺少原始明细的冻结历史汇总不追溯重算。统计金额不等同于供应商账单。'));
  const status = node('p', 'cp-status'); status.setAttribute('role', 'status');
  const actions = node('div', 'cp-actions');
  const save = node('button', 'cp-btn cp-primary', '保存并生效'); save.type = 'submit';
  const draft = button('预览计费 Issue', async () => {
    if (!form.reportValidity()) return;
    draft.disabled = true; status.textContent = '';
    try { const r = await post('api/custom-pricing/draft', { entry: collect() }); await showDraft(r); } catch (e) { status.textContent = errorText(e); status.classList.add('cp-error'); } finally { draft.disabled = false; }
  });
  actions.append(save, draft, button('取消', () => d.el.close())); form.append(status, actions); d.body.append(form);
  function collect() {
    const p = {}; for (const k of ['inputMiss', 'inputHit', 'output', 'cacheWrite']) p[k] = type.value !== 'payg' || inputs[k].value.trim() === '' ? null : Number(inputs[k].value);
    return { providerId: provider.value.trim(), modelId: model.value.trim(), providerName: name.value.trim(), billingType: type.value, currency: currency.value, prices: p, enabled: enabled.checked, notes: { sourceUrl: inputs.sourceUrl.value.trim(), note: note.value.trim() } };
  }
  form.addEventListener('submit', async e => {
    e.preventDefault(); save.disabled = true; draft.disabled = true; d.close.disabled = true;
    status.classList.remove('cp-error'); status.textContent = '正在保存…';
    try {
      const r = await post('api/custom-pricing', { entry: collect(), expectedRevision: data.revision });
      if (r.ok === false) throw new Error(r.error || '保存失败');
      changed(r.revision); d.el.close(); await onSaved?.(r);
    } catch (err) {
      status.classList.add('cp-error'); status.textContent = errorText(err);
      if (/409|修订|冲突|版本/.test(errorText(err))) status.append(document.createTextNode('。请关闭后重新打开，避免覆盖另一窗口的修改。'));
    } finally { save.disabled = false; draft.disabled = false; d.close.disabled = false; }
  });
}

async function showDraft(result) {
  const d = dialog('计费 Issue 预览');
  d.body.append(node('p', 'cp-note', '以下内容将发布到公开 GitHub Issue。请检查模型标识、来源链接及备注中是否包含私人信息。此操作不会直接修改公共数据库。'));
  const text = node('textarea', 'cp-input cp-draft'); text.readOnly = true; text.setAttribute('aria-label', '投稿内容'); text.value = result.body || result.markdown || '';
  d.body.append(text);
  if (Array.isArray(result.warnings) && result.warnings.length) d.body.append(node('p', 'cp-error', result.warnings.join('；')));
  if (result.complete === false) d.body.append(node('p', 'cp-note', '价格尚不完整，可作为补录请求提交，不能直接并入公共价格库。'));
  const ackLabel = node('label', 'cp-check'); const ack = node('input'); ack.type = 'checkbox'; ackLabel.append(ack, document.createTextNode('我已检查内容，确认可以公开')); d.body.append(ackLabel);
  const status = node('p', 'cp-status'); status.setAttribute('role', 'status'); d.body.append(status);
  const actions = node('div', 'cp-actions');
  const copy = button('复制内容', async () => { try { const r = await hana.clipboard.writeText({ text: text.value }); if (r?.written === false) throw new Error('剪贴板写入失败'); status.textContent = '已复制'; } catch (e) { status.textContent = '复制失败，可直接选择上方文字复制：' + errorText(e); } });
  const open = button('前往 GitHub 提交 Issue', async () => {
    const url = new URL('https://github.com/youyongdemao/HanaAgent-session-insight/issues/new'); url.searchParams.set('title', result.title || '[计费数据] 补充模型价格');
    url.searchParams.set('body', text.value);
    const tooLong = url.href.length > 6500;
    if (tooLong) { try { const r = await hana.clipboard.writeText({ text: text.value }); if (r?.written === false) throw new Error('复制失败'); } catch { status.textContent = '内容较长，请先手动复制上方投稿内容，再打开 GitHub。'; return; } url.searchParams.delete('body'); }
    try { const r = await hana.external.open({ url: url.href }); if (r?.opened === false) throw new Error('宿主未打开链接'); status.textContent = tooLong ? '已复制内容并打开投稿页，请粘贴后在 GitHub 确认提交。' : '已打开投稿页，请在 GitHub 登录并确认提交。'; } catch (e) { status.textContent = '打开失败：' + errorText(e); }
  }, true);
  open.disabled = true; ack.addEventListener('change', () => { open.disabled = !ack.checked; }); actions.append(copy, open); d.body.append(actions);
}

export function mountPricingManager(container) {
  let data = null, loadSeq = 0;
  container.classList.add('cp-manager');
  const toolbar = node('div', 'cp-toolbar');
  const search = node('input', 'cp-input cp-search'); search.type = 'search'; search.placeholder = '搜索供应商或模型'; search.setAttribute('aria-label', '搜索自定义计费');
  const add = button('添加自定义计费', () => openPricingEditor({}), true);
  const reload = button('刷新', refresh); toolbar.append(search, add, reload);
  const status = node('p', 'cp-status'); status.setAttribute('role', 'status');
  const list = node('div', 'cp-list');
  const help = node('p', 'cp-note', '本地规则优先于公共价格；停用或删除后恢复公共价格，没有公共价格则标为未收录。这里只管理计费，不添加模型连接或余额查询。');
  container.replaceChildren(help, toolbar, status, list);
  search.addEventListener('input', render);
  async function refresh() {
    const seq = ++loadSeq; reload.disabled = true; add.disabled = true; status.textContent = '正在读取…'; status.classList.remove('cp-error');
    try { const result = await apiFetch('api/custom-pricing'); if (seq !== loadSeq) return; data = result; render(); status.textContent = `${(data.entries || []).length} 条本地规则 · 保存后参与实际费用计算` + (data.droppedInvalid ? ` · 有 ${data.droppedInvalid} 条损坏条目未加载，请先备份检查原文件` : ''); }
    catch (e) { status.classList.add('cp-error'); status.textContent = '读取失败：' + errorText(e); }
    finally { if (seq === loadSeq) { reload.disabled = false; add.disabled = !data; } }
  }
  async function update(entry) {
    try { const r = await post('api/custom-pricing', { entry, expectedRevision: data.revision }); changed(r.revision); await refresh(); }
    catch (e) { status.classList.add('cp-error'); status.textContent = errorText(e); }
  }
  function render() {
    list.replaceChildren(); const q = search.value.trim().toLowerCase();
    const entries = (data?.entries || []).filter(e => (labelEntry(e) + e.providerId).toLowerCase().includes(q));
    if (!entries.length) { list.append(node('p', 'cp-empty', q ? '没有匹配的条目' : '还没有自定义计费。也可以在资费列表中直接补充某个模型。')); return; }
    for (const entry of entries) {
      const row = node('article', 'cp-item' + (entry.enabled ? '' : ' cp-off'));
      const main = node('div', 'cp-item-main'); main.append(node('strong', '', labelEntry(entry)), node('span', 'cp-note', `${entry.providerId} · ${TYPES[entry.billingType] || entry.billingType} · ${entry.currency} / 百万 Token · ${entry.enabled ? '已启用' : '已停用'}`));
      if (entry.billingType === 'payg') main.append(node('span', 'cp-note', `未命中 ${entry.prices?.inputMiss ?? '未知'} · 缓存读取 ${entry.prices?.inputHit ?? '未知'} · 输出 ${entry.prices?.output ?? '未知'}`));
      const actions = node('div', 'cp-actions');
      const toggle = button(entry.enabled ? '停用' : '启用', async () => { toggle.disabled = true; await update({ ...entry, enabled: !entry.enabled }); toggle.disabled = false; });
      actions.append(button('编辑', () => openPricingEditor(entry)), toggle, button('删除', () => {
        actions.replaceChildren(node('span', 'cp-note', '删除覆盖并恢复公共价？'), button('确认删除', async ev => {
          ev.currentTarget.disabled = true;
          try { const r = await post('api/custom-pricing/remove', { providerId: entry.providerId, modelId: entry.modelId, expectedRevision: data.revision }); changed(r.revision); await refresh(); }
          catch (e) { status.classList.add('cp-error'); status.textContent = errorText(e); render(); }
        }), button('取消', render));
      })); row.append(main, actions); list.append(row);
    }
  }
  const listener = () => refresh(); window.addEventListener('si-pricing-changed', listener);
  refresh();
  return { refresh, dispose: () => window.removeEventListener('si-pricing-changed', listener) };
}

export function openPricingManager() {
  const d = dialog('管理自定义计费'); const mgr = mountPricingManager(d.body);
  d.el.addEventListener('close', mgr.dispose, { once: true });
  return d;
}
