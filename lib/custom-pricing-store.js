/**
 * Session Insight · 自定义计费存储模块（第一切片原型，未进仓库）
 *
 * 对应方案文档：session-insight-custom-pricing-plan-20261020.md 的「下一步第一切片」第 1 条
 * —— 自定义计费存储模块 + 校验（无界面）。
 *
 * 设计约束（全部来自方案文档）：
 *   1. 独立文件，独立目录，不依赖 UI；
 *   2. 校验失败一律不做部分写入；
 *   3. 写入串行，临时文件 + rename 原子替换，写失败必须抛错，不许回报成功；
 *   4. 零价格（0）与未填写（null）严格区分；undefined 视为非法输入；
 *   5. 覆盖条目的键是「供应商 ID + 模型 ID」，绝不用裸模型名兜底；
 *   6. 本地覆盖独立保存，公共库刷新后由 resolve() 重新组合，刷新不覆盖本地。
 *
 * 用法（宿主侧）：
 *   import { createCustomPricingStore } from './custom-pricing-store.mjs';
 *   const store = createCustomPricingStore({ filePath: '/path/custom-pricing.json' });
 *   await store.upsert({ providerId: 'openai', modelId: 'gpt-5.4', ... });
 *   const resolved = await store.resolve('openai', 'gpt-5.4', publicPricing);
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
export const STORE_FILENAME = 'custom-pricing.json';

export const BILLING_TYPES = ['payg', 'subscription', 'local', 'free'];
export const CURRENCIES = ['CNY', 'USD'];
export const PRICE_FIELDS = ['inputMiss', 'inputHit', 'output', 'cacheWrite'];

export class StoreValidationError extends Error {
  constructor(errors) {
    super(`自定义计费条目校验失败：${errors.join('；')}`);
    this.name = 'StoreValidationError';
    this.errors = errors;
  }
}

export class StoreCorruptError extends Error {
  constructor(filePath, cause) {
    super(`自定义计费文件损坏，拒绝自动覆盖：${filePath}`);
    this.name = 'StoreCorruptError';
    this.cause = cause;
  }
}

const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeId(raw, label, errors) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push(`${label} 必须是非空字符串`);
    return null;
  }
  const id = raw.trim();
  if (!ID_PATTERN.test(id)) {
    errors.push(`${label} 含非法字符：${id}`);
    return null;
  }
  if (id !== id.toLowerCase() && label === '供应商 ID') {
    // 供应商 ID 统一小写，避免 openai 与 OpenAI 分裂成两条
    return id.toLowerCase();
  }
  return id;
}

/**
 * 校验单个自定义计费条目。
 * 返回 { ok, value, errors }。value 是归一化后的副本，不含未声明字段。
 *
 * 价格字段语义（关键）：
 *   null      用户明确表示「这一项不适用/未填写」
 *   0         明确的零价格（免费额度），必须照原样参与计算
 *   undefined 非法输入，报错（防止 «没填» 被当成免费）
 */
