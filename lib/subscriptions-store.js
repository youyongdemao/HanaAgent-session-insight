// Private subscription ledger. Never exported in public pricing contributions.
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const clone = value => structuredClone(value);
const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
function timestamp(value, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw err('validation', `${name}必须是含时区的有效日期`);
  return new Date(value).toISOString();
}
export function normalizeSubscription(input, previous, { fxUsd = 1, trusted = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw err('validation', '套餐记录必须是对象');
  const providerId = String(input.providerId || '').trim().toLowerCase();
  const planName = String(input.planName || '').trim();
  if (!/^[a-z0-9][a-z0-9._:-]{0,159}$/.test(providerId)) throw err('validation', '供应商 ID 无效');
  if (!planName || planName.length > 160) throw err('validation', '套餐名称不能为空且不能超过160字符');
  const validFrom = timestamp(input.validFrom, '生效时间'), validTo = timestamp(input.validTo, '结束时间');
  if (validFrom && validTo && Date.parse(validTo) <= Date.parse(validFrom)) throw err('validation', '结束时间必须晚于生效时间');
  const amount = input.amount == null || input.amount === '' ? null : input.amount;
  if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e9)) throw err('validation', '实付金额必须是非负数字或留空');
  const currency = input.currency || 'CNY';
  if (!['CNY', 'USD'].includes(currency)) throw err('validation', '币种仅支持 CNY / USD');
  let fxRate = currency === 'CNY' ? 1 : input.fxRate ?? (previous?.currency === currency ? previous.fxRate : null) ?? fxUsd;
  if (currency === 'USD' && (typeof fxRate !== 'number' || !Number.isFinite(fxRate) || fxRate <= 0)) throw err('validation', '美元入账汇率必须大于0');
  const enabled = input.enabled === undefined ? previous?.enabled ?? true : input.enabled;
  if (typeof enabled !== 'boolean') throw err('validation', '启用状态必须是布尔值');
  const source = trusted ? input.source || 'official' : previous?.source || 'manual';
  if (!['manual', 'official'].includes(source)) throw err('validation', '来源无效');
  // Officially verified dates cannot be silently overwritten by a user save.
  if (!trusted && previous?.source === 'official') {
    if (previous.officialFrom && previous.validFrom !== validFrom) throw err('validation', '官方生效时间不可修改，请同步更新');
    if (previous.officialTo && previous.validTo !== validTo) throw err('validation', '官方结束时间不可修改，请同步更新');
  }
  const id = previous?.id || (trusted && input.id ? input.id : randomUUID());
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(id)) throw err('validation', '记录 ID 无效');
  return { id, providerId, planName, validFrom, validTo, amount, currency, fxRate, enabled, source,
    externalId: trusted ? String(input.externalId || '').slice(0, 200) || null : previous?.externalId || null,
    planKind: trusted ? input.planKind || 'coding' : previous?.planKind || 'coding',
    scope: trusted ? input.scope || 'personal' : previous?.scope || 'personal',
    officialFrom: trusted ? !!input.officialFrom : !!previous?.officialFrom,
    officialTo: trusted ? !!input.officialTo : !!previous?.officialTo,
    syncedAt: trusted ? input.syncedAt || null : previous?.syncedAt || null,
    updatedAt: new Date().toISOString() };
}

