// lib/billing-precedence.test.js —— 计费优先级与末轮未知
//
// 规则：本地自定义价最高优先；宿主自带金额只在「没有本地覆盖」时兜底。
import test from 'node:test';
import assert from 'node:assert/strict';

import { calcEntryCost } from './legacy-api.js';
import { buildSessionStats } from './host-data.js';
import { setLocalPricing } from './usage-parser.js';

function usageEntry({ provider = 'relay', model = 'm1', baseUrl = null, costTotal, tokens = 1_000_000 }) {
  return {
    startedAt: '2026-10-21T04:00:00Z',
    attribution: { kind: 'session' },
    model: { modelId: model, provider, baseUrl },
    usage: {
      input: { totalTokens: tokens, uncachedTokens: tokens },
      cache: { readTokens: 0, writeTokens: 0 },
      output: { totalTokens: 0 },
      totalTokens: tokens,
      ...(costTotal === undefined ? {} : { costTotal }),
    },
  };
}

function localEntry(providerId, modelId, prices, billingType = 'payg') {
  return {
    providerId,
    modelId,
    enabled: true,
    billingType,
    currency: 'CNY',
    prices,
  };
}

function reset() {
  setLocalPricing({}, 0);
}

test('订阅通道上的本地 payg 覆盖优先，宿主金额不吞它', () => {
  reset();
  // zhipu-coding 在目录里是 subscription
  setLocalPricing({ 'zhipu-coding::glm-x': localEntry('zhipu-coding', 'glm-x', { inputMiss: 5, inputHit: 1, output: 10 }) }, 1);
  const cost = calcEntryCost(usageEntry({
    provider: 'zhipu-coding',
    model: 'glm-x',
    costTotal: 3.5,
  }));
  assert.equal(cost, 5, '应按自定义单价算 5 元，而不是 0，也不是宿主那 3.5');
  reset();
});

test('没有本地覆盖时，订阅通道仍归零', () => {
  reset();
  assert.equal(calcEntryCost(usageEntry({ provider: 'zhipu-coding', model: 'glm-x' })), 0);
});

test('没有本地覆盖时，宿主自带非 0 金额可兜底', () => {
  reset();
  assert.equal(calcEntryCost(usageEntry({ provider: 'relay', model: 'm1', costTotal: 3.5 })), 3.5);
});

test('本地覆盖缺价时是未知，不是 0，也不回落到宿主金额', () => {
  reset();
  setLocalPricing({ 'relay::m1': localEntry('relay', 'm1', { inputMiss: null, inputHit: null, output: 5 }) }, 1);
  assert.equal(calcEntryCost(usageEntry({ provider: 'relay', model: 'm1', costTotal: 3.5 })), null);
  reset();
});

test('本地订阅形态归零，即使宿主报了金额', () => {
  reset();
  setLocalPricing({ 'relay::m1': localEntry('relay', 'm1', { inputMiss: null, inputHit: null, output: null }, 'subscription') }, 1);
  assert.equal(calcEntryCost(usageEntry({ provider: 'relay', model: 'm1', costTotal: 3.5 })), 0);
  reset();
});

test('末轮未知时 lastCostCny 是 null，不是 ¥0', () => {
  reset();
  const stats = buildSessionStats([
    usageEntry({ provider: 'deepseek', model: 'deepseek-v4-flash' }),
    usageEntry({ provider: 'nobody', model: 'no-such-model-xyz' }),
  ], null);
  assert.equal(stats.lastCostCny, null, '不知道就是 null');
  assert.equal(stats.costComplete, false);
  assert.equal(stats.unknownPricedTurns, 1);
  assert.equal(stats.sessionCostCny !== null, true, '前面的已知部分仍要累计');
});

test('series 每轮都带 costKnown，与是否未知一致', () => {
  reset();
  const stats = buildSessionStats([
    usageEntry({ provider: 'deepseek', model: 'deepseek-v4-flash' }),
    usageEntry({ provider: 'nobody', model: 'no-such-model-xyz' }),
  ], null);
  assert.equal(stats.series.length, 2);
  assert.equal(stats.series[0].costKnown, true);
  assert.equal(stats.series[1].costKnown, false);
});

test('末轮有价时 lastCostCny 正常给数', () => {
  reset();
  const stats = buildSessionStats([
    usageEntry({ provider: 'deepseek', model: 'deepseek-v4-flash' }),
  ], null);
  assert.equal(typeof stats.lastCostCny, 'number');
  assert.equal(stats.series[0].costKnown, true);
});
