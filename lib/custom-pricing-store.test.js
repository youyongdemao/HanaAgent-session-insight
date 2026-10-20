import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  createCustomPricingStore,
  validateEntry,
  composeAfterRefresh,
  StoreValidationError,
  StoreCorruptError,
} from './custom-pricing-store.js';

async function tmpStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-store-'));
  return createCustomPricingStore({ filePath: path.join(dir, 'custom-pricing.json') });
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

const publicPricing = {
  currency: 'USD',
  unit: 'per_million_tokens',
  models: {
    'openai::gpt-5.4': { flat: { inputMiss: 17, inputHit: 1.7, output: 102 } },
    'openai::gpt-5.4-mini': { flat: { inputMiss: 5.1, inputHit: 0.51, output: 30.6 } },
  },
};

test('零价格与未填写严格区分', () => {
  const zero = validateEntry({ ...base, prices: { inputMiss: 0, inputHit: null, output: 15 } });
  assert.equal(zero.ok, true);
  assert.equal(zero.value.prices.inputMiss, 0);
  assert.equal(zero.value.prices.inputHit, null);

  const missing = validateEntry({ ...base, prices: { output: 15 } });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes('inputMiss')));

  const undef = validateEntry({ ...base, prices: { inputMiss: undefined, inputHit: 0.25, output: 15 } });
  assert.equal(undef.ok, false);
});

test('字符串数字与负数被拒', () => {
  assert.equal(validateEntry({ ...base, prices: { inputMiss: '2.5', inputHit: 0.25, output: 15 } }).ok, false);
  assert.equal(validateEntry({ ...base, prices: { inputMiss: -1, inputHit: 0.25, output: 15 } }).ok, false);
});

test('供应商 ID 归一化小写，同一条目不会分裂成两条', async () => {
  const store = await tmpStore();
  await store.upsert({ ...base, providerId: 'OpenAI' });
  await store.upsert({ ...base, providerId: 'openai', prices: { inputMiss: 3, inputHit: 0.3, output: 18 } });
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.get('openai', 'gpt-5.4')).prices.inputMiss, 3);
});

test('写入失败不报成功，内存状态不被污染', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-fail-'));
  const filePath = path.join(dir, 'custom-pricing.json');
  const fake = {
    ...fsp,
    rename: async () => { const e = new Error('EPERM: 文件被占用'); e.code = 'EPERM'; throw e; },
  };
  const store = createCustomPricingStore({ filePath, fs: fake });
  await assert.rejects(() => store.upsert(base), /EPERM/);
  assert.deepEqual(await store.list(), []);
  const leftovers = (await fsp.readdir(dir)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '临时文件必须清理');
});

test('串行写入：并发 upsert 不互相覆盖', async () => {
  const store = await tmpStore();
  await Promise.all([
    store.upsert({ ...base, modelId: 'a' }),
    store.upsert({ ...base, modelId: 'b' }),
    store.upsert({ ...base, modelId: 'c' }),
  ]);
  const names = (await store.list()).map((e) => e.modelId).sort();
  assert.deepEqual(names, ['a', 'b', 'c']);
});

test('跨供应商同名模型不串价', async () => {
  const store = await tmpStore();
  await store.upsert({ ...base, providerId: 'relay-x', providerName: '中转 X', modelId: 'gpt-5.4', prices: { inputMiss: 1, inputHit: 0.1, output: 4 } });
  const relay = await store.resolve('relay-x', 'gpt-5.4', publicPricing);
  assert.equal(relay.source, 'custom');
  assert.equal(relay.prices.inputMiss, 1);

  const official = await store.resolve('openai', 'gpt-5.4', publicPricing);
  assert.equal(official.source, 'public');
  assert.equal(official.prices.inputMiss, 17);
});

test('没有裸模型名兜底：未收录就是未收录', async () => {
  const store = await tmpStore();
  await store.upsert({ ...base, providerId: 'relay-x', modelId: 'gpt-5.4' });
  const other = await store.resolve('relay-y', 'gpt-5.4', publicPricing);
  assert.equal(other.source, 'unrecorded');
  assert.equal(other.prices, null);
});