export function validateEntry(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, value: null, errors: ['条目必须是对象'] };
  }

  const providerId = normalizeId(input.providerId, '供应商 ID', errors);
  const modelId = normalizeId(input.modelId, '模型 ID', errors);
  if (input.modelId !== undefined && typeof input.modelId === 'string' && input.modelId.trim() !== modelId) {
    // 模型 ID 保留大小写，只做 trim
  }

  const providerName = typeof input.providerName === 'string' ? input.providerName.trim() : '';
  if (!providerName) errors.push('供应商显示名不能为空');

  const billingType = input.billingType ?? 'payg';
  if (!BILLING_TYPES.includes(billingType)) {
    errors.push(`计费类型必须是 ${BILLING_TYPES.join(' / ')}`);
  }

  const currency = input.currency ?? 'CNY';
  if (!CURRENCIES.includes(currency)) {
    errors.push(`币种必须是 ${CURRENCIES.join(' / ')}`);
  }

  const prices = isPlainObject(input.prices) ? input.prices : null;
  if (!prices) {
    if (billingType === 'payg') errors.push('按量计费必须提供 prices');
  }
  const normalizedPrices = {};
  for (const field of PRICE_FIELDS) {
    const raw = prices ? prices[field] : undefined;
    if (raw === undefined) {
      if (field !== 'cacheWrite' && billingType === 'payg') {
        errors.push(`缺少价格字段 ${field}（不适用请显式写 null）`);
      }
      normalizedPrices[field] = null;
      continue;
    }
    if (raw === null) {
      normalizedPrices[field] = null;
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      errors.push(`价格字段 ${field} 必须是数字或 null，收到 ${JSON.stringify(raw)}（字符串数字不接受）`);
      continue;
    }
    if (raw < 0) {
      errors.push(`价格字段 ${field} 不能为负数`);
      continue;
    }
    normalizedPrices[field] = raw;
  }

  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);

  const notes = isPlainObject(input.notes) ? input.notes : {};
  const normalizedNotes = {
    sourceUrl: typeof notes.sourceUrl === 'string' ? notes.sourceUrl.trim() : '',
    note: typeof notes.note === 'string' ? notes.note.trim() : '',
  };
  if (normalizedNotes.sourceUrl && !/^https?:\/\//i.test(normalizedNotes.sourceUrl)) {
    errors.push('来源链接必须是 http(s) 地址');
  }

  const updatedAt = typeof input.updatedAt === 'string' && input.updatedAt.trim()
    ? input.updatedAt.trim()
    : new Date().toISOString().slice(0, 10);

  if (errors.length) return { ok: false, value: null, errors };

  return {
    ok: true,
    errors: [],
    value: {
      providerId,
      modelId,
      providerName,
      billingType,
      currency,
      unit: 'per_million_tokens',
      prices: normalizedPrices,
      enabled,
      notes: normalizedNotes,
      updatedAt,
    },
  };
}

export function entryKey(providerId, modelId) {
  return `${providerId}::${modelId}`;
}

/**
 * 从解析后的 pricing.json 里取一条公共价格，键必须是「供应商 + 模型」，不做裸模型名兜底。
 */
export function lookupPublic(publicPricing, providerId, modelId) {
  if (!isPlainObject(publicPricing)) return null;
  const models = isPlainObject(publicPricing.models) ? publicPricing.models : null;
  if (!models) return null;
  const key = entryKey(providerId, modelId);
  if (Object.prototype.hasOwnProperty.call(models, key)) {
    return { entry: models[key], key, matchedBy: 'public-exact' };
  }
  return null;
}

