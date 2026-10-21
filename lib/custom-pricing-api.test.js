// lib/custom-pricing-api.test.js — 自定义计费 HTTP 面 + 查价语义测试
//
// 覆盖两件事：
//   1. 路由契约（GET / POST / remove / draft、CAS 冲突、镜像重铺）
//   2. 查价链的五条语义边界（原始供应商优先、USD 换算、null≠免费、
//      非 payg 归零、未知价不跨供应商借裸键）
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { createCustomPricingStore, validateEntry } from './custom-pricing-store.js';
import { registerCustomPricingRoutes, buildSubmissionDraft } from './custom-pricing-api.js';
import {
  priceFor,
  calcCost,
  setLocalPricing,
  PRICING,
  PROVIDER_OF_MODEL,
} from './usage-parser.js';

const TS = Date.parse('2026-10-21T12:00:00+08:00');

async function tmpStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-api-'));
  return createCustomPricingStore({ filePath: path.join(dir, 'custom-pricing.json') });
}

/** 极简 Hono 替身：只实现本模块用到的 get / post / c.json / c.req.json */
function makeApp() {
  const routes = new Map();
  const app = {
    get(p, h) { routes.set(`GET ${p}`, h); },
    post(p, h) { routes.set(`POST ${p}`, h); },
    async call(method, p, body) {
      const h = routes.get(`${method} ${p}`);
      if (!h) throw new Error(`没有注册路由 ${method} ${p}`);
      const c = {
        req: { json: async () => { if (body === undefined) throw new Error('no body'); return body; } },
        json: (obj, status = 200) => ({ status, body: obj }),
      };
      return h(c);
    },
  };
  return app;
}

const base = {
  providerId: 'openai',
  modelId: 'gpt-5.4',
  providerName: 'OpenAI 官方',
  billingType: 'payg',
  currency: 'USD',
  prices: { inputMiss: 2.5, inputHit: 0.25, output: 15 },
  notes: { sourceUrl: 'https://developers.openai.com/api/docs/pricing', note: '官方页' },
};

function resetMirror() {
  setLocalPricing({}, 0);
}

// ── 路由契约 ────────────────────────────────────────────────

test('GET 返回 entries / revision / fxUsd / providers', async () => {
  resetMirror();
  const store = await tmpStore();
  await store.upsert(base);
  const app = makeApp();
  registerCustomPricingRoutes(app, { store });

  const res = await app.call('GET', '/api/custom-pricing');
  assert.equal(res.status, 200);
  assert.equal(res.body.revision, 1);
  assert.equal(res.body.entries.length, 1);
  assert.equal(res.body.entries[0].modelId, 'gpt-5.4');
  assert.equal(typeof res.body.fxUsd, 'number');
  assert.equal(res.body.providers[0].providerId, 'openai');
  assert.deepEqual(res.body.providers[0].models, ['gpt-5.4']);
});

test('POST 保存后镜像立即生效，并返回新修订号', async () => {
  resetMirror();
  const store = await tmpStore();
  const app = makeApp();
  registerCustomPricingRoutes(app, { store });

  const res = await app.call('POST', '/api/custom-pricing', { entry: base });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.revision, 1);
  assert.equal(res.body.entry.modelId, 'gpt-5.4');

  // 镜像已重铺：查价链能直接命中，不需要重启
  const p = priceFor('gpt-5.4', TS, 'openai');
  assert.ok(p, '保存后应能查到自定义价');
  assert.equal(p.source, 'custom');
  // 2.5 USD × 6.8 = 17
  assert.equal(Math.round(p.inputMiss * 10) / 10, 17);

  resetMirror();
});

