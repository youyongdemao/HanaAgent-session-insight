import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import registerPluginApiRoutes from './legacy-api.js';
import { setLocalPricing } from './usage-parser.js';

// Exercise the real HTTP handler, not a hand-written response fixture.
test('ledger-stats returns all four cost bucket ranges globally and per provider', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'si-ledger-buckets-'));
  const dataDir = path.join(root, 'app-data', 'session-insight');
  await fs.mkdir(dataDir, { recursive: true });
  const now = Date.now();
  const entry = (id, provider, age, tokens) => ({
    id, startedAt: new Date(now - age).toISOString(), status: 'ok',
    model: { provider, modelId: 'probe-cost' }, attribution: { kind: 'session', agentId: 'probe' }, source: { subsystem: 'session' },
    usage: { input: { totalTokens: tokens, uncachedTokens: tokens }, output: { totalTokens: 0 }, cache: { readTokens: 0 }, totalTokens: tokens },
  });
  const entries = [entry('a', 'probe-a', 3600000, 1e6), entry('b', 'probe-b', 7200000, 2e6), entry('c', 'probe-a', 3 * 86400000, 3e6), entry('d', 'probe-a', 20 * 86400000, 4e6)];
  const local = providerId => ({ providerId, modelId: 'probe-cost', enabled: true, billingType: 'payg', currency: 'CNY', prices: { inputMiss: 2, inputHit: 0, output: 0 } });
  setLocalPricing({ 'probe-a::probe-cost': local('probe-a'), 'probe-b::probe-cost': local('probe-b') }, 77);
  const sdk = { usage: { list: async () => ({ entries }) } };
  const routes = new Map();
  const app = { use() {}, get(p, fn) { routes.set(p, fn); }, post() {} };
  registerPluginApiRoutes(app, { dataDir, pluginDir: path.join(root, 'apps', 'session-insight'), config: { get: key => key === 'dataDir' ? root : undefined }, sdk }, sdk);
  const handler = routes.get('/api/ledger-stats');
  const call = provider => handler({ req: { query: key => key === 'force' ? '1' : key === 'provider' ? provider : undefined }, json: body => JSON.parse(JSON.stringify(body)) });
  try {
    const global = await call(null), filtered = await call('probe-a');
    for (const [name, result] of [['global', global], ['provider', filtered]]) {
      assert.equal(result.error, undefined, JSON.stringify(result));
      for (const unit of ['hour', 'd7', 'd30', 'day']) {
        assert.equal(result.timeBuckets?.[unit]?.length, 256, `${name} ${unit} cost buckets missing`);
        assert.ok(result.timeBuckets[unit].every(v => Number.isFinite(v) && v >= 0));
        assert.ok(result.timeBuckets[unit].some(v => v > 0), `${name} ${unit} must carry positive fixture costs`);
      }
      assert.equal(result.tokenBuckets.hour.length, 256);
      assert.equal(result.cacheRateBuckets.hour.length, 256);
    }
    const sum = a => a.reduce((n, v) => n + v, 0);
    assert.equal(sum(global.timeBuckets.hour), 6);
    assert.equal(sum(filtered.timeBuckets.hour), 2);
    assert.equal(sum(filtered.timeBuckets.d7), 8);
    assert.equal(sum(filtered.timeBuckets.d30), 16);
  } finally {
    setLocalPricing({}, 0);
    await fs.rm(root, { recursive: true, force: true });
  }
});
