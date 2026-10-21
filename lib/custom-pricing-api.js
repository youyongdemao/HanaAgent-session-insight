// lib/custom-pricing-api.js —— 自定义计费的 HTTP 面
//
// 只负责：读写自定义价、重铺同步镜像、生成投稿草稿。
// 不碰 index.js（接线由主线程做），不碰 ui/。
//
// 变更通知走「修订号 + 前端轮询」，不发射 app 事件：
// manifest 没声明 app/events.emit，硬发只会在宿主侧失败。

import {
  setLocalPricing,
  getFxUsd,
} from './usage-parser.js';

import {
  validateEntry,
  StoreValidationError,
  StoreCorruptError,
  RevisionConflictError,
} from './custom-pricing-store.js';

// 投稿草稿的长度上限：够写清一条价格，又不会被拿来塞整份价格库。
const DRAFT_TITLE_MAX = 120;
const DRAFT_BODY_MAX = 4000;
const DRAFT_FIELD_MAX = 200;

// 只做提示、不做阻断：这些词命中不一定有问题，但值得投稿前人工看一眼。
const SENSITIVE_WORDS = ['内网', '私有', '自用', '测试', 'test', '中转', '临时', 'dev'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function oneLine(value, max = DRAFT_FIELD_MAX) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/`/g, "'")
    .trim()
    .slice(0, max);
}

function fmtPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}

/** 私有 / 本机主机名：IPv4 私有段、IPv6 本机与 ULA/链路本地、.local 域。 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (/^(127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true; // fc00::/7（ULA）
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;  // fe80::/10（链路本地）
  return false;
}

/**
 * 来源链接净化：只留 origin + pathname。
 * 凭据（user:pass@）直接拒绝；私网/本机地址剔除并给出提示；query 与 hash 一律丢弃
 * （常见于带 token 的临时链接）。
 */
function inspectSourceUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { url: '', warnings: [], error: null };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { url: '', warnings: ['来源链接不是合法 URL，已移除'], error: null };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { url: '', warnings: ['来源链接必须是 http(s)，已移除'], error: null };
  }
  if (u.username || u.password) {
    return { url: '', warnings: [], error: '来源链接不能包含用户名或密码' };
  }
  if (isPrivateHost(u.hostname)) {
    return { url: '', warnings: ['来源链接指向私有地址，已移除'], error: null };
  }
  const path = u.pathname.replace(/\/+$/, '');
  return { url: `${u.origin}${path === '/' ? '' : path}`, warnings: [], error: null };
}

function sensitiveWarnings(e) {
  const hay = [e.providerName, e.modelId, e.notes?.note].join(' ').toLowerCase();
  const hit = SENSITIVE_WORDS.filter((w) => hay.includes(w.toLowerCase()));
  return hit.length
    ? [`名称或备注里出现「${hit.join('、')}」，投稿前请确认不含内网或私有信息`]
    : [];
}

function priceCompleteness(e) {
  if ((e.billingType || 'payg') !== 'payg') return { complete: true, missing: [] };
  const missing = ['inputMiss', 'inputHit', 'output'].filter(
    (f) => typeof e.prices?.[f] !== 'number',
  );
  return { complete: missing.length === 0, missing };
}

/** 草稿宽松归一：投稿允许“价格还没填全”，标识不合法才拒绝。 */
function lenientEntry(input) {
  const prices = isPlainObject(input.prices) ? input.prices : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const notes = isPlainObject(input.notes) ? input.notes : {};
  return {
    providerId: String(input.providerId || '').trim().toLowerCase(),
    modelId: String(input.modelId || '').trim(),
    providerName: String(input.providerName || '').trim(),
    billingType: input.billingType || 'payg',
    currency: input.currency || 'CNY',
    prices: {
      inputMiss: num(prices.inputMiss),
      inputHit: num(prices.inputHit),
      output: num(prices.output),
      cacheWrite: num(prices.cacheWrite),
    },
    notes: {
      sourceUrl: String(notes.sourceUrl || '').trim(),
      note: String(notes.note || '').trim(),
    },
    updatedAt: String(input.updatedAt || '').trim() || new Date().toISOString().slice(0, 10),
  };
}

/**
 * 生成投稿草稿。返回 { ok, title, body, json, warnings, complete, blockers }。
 *
 * 阻断项（ok=false）：标识字段非法、来源缺失、来源链接带凭据。
 * 提示项（warnings）：私网链接被移除、敏感词命中。
 * 价格不完整不阻断草稿，但 complete=false 且正文明确写「不可直接并入公共库」。
 */
export function buildSubmissionDraft(input) {
  if (!isPlainObject(input)) return { ok: false, errors: ['条目必须是对象'] };

  const validated = validateEntry(input);
  const blocking = validated.ok
    ? []
    : validated.errors.filter((msg) => !/价格字段|缺少价格字段/.test(msg));
  if (blocking.length) return { ok: false, errors: blocking };

  const e = validated.ok ? validated.value : lenientEntry(input);
  const warnings = [];

  const source = inspectSourceUrl(e.notes.sourceUrl);
  if (source.error) return { ok: false, errors: [source.error] };
  warnings.push(...source.warnings);
  if (!source.url && !e.notes.note) {
    return { ok: false, errors: ['投稿必须给出来源：至少填写来源链接或来源说明'] };
  }

  const { complete, missing } = priceCompleteness(e);
  warnings.push(...sensitiveWarnings(e));

  const json = {
    schemaVersion: 1,
    provider: {
      id: oneLine(e.providerId),
      name: oneLine(e.providerName),
      billingType: oneLine(e.billingType),
    },
    model: {
      id: oneLine(e.modelId, 200),
      currency: oneLine(e.currency),
      unit: 'per_million_tokens',
    },
    prices: {
      inputMiss: e.prices.inputMiss,
      inputHit: e.prices.inputHit,
      output: e.prices.output,
      cacheWrite: e.prices.cacheWrite,
    },
    source: {
      url: source.url,
      note: oneLine(e.notes.note),
    },
    updatedAt: e.updatedAt,
    complete,
  };

  const lines = [
    '### 供应商',
    `- ID：${oneLine(e.providerId)}`,
    `- 显示名：${oneLine(e.providerName)}`,
    `- 计费模式：${oneLine(e.billingType)}`,
    '',
    '### 模型',
    `- ID：${oneLine(e.modelId, 200)}`,
    `- 币种：${oneLine(e.currency)}`,
    '- 单价（每百万 tokens）',
    `  - 未命中输入：${fmtPrice(e.prices.inputMiss)}`,
    `  - 缓存命中：${fmtPrice(e.prices.inputHit)}`,
    `  - 输出：${fmtPrice(e.prices.output)}`,
    `  - 缓存写入：${fmtPrice(e.prices.cacheWrite)}`,
    '',
    '### 来源',
  ];
  if (source.url) lines.push(`- 链接：${source.url}`);
  if (e.notes.note) lines.push(`- 说明：${oneLine(e.notes.note)}`);
  lines.push('', '### 更新时间', e.updatedAt, '', '### 入库状态');

  if (complete) {
    lines.push('- 价格完整，可按结构化片段并入公共库。');
  } else {
    lines.push(
      `- ⚠ 价格不完整（缺：${missing.join('、')}），仅作草稿，不可直接并入公共库。`,
    );
  }

  lines.push('', '```json', JSON.stringify(json, null, 2), '```');

  const title = oneLine(`[价格投稿] ${e.providerName} / ${e.modelId}`, DRAFT_TITLE_MAX);
  let body = lines.join('\n');
  if (body.length > DRAFT_BODY_MAX) body = body.slice(0, DRAFT_BODY_MAX);

  return { ok: true, title, body, json, warnings, complete, blockers: [] };
}

/**
 * 把已启用的本地条目铺进 usage-parser 的同步镜像。
 * 返回镜像当前的修订号（等于磁盘上的最新修订号）。
 */
export async function rebuildLocalPricingMirror(store) {
  const snap = await store.snapshot();
  const mirror = Object.create(null);
  for (const entry of snap.entries) {
    if (!entry || !entry.enabled) continue;
    mirror[`${entry.providerId}::${entry.modelId}`] = entry;
  }
  setLocalPricing(mirror, snap.revision);
  return snap.revision;
}

/** 供应商聚合：给设置页的分组和 /api/pricing 的显示名用。 */
function summarizeProviders(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (!entry) continue;
    let row = byId.get(entry.providerId);
    if (!row) {
      row = {
        providerId: entry.providerId,
        providerName: entry.providerName,
        billingType: entry.billingType,
        models: [],
      };
      byId.set(entry.providerId, row);
    }
    row.models.push(entry.modelId);
  }
  return [...byId.values()];
}

function mapError(c, error) {
  if (error instanceof StoreValidationError) {
    return c.json({ ok: false, error: 'validation', errors: error.errors }, 400);
  }
  if (error instanceof RevisionConflictError) {
    return c.json(
      { ok: false, error: 'revision-conflict', expected: error.expected, actual: error.actual },
      409,
    );
  }
  if (error instanceof StoreCorruptError) {
    return c.json({ ok: false, error: 'store-corrupt', message: error.message }, 500);
  }
  return c.json({ ok: false, error: 'internal', message: String(error?.message || error) }, 500);
}

async function readJsonBody(c) {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * 注册四条自定义计费路由。
 * @param {object} app  Hono 实例
 * @param {{ sdk?: object, ctx?: object, store: object }} deps
 */
export function registerCustomPricingRoutes(app, { sdk, ctx, store } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('registerCustomPricingRoutes 需要一个 Hono 实例');
  }
  if (!store || typeof store.snapshot !== 'function') {
    throw new TypeError('registerCustomPricingRoutes 需要 customPricingStore');
  }

  app.get('/api/custom-pricing', async (c) => {
    try {
      const snap = await store.snapshot();
      return c.json({
        entries: snap.entries,
        revision: snap.revision,
        droppedInvalid: snap.droppedInvalid || 0,
        fxUsd: getFxUsd(),
        providers: summarizeProviders(snap.entries),
      });
    } catch (error) {
      return mapError(c, error);
    }
  });

  app.post('/api/custom-pricing', async (c) => {
    const body = await readJsonBody(c);
    if (!body || typeof body !== 'object') {
      return c.json({ ok: false, error: 'invalid-body' }, 400);
    }
    try {
      const saved = await store.upsert(body.entry, { expectedRevision: body.expectedRevision });
      const revision = await rebuildLocalPricingMirror(store);
      return c.json({ ok: true, entry: saved.entry, revision });
    } catch (error) {
      return mapError(c, error);
    }
  });

  app.post('/api/custom-pricing/remove', async (c) => {
    const body = await readJsonBody(c);
    if (!body || typeof body !== 'object') {
      return c.json({ ok: false, error: 'invalid-body' }, 400);
    }
    if (typeof body.providerId !== 'string' || typeof body.modelId !== 'string') {
      return c.json({ ok: false, error: 'invalid-body' }, 400);
    }
    try {
      const result = await store.remove(body.providerId, body.modelId, {
        expectedRevision: body.expectedRevision,
      });
      const revision = await rebuildLocalPricingMirror(store);
      // 删除不存在的条目是幂等的：报 ok 但不涨修订号
      return c.json({ ok: true, removed: result.removed, revision });
    } catch (error) {
      return mapError(c, error);
    }
  });

  app.post('/api/custom-pricing/draft', async (c) => {
    const body = await readJsonBody(c);
    if (!body || typeof body !== 'object') {
      return c.json({ ok: false, error: 'invalid-body' }, 400);
    }
    const draft = buildSubmissionDraft(body.entry);
    if (!draft.ok) {
      return c.json({ ok: false, error: 'validation', errors: draft.errors }, 400);
    }
    // 外链由前端拼，后端只给标题、正文与结构化片段，避免把仓库地址写死在这里。
    return c.json({
      ok: true,
      title: draft.title,
      body: draft.body,
      json: draft.json,
      warnings: draft.warnings,
      complete: draft.complete,
    });
  });

  return { rebuildLocalPricingMirror };
}

export default registerCustomPricingRoutes;
