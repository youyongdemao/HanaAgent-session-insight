// lib/host-data.test.js — 会话统计的费用完整性
//
// 重点：价格未知的轮次不能被静默当成 0 混进总额。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionStats } from './host-data.js';
import { setLocalPricing } from './usage-parser.js';

function usageEntry({ model, provider, input = 1000, cacheRead = 0, output = 100, cacheWrite = 0 }) {
  return {
    startedAt: '2026-10-21T04:00:00Z',
    attribution: { kind: 'session' },
    model: { modelId: model, provider },
    usage: {
      input: { totalTokens: input, uncachedTokens: input },
      cache: { readTokens: cacheRead, writeTokens: cacheWrite },
      output: { totalTokens: output },
      totalTokens: input + cacheRead + output,
    },
  };
}

function reset() {
  setLocalPricing({}, 0);
}

test('全部轮次价格未知：会话费用为 null，并报出未知轮数', () => {
  reset();
  const entries = [
    usageEntry({ model: 'no-such-model-xyz', provider: 'nobody' }),
    usageEntry({ model: 'no-such-model-xyz', provider: 'nobody' }),
  ];
  const stats = buildSessionStats(entries, null);
  assert.equal(stats.sessionCostCny, null, '不知道多少钱就不能报 0');
  assert.equal(stats.costComplete, false);
  assert.equal(stats.unknownPricedTurns, 2);
  assert.equal(stats.turns, 2);
});

test('部分轮次有价：只累计已知部分，并标记不完整', () => {
  reset();
  const entries = [
    usageEntry({ model: 'deepseek-v4-flash', provider: 'deepseek' }),
    usageEntry({ model: 'no-such-model-xyz', provider: 'nobody' }),
  ];
  const stats = buildSessionStats(entries, null);
  assert.equal(typeof stats.sessionCostCny, 'number');
  assert.ok(stats.sessionCostCny > 0);
  assert.equal(stats.costComplete, false);
  assert.equal(stats.unknownPricedTurns, 1);
});

test('全部轮次都有价：complete 为 true，未知轮数为 0', () => {
  reset();
  const entries = [
    usageEntry({ model: 'deepseek-v4-flash', provider: 'deepseek' }),
    usageEntry({ model: 'deepseek-v4-flash', provider: 'deepseek' }),
  ];
  const stats = buildSessionStats(entries, null);
  assert.equal(typeof stats.sessionCostCny, 'number');
  assert.equal(stats.costComplete, true);
  assert.equal(stats.unknownPricedTurns, 0);
});

test('本地自定义价参与会话计费', () => {
  reset();
  setLocalPricing({
    'relay::m1': {
      providerId: 'relay',
      modelId: 'm1',
      enabled: true,
      billingType: 'payg',
      currency: 'CNY',
      prices: { inputMiss: 10, inputHit: 1, output: 20 },
    },
  }, 1);
  const stats = buildSessionStats([usageEntry({ model: 'm1', provider: 'relay' })], null);
  assert.equal(stats.costComplete, true);
  assert.ok(stats.sessionCostCny > 0);
  reset();
});