test('CAS：修订号不符返回 409 且不落盘', async () => {
  resetMirror();
  const store = await tmpStore();
  await store.upsert(base);
  const app = makeApp();
  registerCustomPricingRoutes(app, { store });

  const res = await app.call('POST', '/api/custom-pricing', {
    entry: { ...base, modelId: 'gpt-5.5' },
    expectedRevision: 0,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'revision-conflict');
  assert.equal(res.body.expected, 0);
  assert.equal(res.body.actual, 1);
  assert.equal((await store.list()).length, 1, '冲突时不能写入');

  resetMirror();
});

test('remove 删除条目并重铺镜像，重复删除是幂等的', async () => {
  resetMirror();
  const store = await tmpStore();
  await store.upsert(base);
  const app = makeApp();
  registerCustomPricingRoutes(app, { store });
  await app.call('POST', '/api/custom-pricing', { entry: base });

  const first = await app.call('POST', '/api/custom-pricing/remove', {
    providerId: 'openai',
    modelId: 'gpt-5.4',
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.removed, true);

  const second = await app.call('POST', '/api/custom-pricing/remove', {
    providerId: 'openai',
    modelId: 'gpt-5.4',
  });
  assert.equal(second.body.removed, false);
  assert.equal(second.body.revision, first.body.revision, '没删到东西不应涨修订号');

  resetMirror();
});

test('draft 只输出白名单内容，不包含本地路径与私有地址', async () => {
  const res = buildSubmissionDraft({
    ...base,
    notes: { sourceUrl: 'http://192.168.1.20:8080/pricing', note: '内网中转站' },
  });
  assert.equal(res.ok, true);
  assert.ok(res.title.includes('gpt-5.4'));
  assert.ok(res.body.includes('每百万 tokens'));
  assert.ok(!res.body.includes('192.168.1.20'), '私有地址必须被剔除');
  assert.ok(!res.body.includes('custom-pricing.json'), '不能泄露存储文件名');
  assert.ok(!res.body.includes('::'), '不能泄露存储键');
});

test('draft 拒绝非法条目，并限制正文长度', async () => {
  const bad = buildSubmissionDraft({ ...base, providerName: '' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('供应商显示名')));

  const longNote = 'x'.repeat(5000);
  const res = buildSubmissionDraft({ ...base, notes: { note: longNote } });
  assert.equal(res.ok, true);
  assert.ok(res.body.length <= 4000, '正文必须有长度上限');
});

test('draft 路由返回 title / body，不返回 URL', async () => {
  resetMirror();
  const store = await tmpStore();
  const app = makeApp();
  registerCustomPricingRoutes(app, { store });
  const res = await app.call('POST', '/api/custom-pricing/draft', { entry: base });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.title, 'string');
  assert.equal(typeof res.body.body, 'string');
  assert.equal(res.body.url, undefined, '外链应由前端拼，后端不给');
  assert.equal(res.body.complete, true);
  assert.ok(res.body.json, '需要给结构化片段便于入库');
});

test('draft 必须给出来源，否则拒绝', () => {
  const res = buildSubmissionDraft({ ...base, notes: {} });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('来源')), '缺来源应阻断');
});

