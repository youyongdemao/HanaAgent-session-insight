// lib/pricing-db-integration.test.js —— 启动恢复真实接入（离线，不联网）
//
// 验证 index.js 启动时调的 initializePricingDb 能把 App 私有目录里的
// 最后成功快照送进查价链，而不是停在 state 字段上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { initializePricingDb } from './legacy-api.js';
import { priceFor, PRICING, getFxUsd, PRICING_SNAPSHOT_AT } from './usage-parser.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDb(snapshotAt = '2026-12-01') {
  return {
    schemaVersion: 2,
    snapshotAt,
    currency: 'CNY',
    unit: 'per_million_tokens',
    fx: { USD: 7.25 },
    models: {
      'offline-only::offline-probe': {
        provider: 'offline-only',
        sourceUrl: 'https://example.com/pricing',
        flat: { inputMiss: 3, inputHit: 0.3, output: 6 },
        contextWindow: 128000,
      },
    },
  };
}

function envelope(db) {
  return {
    cacheVersion: 1,
    savedAt: new Date().toISOString(),
    sourceUrl: 'https://raw.githubusercontent.com/youyongdemao/HanaAgent-session-insight/main/pricing.json',
    hash: createHash('sha256').update(JSON.stringify(db), 'utf8').digest('hex'),
    database: db,
  };
}

/** fetch 一律失败：证明恢复过程不依赖网络。 */
function offlineCtx(dataDir) {
  return {
    dataDir,
    network: { fetch: async () => { throw new Error('network must not be used during restore'); } },
    sdk: {},
    config: { get: () => undefined },
  };
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'si-pricing-integration-'));
  return (async () => {
    try { await fn(dir); } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  })();
}

test('启动恢复把私有目录快照真正装进查价链，且不联网', async () => {
  await withTempDir(async (dir) => {
    const db = makeDb();
    await fsp.writeFile(join(dir, 'pricing-cache.json'), JSON.stringify(envelope(db)), 'utf8');

    const state = await initializePricingDb(offlineCtx(dir));

    assert.equal(state.ok, true);
    assert.equal(state.source, 'local-cache');
    assert.equal(state.snapshotAt, db.snapshotAt);
    assert.equal(state.remoteOk, false, '恢复本身不算联网成功');

    // 关键：不是只有 state 变了，超级查价链也必须能看到这条价格
    const p = priceFor('offline-probe', Date.now(), 'offline-only');
    assert.ok(p, '离线快照里的模型必须能查到价格');
    assert.equal(p.inputMiss, 3);
    assert.equal(p.output, 6);
    assert.equal(PRICING_SNAPSHOT_AT, db.snapshotAt);
    assert.equal(PRICING['offline-only::offline-probe'].inputHit, 0.3);
    assert.equal(getFxUsd(), 7.25);
  });
});

test('缓存损坏时不崩溃、不静默重置，保持包内数据可用', async () => {
  await withTempDir(async (dir) => {
    await fsp.writeFile(join(dir, 'pricing-cache.json'), '{"cacheVersion":1,"hash":"deadbeef","database":{}}', 'utf8');
    const state = await initializePricingDb(offlineCtx(dir));

    assert.equal(state.ok, false, '坏缓存不能冒充可用数据');
    assert.match(String(state.error), /校验|不匹配|失败/);
    // 包内兜底仍在，查价链不能因为坏缓存变成空表
    assert.ok(Object.keys(PRICING).length > 0, '包内价格表必须保留');
  });
});

test('没有缓存文件时安静回到包内兜底，不抛错', async () => {
  await withTempDir(async (dir) => {
    const state = await initializePricingDb(offlineCtx(dir));
    assert.equal(state.source, 'builtin');
    assert.equal(state.ok, false);
    assert.equal(state.error, null);
    assert.ok(Object.keys(PRICING).length > 0);
  });
});