test('停用的覆盖回退到公共价，删除后恢复公共来源', async () => {
  const store = await tmpStore();
  await store.upsert({ ...base, prices: { inputMiss: 1, inputHit: 0.1, output: 4 } });
  await store.upsert({ ...base, enabled: false, prices: { inputMiss: 1, inputHit: 0.1, output: 4 } });
  assert.equal((await store.resolve('openai', 'gpt-5.4', publicPricing)).source, 'public');

  await store.remove('openai', 'gpt-5.4');
  assert.equal(await store.get('openai', 'gpt-5.4'), null);
  assert.equal((await store.resolve('openai', 'gpt-5.4', publicPricing)).source, 'public');
});

test('公共库刷新后重组合：本地覆盖不被覆盖掉', async () => {
  const store = await tmpStore();
  await store.upsert({ ...base, prices: { inputMiss: 2, inputHit: 0.2, output: 12 } });
  const refreshed = { ...publicPricing, models: { ...publicPricing.models, 'openai::gpt-5.4': { flat: { inputMiss: 99, inputHit: 9, output: 999 } } } };
  const merged = await composeAfterRefresh(store, refreshed);
  assert.equal(merged.get('openai::gpt-5.4').source, 'custom');
  assert.equal(merged.get('openai::gpt-5.4').entry.prices.inputMiss, 2);
  assert.equal(merged.get('openai::gpt-5.4-mini').source, 'public');
});

test('损坏文件拒绝静默重置', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-corrupt-'));
  const filePath = path.join(dir, 'custom-pricing.json');
  await fsp.writeFile(filePath, '{ 这不是 json', 'utf8');
  const store = createCustomPricingStore({ filePath });
  await assert.rejects(() => store.list(), StoreCorruptError);
  const still = await fsp.readFile(filePath, 'utf8');
  assert.equal(still, '{ 这不是 json');
});

test('带 BOM 的文件能读', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-bom-'));
  const filePath = path.join(dir, 'custom-pricing.json');
  await fsp.writeFile(filePath, '\uFEFF{"schemaVersion":1,"entries":{}}', 'utf8');
  const store = createCustomPricingStore({ filePath });
  assert.deepEqual(await store.list(), []);
});

test('校验失败抛 StoreValidationError 且不落盘', async () => {
  const store = await tmpStore();
  await assert.rejects(() => store.upsert({ ...base, providerName: '' }), StoreValidationError);
  assert.deepEqual(await store.list(), []);
});

test('resolveAll 报告覆盖重合数', async () => {
  const store = await tmpStore();
  await store.upsert({ ...base, prices: { inputMiss: 2, inputHit: 0.2, output: 12 } });
  const r = await store.resolveAll(publicPricing, [
    { providerId: 'openai', modelId: 'gpt-5.4' },
    { providerId: 'openai', modelId: 'gpt-5.4-mini' },
    { providerId: 'relay-y', modelId: 'gpt-5.4' },
  ]);
  assert.equal(r.overlap, 1);
  assert.deepEqual(r.items.map((i) => i.source), ['custom', 'public', 'unrecorded']);
});

test('保存后修订号递增，删除也递增，重启后从磁盘读回', async () => {
  const store = await tmpStore();
  assert.equal(await store.revision(), 0);
  await store.upsert(base);
  assert.equal(await store.revision(), 1);
  await store.upsert({ ...base, modelId: 'gpt-5.4-mini' });
  assert.equal(await store.revision(), 2);
  await store.remove('openai', 'gpt-5.4');
  assert.equal(await store.revision(), 3);
  const reopened = createCustomPricingStore({ filePath: store.filePath });
  assert.equal(await reopened.revision(), 3);
});

test('写入失败时修订号不变', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-rev-'));
  const filePath = path.join(dir, 'custom-pricing.json');
  const store = createCustomPricingStore({ filePath });
  await store.upsert(base);
  const before = await store.revision();
  const broken = createCustomPricingStore({
    filePath,
    fs: {
      ...fsp,
      writeFile: async () => { throw new Error('disk full'); },
    },
  });
  await assert.rejects(() => broken.upsert({ ...base, modelId: 'x-1' }));
  assert.equal(await store.revision(), before);
});