export function createSubscriptionsStore({ filePath }) {
  let state = null, loading = null, queue = Promise.resolve();
  async function load() {
    if (state) return;
    if (loading) return loading;
    loading = (async () => {
      let raw;
      try { raw = await readFile(filePath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; state = { schemaVersion: 1, revision: 0, entries: [], ignoredIds: [] }; return; }
      try {
        const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
        if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.entries)) throw new Error();
        const ids = new Set(), entries = [];
        for (const e of data.entries) {
          const normalized = normalizeSubscription(e, e, { trusted: true });
          if (!e.id || ids.has(e.id)) throw new Error(); ids.add(e.id);
          entries.push({ ...normalized, updatedAt: e.updatedAt || normalized.updatedAt });
        }
        if (data.ignoredIds !== undefined && (!Array.isArray(data.ignoredIds) || data.ignoredIds.some(id => typeof id !== 'string' || !/^official-[a-f0-9]{40}$/.test(id)))) throw new Error();
        state = { schemaVersion: 1, revision: data.revision, entries, ignoredIds: data.ignoredIds || [] };
      } catch { throw err('store-corrupt', '订阅账本文件损坏，已停止写入以保护原数据', 500); }
    })();
    try { await loading; } finally { loading = null; }
  }
  const serialize = fn => { const work = queue.then(fn); queue = work.catch(() => {}); return work; };
  async function persist(entries, ignoredIds = state.ignoredIds || []) {
    const next = { schemaVersion: 1, revision: state.revision + 1, entries, ignoredIds };
    await mkdir(dirname(filePath), { recursive: true });
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, filePath); } finally { await rm(temp, { force: true }).catch(() => {}); }
    state = next;
  }
  function cas(revision) {
    if (revision !== undefined && revision !== state.revision) throw err('revision-conflict', '订阅记录已被另一窗口修改，请刷新后重试', 409);
  }
  return {
    async snapshot() { await queue; await load(); return clone(state); },
    upsert(input, revision, options = {}) { return serialize(async () => {
      await load(); cas(revision);
      const previous = input.id ? state.entries.find(e => e.id === input.id) : null;
      if (input.id && !previous) throw err('validation', '记录不存在，请刷新');
      const value = normalizeSubscription(input, previous, options);
      const entries = state.entries.filter(e => e.id !== value.id).concat(value);
      if (value.enabled && value.externalId && value.validFrom && value.validTo && value.amount != null) {
        const overlap = entries.some(e => e.id !== value.id && e.enabled && e.amount != null && e.externalId === value.externalId && e.providerId === value.providerId && e.scope === value.scope && e.validFrom && e.validTo && Date.parse(e.validFrom) < Date.parse(value.validTo) && Date.parse(value.validFrom) < Date.parse(e.validTo));
        if (overlap) throw err('validation', '同一官方订阅已有重叠计费周期，请先修正或停用旧记录，避免重复计费');
      }
      await persist(entries); return { entry: clone(value), revision: state.revision };
    }); },
    remove(id, revision) { return serialize(async () => {
      await load(); cas(revision); const target = state.entries.find(e => e.id === id); const entries = state.entries.filter(e => e.id !== id);
      const removed = !!target;
      if (removed) await persist(entries, target.source === 'official' ? [...new Set([...(state.ignoredIds || []), id])] : state.ignoredIds || []);
      return { removed, revision: state.revision };
    }); },
    mergeOfficial(records) { return serialize(async () => {
      await load(); const entries = clone(state.entries); let changed = false;
      for (const record of records) {
        if (!record.validTo || !record.externalId) continue;
        // End-time is part of identity: a changed entitlement does not rewrite old paid periods.
        const key = createHash('sha256').update(`${record.providerId}|${record.planKind}|${record.scope}|${record.externalId}|${record.validTo}`).digest('hex').slice(0, 40);
        const id = 'official-' + key;
        if (state.ignoredIds?.includes(id)) continue;
        const index = entries.findIndex(e => e.id === id); const prev = entries[index];
        const candidate = { ...record, id, source: 'official', amount: prev?.amount ?? record.amount ?? null,
          currency: prev?.currency || record.currency || 'CNY', fxRate: prev?.fxRate || 1, enabled: prev?.enabled ?? true,
          validFrom: record.validFrom || prev?.validFrom || null, officialFrom: !!record.validFrom, officialTo: true };
        const value = normalizeSubscription(candidate, prev, { trusted: true });
        if (value.enabled && value.amount != null && value.validFrom && value.validTo && entries.some(e => e.id !== value.id && e.enabled && e.amount != null && e.providerId === value.providerId && e.externalId === value.externalId && e.scope === value.scope && e.validFrom && e.validTo && Date.parse(e.validFrom) < Date.parse(value.validTo) && Date.parse(value.validFrom) < Date.parse(e.validTo))) continue;
        const signature = e => JSON.stringify({ ...e, updatedAt: null, syncedAt: null });
        if (prev && signature(prev) === signature(value)) continue;
        if (index >= 0) entries[index] = value; else entries.push(value); changed = true;
      }
      if (changed) await persist(entries);
      return clone(state);
    }); },
  };
}

export function subscriptionCost(entry, from, to) {
  if (!entry.enabled || entry.amount == null || !entry.validFrom || !entry.validTo) return 0;
  const start = Date.parse(entry.validFrom), end = Date.parse(entry.validTo);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const overlap = Math.max(0, Math.min(end, to) - Math.max(start, from));
  return entry.amount * (entry.fxRate || 1) * overlap / (end - start);
}
export function summarizeSubscriptions(entries, { now = Date.now(), from = 0, providerId } = {}) {
  const selected = entries.filter(e => e.enabled && (!providerId || e.providerId === providerId));
  const incomplete = e => e.amount == null || !e.validFrom || !e.validTo;
  const rows = selected.map(e => ({ id: e.id, providerId: e.providerId, costCny: subscriptionCost(e, from, now), incomplete: incomplete(e) }));
  return { costCny: rows.reduce((n, e) => n + e.costCny, 0), paidCny: selected.reduce((n, e) => n + (e.amount == null ? 0 : e.amount * e.fxRate), 0),
    incompleteCount: rows.filter(e => e.incomplete).length, perProvider: Object.fromEntries([...new Set(rows.map(e => e.providerId))].map(p => [p, rows.filter(e => e.providerId === p).reduce((n, e) => n + e.costCny, 0)])) };
}
