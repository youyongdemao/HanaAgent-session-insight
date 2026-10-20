// lib/local-pricing-mirror.test.js — 本地自定义价覆盖层（同步镜像）行为测试
// 只测查价入口 lookupPriceEntry 暴露出来的行为：命中顺序、键规则、零价语义。
import test from 'node:test';
import assert from 'node:assert/strict';

import { priceFor, calcCost, setLocalPricing, PRICING } from './usage-parser.js';

function entry(prices, extra = {}) {
  return {
    providerId: 'deepseek',
    modelId: 'x',
    enabled: true,
    billingType: 'payg',
    currency: 'CNY',
    unit: 'per_mtok',
    prices,
    ...extra,
  };
}

const TS = Date.parse('2026-10-21T12:00:00+08:00');

test('本地覆盖优先于公共表', () => {
  const pub = PRICING['deepseek::deepseek-v4-flash'];
  assert.ok(pub, '前提：公共表里有这条');
  setLocalPricing({ 'deepseek::deepseek-v4-flash': entry({ inputMiss: 99, inputHit: 9, output: 999 }) });
  const p = priceFor('deepseek-v4-flash', TS, 'deepseek');
  assert.equal(p.inputMiss, 99);
  assert.equal(p.source, 'custom');

  setLocalPricing({});
  const back = priceFor('deepseek-v4-flash', TS, 'deepseek');
  assert.notEqual(back.inputMiss, 99);
});

test('零价是免费，不是缺失', () => {
  setLocalPricing({ 'local::qwen3:8b': entry({ inputMiss: 0, inputHit: 0, output: 0 }, { providerId: 'local' }) });
  const cost = calcCost(1_000_000, 1_000_000, 1_000_000, 0, 'qwen3:8b', TS, 'local');
  assert.equal(cost, 0, '一百万 token 全零价应算 0，不能因为 0 被判缺失');
});

test('cacheWrite 缺省时按未命中价计', () => {
  setLocalPricing({ 'local::m-w': entry({ inputMiss: 10, inputHit: 1, output: 20 }, { providerId: 'local' }) });
  const cost = calcCost(0, 0, 0, 0, 'm-w', TS, 'local', 1_000_000);
  assert.equal(cost, 10, '未填 cacheWrite 应按 inputMiss=10 计');
});

test('enabled=false 的条目不生效', () => {
  setLocalPricing({ 'local::off-model': entry({ inputMiss: 5, inputHit: 5, output: 5 }, { providerId: 'local', enabled: false }) });
  assert.equal(priceFor('off-model', TS, 'local'), null);
});

test('只认 providerId::modelId，裸模型名不垫底', () => {
  setLocalPricing({ 'deepseek::same-name': entry({ inputMiss: 7, inputHit: 7, output: 7 }) });
  assert.notEqual(priceFor('same-name', TS, 'deepseek'), null, '同供应商应命中');
  assert.equal(priceFor('same-name', TS, 'siliconflow'), null, '别家供应商不得借用这条价');
  assert.equal(priceFor('same-name', TS, ''), null, '没有供应商时不得用本地价兜底');
});

test('本地命中不走过期尾缀与别名回退', () => {
  // 用户给带过期尾缀的原始名字单独填了价
  setLocalPricing({ 'deepseek::foo-expires-on-0910': entry({ inputMiss: 3, inputHit: 3, output: 3 }) });
  const p = priceFor('foo-expires-on-0910', TS, 'deepseek');
  assert.equal(p.inputMiss, 3);
  // 别名目标不应因此被改成自定义价
  setLocalPricing({ 'deepseek::deepseek-v4.1-flash': entry({ inputMiss: 42, inputHit: 42, output: 42 }) });
  const aliasTarget = priceFor('deepseek-v4-flash', TS, 'deepseek');
  assert.notEqual(aliasTarget.inputMiss, 42, '别名指向的公共条目不能被别的模型名的自定义价污染');
});

test('供应商大小写归一', () => {
  setLocalPricing({ 'deepseek::CaseModel': entry({ inputMiss: 8, inputHit: 8, output: 8 }) });
  assert.equal(priceFor('CaseModel', TS, 'DeepSeek')?.inputMiss, 8);
});