test('draft 拒绝带凭据的来源链接', () => {
  const res = buildSubmissionDraft({
    ...base,
    notes: { sourceUrl: 'https://user:pass@example.com/pricing' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('用户名或密码')));
});

test('draft 剥离 query / hash / 尾斜杠', () => {
  const res = buildSubmissionDraft({
    ...base,
    notes: { sourceUrl: 'https://example.com/pricing/?token=abc#frag' },
  });
  assert.equal(res.ok, true);
  assert.ok(res.body.includes('https://example.com/pricing'));
  assert.ok(!res.body.includes('token=abc'));
  assert.ok(!res.body.includes('#frag'));
});

test('draft 允许价格不完整，但标 complete=false 且注明不可入库', () => {
  const res = buildSubmissionDraft({
    ...base,
    prices: { inputMiss: 2.5, inputHit: null, output: 15 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.complete, false);
  assert.ok(res.body.includes('不可直接并入公共库'));
  assert.ok(res.body.includes('```json'), '要带结构化片段');
  assert.equal(res.json.complete, false);
});

test('草稿里的敏感词只提示不阻断', () => {
  const res = buildSubmissionDraft({ ...base, notes: { note: '内网中转站自用' } });
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.includes('内网')));
});

// ── 查价语义 ────────────────────────────────────────────────

test('原始供应商身份先于 canonProvider', () => {
  resetMirror();
  // xai-oauth 会被 canonProvider 折成 xai；本地覆盖按原始身份存，必须先查到
  setLocalPricing({
    'xai-oauth::grok-4': {
      providerId: 'xai-oauth',
      modelId: 'grok-4',
      enabled: true,
      billingType: 'payg',
      currency: 'CNY',
      prices: { inputMiss: 7, inputHit: 1, output: 21 },
    },
  }, 1);
  const p = priceFor('grok-4', TS, 'xai-oauth');
  assert.ok(p, '应按原始供应商身份命中');
  assert.equal(p.inputMiss, 7);
  resetMirror();
});

test('模型 ID 允许斜杠', () => {
  const r = validateEntry({ ...base, modelId: 'meta-llama/Llama-3.3-70B' });
  assert.equal(r.ok, true);
  assert.equal(r.value.modelId, 'meta-llama/Llama-3.3-70B');

  const bad = validateEntry({ ...base, modelId: 'a::b' });
  assert.equal(bad.ok, false, '不能包含键分隔符');
});

test('USD 条目按汇率折算，不是把 2.5 美元当 2.5 元', () => {
  resetMirror();
  setLocalPricing({
    'p::usd-model': {
      providerId: 'p', modelId: 'usd-model', enabled: true,
      billingType: 'payg', currency: 'USD',
      prices: { inputMiss: 2, inputHit: 0.2, output: 10 },
    },
  }, 1);
  const p = priceFor('usd-model', TS, 'p');
  assert.equal(Math.round(p.inputMiss), 14); // 2 × 6.8
  assert.equal(Math.round(p.output), 68);    // 10 × 6.8
  resetMirror();
});

test('null 价格不等于免费：按量计费缺项视为未收录', () => {
  resetMirror();
  setLocalPricing({
    'p::incomplete': {
      providerId: 'p', modelId: 'incomplete', enabled: true,
      billingType: 'payg', currency: 'CNY',
      prices: { inputMiss: null, inputHit: null, output: 5 },
    },
  }, 1);
  assert.equal(priceFor('incomplete', TS, 'p'), null, '缺价必须算未知，不能算 0');
  assert.equal(calcCost(1e6, 0, 0, 0, 'incomplete', TS, 'p'), null);
  resetMirror();
});

test('0 价是免费：显式 0 必须被当作 0 参与计算', () => {
  resetMirror();
  setLocalPricing({
    'p::free-model': {
      providerId: 'p', modelId: 'free-model', enabled: true,
      billingType: 'payg', currency: 'CNY',
      prices: { inputMiss: 0, inputHit: 0, output: 0 },
    },
  }, 1);
  assert.equal(calcCost(1e6, 1e6, 1e6, 0, 'free-model', TS, 'p'), 0);
  resetMirror();
});

test('非 payg（订阅 / 本地 / 免费）边际成本为 0', () => {
  resetMirror();
  for (const billingType of ['subscription', 'local', 'free']) {
    setLocalPricing({
      [`p::${billingType}-model`]: {
        providerId: 'p', modelId: `${billingType}-model`, enabled: true,
        billingType, currency: 'CNY', prices: { inputMiss: null, inputHit: null, output: null },
      },
    }, 1);
    assert.equal(
      calcCost(1e6, 1e6, 1e6, 0, `${billingType}-model`, TS, 'p'),
      0,
      `${billingType} 的增量费用应为 0`,
    );
  }
  resetMirror();
});

test('未知价不跨供应商借裸键', () => {
  resetMirror();
  // 找一个公共裸键及其归属
  const bareKey = Object.keys(PRICING).find(
    (k) => !k.includes('::') && PROVIDER_OF_MODEL[k],
  );
  assert.ok(bareKey, '前提：公共表里应有带归属的裸键');
  const owner = PROVIDER_OF_MODEL[bareKey];

  assert.notEqual(priceFor(bareKey, TS, owner), null, '归属供应商应能查到');
  assert.equal(
    priceFor(bareKey, TS, 'relay-unknown'),
    null,
    '别的供应商不得借用这条裸键价格',
  );
});

test('存储层：enabled 必须是布尔值', () => {
  assert.equal(validateEntry({ ...base, enabled: true }).ok, true);
  assert.equal(validateEntry({ ...base, enabled: 1 }).ok, false);
  assert.equal(validateEntry({ ...base, enabled: 'true' }).ok, false);
});

test('存储层：读盘时丢弃损坏条目，不执行也不报成功', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-dirty-'));
  const filePath = path.join(dir, 'custom-pricing.json');
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      entries: {
        'openai::good': { ...base },
        'broken::one': { providerId: 'broken', modelId: '' },
        'broken::two': 'not-an-object',
      },
    }),
    'utf8',
  );
  const store = createCustomPricingStore({ filePath });
  const snap = await store.snapshot();
  assert.equal(snap.entries.length, 1, '只应留下合法条目');
  assert.equal(snap.droppedInvalid, 2);
  assert.equal(snap.revision, 4, '丢弃不应改写修订号');
});

test('自定义条目不污染公共价格表', async () => {
  resetMirror();
  const store = await tmpStore();
  const app = makeApp();
  registerCustomPricingRoutes(app, { store });
  const pubBefore = PRICING['deepseek::deepseek-v4-flash'];
  assert.ok(pubBefore, '前提：公共表里有这条');

  await app.call('POST', '/api/custom-pricing', {
    entry: {
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      providerName: 'DeepSeek 自定义',
      billingType: 'payg',
      currency: 'CNY',
      prices: { inputMiss: 1, inputHit: 0.1, output: 2 },
    },
  });
  assert.equal(PRICING['deepseek::deepseek-v4-flash'], pubBefore, '公共表对象不应被改写');

  resetMirror();
});