export function createCustomPricingStore(options = {}) {
  const filePath = options.filePath || path.join(process.cwd(), STORE_FILENAME);
  const io = options.fs || fsp;
  let queue = Promise.resolve();
  let loaded = null;

  async function readState() {
    if (loaded) return loaded;
    let text;
    try {
      text = await io.readFile(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        loaded = { schemaVersion: SCHEMA_VERSION, revision: 0, entries: {} };
        return loaded;
      }
      throw err;
    }
    text = text.replace(/^\uFEFF/, '');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new StoreCorruptError(filePath, err);
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.entries)) {
      throw new StoreCorruptError(filePath, new Error('结构不是 { entries: {} }'));
    }
    const revision = Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
    loaded = { schemaVersion: parsed.schemaVersion || SCHEMA_VERSION, revision, entries: parsed.entries };
    return loaded;
  }

  async function writeState(state) {
    const dir = path.dirname(filePath);
    await io.mkdir(dir, { recursive: true });
    const payload = JSON.stringify(
      { schemaVersion: SCHEMA_VERSION, revision: state.revision, entries: state.entries },
      null,
      2,
    ) + '\n';
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await io.writeFile(tmp, payload, 'utf8');
    try {
      await io.rename(tmp, filePath); // 同目录 rename，原子替换
    } catch (err) {
      await io.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  // 所有写操作串行化：同一时刻只有一条在跑，失败的那条不会污染后续
  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  return {
    get filePath() {
      return filePath;
    },

    async list() {
      const state = await readState();
      return Object.values(state.entries);
    },

    /** 修订号：任何一次成功落盘的 upsert/remove 都 +1。统计侧把它拼进缓存键即可让旧结果失效。 */
    async revision() {
      const state = await readState();
      return state.revision;
    },

    async get(providerId, modelId) {
      const state = await readState();
      return state.entries[entryKey(String(providerId).toLowerCase(), modelId)] || null;
    },

    async upsert(input) {
      const result = validateEntry(input);
      if (!result.ok) throw new StoreValidationError(result.errors);
      return enqueue(async () => {
        const state = await readState();
        const key = entryKey(result.value.providerId, result.value.modelId);
        const next = {
          schemaVersion: state.schemaVersion,
          revision: state.revision + 1,
          entries: { ...state.entries, [key]: result.value },
        };
        await writeState(next); // 抛错就不更新内存，也不报成功
        loaded = next;
        return result.value;
      });
    },

    async remove(providerId, modelId) {
      return enqueue(async () => {
        const state = await readState();
        const key = entryKey(String(providerId).toLowerCase(), modelId);
        if (!state.entries[key]) return false;
        const entries = { ...state.entries };
        delete entries[key];
        const next = { schemaVersion: state.schemaVersion, revision: state.revision + 1, entries };
        await writeState(next);
        loaded = next;
        return true;
      });
    },

    /**
     * 组合解析：本地精确（供应商+模型）→ 公共库精确 → 未收录。
     * 受控官方别名这一层留空接口，等有确定的别名表再填。
     */
    async resolve(providerId, modelId, publicPricing, aliasTable = {}) {
      const pid = String(providerId).toLowerCase();
      const local = await this.get(pid, modelId);
      if (local && local.enabled) {
        return {
          source: 'custom',
          providerId: pid,
          modelId,
          billingType: local.billingType,
          currency: local.currency,
          unit: local.unit,
          prices: local.prices,
          entry: local,
        };
      }
      const pub = lookupPublic(publicPricing, pid, modelId);
      if (pub) {
        return {
          source: 'public',
          providerId: pid,
          modelId,
          billingType: 'payg',
          currency: publicPricing.currency || 'USD',
          unit: publicPricing.unit || 'per_million_tokens',
          prices: pub.entry.flat || pub.entry.prices || null,
          entry: pub.entry,
        };
      }
      const alias = aliasTable[`${pid}::${modelId}`];
      if (alias) {
        return this.resolve(alias.providerId, alias.modelId, publicPricing, {});
      }
      return { source: 'unrecorded', providerId: pid, modelId, prices: null, entry: null };
    },

    /**
     * 供界面/统计层一次拿全：确保跨供应商同名不串价，并暴露重合条目数，
     * 让「公共与本地都命中」的情况可以显示成「自定义覆盖公共价」。
     */
    async resolveAll(publicPricing, pairs) {
      const out = [];
      let overlap = 0;
      for (const pair of pairs) {
        const r = await this.resolve(pair.providerId, pair.modelId, publicPricing);
        if (r.source === 'custom') {
          const pub = lookupPublic(publicPricing, r.providerId, r.modelId);
          if (pub) overlap += 1;
        }
        out.push(r);
      }
      return { items: out, overlap };
    },
  };
}

/** 若宿主把价格表当作整体替换对象，用它做「刷新后重组合」：本地覆盖永远在公共之上。 */
export async function composeAfterRefresh(store, publicPricing) {
  const localEntries = await store.list();
  const overrides = new Map();
  for (const entry of localEntries) {
    if (entry.enabled) overrides.set(entryKey(entry.providerId, entry.modelId), entry);
  }
  const merged = new Map();
  const models = isPlainObject(publicPricing?.models) ? publicPricing.models : {};
  for (const [key, value] of Object.entries(models)) {
    merged.set(key, { source: 'public', entry: value });
  }
  for (const [key, value] of overrides) {
    merged.set(key, { source: 'custom', entry: value });
  }
  return merged;
}

export default createCustomPricingStore;
