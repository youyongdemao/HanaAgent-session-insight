// Theme-aware, editable suggestions. Values remain ordinary text inputs.
export function attachPricingSuggestions(input, { getOptions, label = '候选项', container }) {
  const owner = container || input.closest('dialog') || document.body;
  const scope = new AbortController();
  const signal = scope.signal;
  const wrap = document.createElement('div'); wrap.className = 'cp-combo';
  input.before(wrap); wrap.append(input);
  input.removeAttribute('list'); input.autocomplete = 'off';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'cp-combo-toggle';
  trigger.setAttribute('aria-label', `展开${label}`); trigger.tabIndex = -1;
  trigger.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  wrap.append(trigger);
  const menu = document.createElement('div'); menu.className = 'cp-suggestions';
  menu.id = `${input.name}-suggestions-${crypto.randomUUID()}`;
  menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', label); menu.hidden = true;
  const supportsPopover = typeof menu.showPopover === 'function';
  if (supportsPopover) menu.setAttribute('popover', 'manual');
  owner.append(menu);
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', menu.id); input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', menu.id);
  let open = false, matches = [], active = -1, all = false;
  const options = () => (getOptions() || []).map(o => typeof o === 'string' ? { value: o, label: '' } : o).filter(o => o?.value);
  const editable = () => !input.readOnly && !input.disabled;
  function position() {
    if (!open) return;
    const rect = wrap.getBoundingClientRect();
    const width = Math.min(rect.width, innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
    const below = innerHeight - rect.bottom - 10, above = rect.top - 10;
    const flip = below < 160 && above > below;
    const space = Math.max(48, Math.min(270, flip ? above : below));
    menu.style.width = `${width}px`; menu.style.left = `${left}px`;
    menu.style.maxHeight = `${space}px`;
    menu.style.top = flip ? 'auto' : `${rect.bottom + 5}px`;
    menu.style.bottom = flip ? `${innerHeight - rect.top + 5}px` : 'auto';
  }
  function close() {
    if (supportsPopover && menu.matches(':popover-open')) menu.hidePopover();
    open = false; menu.hidden = true; active = -1;
    input.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant'); wrap.classList.remove('cp-combo-open');
  }
  function mark(index, scroll = true) {
    active = index;
    [...menu.querySelectorAll('[role=option]')].forEach((row, i) => {
      const selected = i === active;
      row.classList.toggle('cp-suggestion-active', selected);
      row.setAttribute('aria-selected', String(selected));
      if (selected) { input.setAttribute('aria-activedescendant', row.id); if (scroll) row.scrollIntoView({ block: 'nearest' }); }
    });
    if (active < 0) input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    const option = matches[index]; if (!option) return;
    input.value = option.value;
    // Close first: input events must not reopen an already accepted suggestion.
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close(); input.focus({ preventScroll: true });
  }
  function render() {
    if (!editable()) { close(); return; }
    const source = options(); const query = input.value.trim().toLowerCase();
    const exact = source.some(o => o.value.toLowerCase() === query);
    const filtered = all || exact ? source : source.filter(o => `${o.value} ${o.label || ''}`.toLowerCase().includes(query));
    matches = filtered.slice(0, 100); active = -1; menu.replaceChildren();
    for (let i = 0; i < matches.length; i++) {
      const option = matches[i]; const row = document.createElement('div'); row.className = 'cp-suggestion';
      row.id = `${menu.id}-${i}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
      const id = document.createElement('span'); id.className = 'cp-suggestion-id'; id.textContent = option.value; row.append(id);
      if (option.label && option.label !== option.value) { const detail = document.createElement('span'); detail.className = 'cp-suggestion-name'; detail.textContent = option.label; row.append(detail); }
      if (option.value === input.value.trim()) row.classList.add('cp-suggestion-current');
      row.dataset.index = String(i); menu.append(row);
    }
    if (!matches.length || filtered.length > matches.length) {
      const hint = document.createElement('p'); hint.className = 'cp-suggestions-hint';
      hint.textContent = !matches.length ? '没有匹配项，可直接输入自定义 ID' : '已显示前 100 项，输入可继续筛选'; menu.append(hint);
    }
    menu.hidden = false;
    if (!open) { open = true; if (supportsPopover) menu.showPopover(); }
    input.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant'); wrap.classList.add('cp-combo-open'); position();
  }
  menu.addEventListener('pointerdown', e => { const row = e.target.closest('[role=option]'); if (row && menu.contains(row)) { e.preventDefault(); choose(Number(row.dataset.index)); } }, { signal });
  menu.addEventListener('pointermove', e => { const row = e.target.closest('[role=option]'); if (row && menu.contains(row)) mark(Number(row.dataset.index), false); }, { signal });
  input.addEventListener('input', () => { all = false; if (document.activeElement === input) render(); }, { signal });
  input.addEventListener('click', () => { if (editable()) { all = false; render(); } }, { signal });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!editable()) return; e.preventDefault();
      if (!open) { all = true; render(); }
      mark(matches.length ? (active < 0 ? (e.key === 'ArrowDown' ? 0 : matches.length - 1) : (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length) : -1);
    } else if (e.key === 'Enter' && open && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close();
  }, { signal });
  trigger.addEventListener('pointerdown', e => e.preventDefault(), { signal });
  trigger.addEventListener('click', () => { if (!editable()) return; if (open) close(); else { input.focus({ preventScroll: true }); all = true; render(); } }, { signal });
  document.addEventListener('pointerdown', e => { if (open && !wrap.contains(e.target) && !menu.contains(e.target)) close(); }, { signal, capture: true });
  input.addEventListener('blur', () => { if (open) close(); }, { signal });
  owner.addEventListener('scroll', e => { if (!menu.contains(e.target)) position(); }, { signal, capture: true });
  window.addEventListener('resize', position, { signal });
  const sync = () => { trigger.hidden = !editable(); if (!editable()) close(); };
  const observer = new MutationObserver(sync); observer.observe(input, { attributes: true, attributeFilter: ['readonly', 'disabled'] }); sync();
  function dispose() { close(); observer.disconnect(); scope.abort(); menu.remove(); }
  owner.addEventListener('close', dispose, { once: true, signal });
  return { close, refresh() { if (open) render(); }, dispose };
}
