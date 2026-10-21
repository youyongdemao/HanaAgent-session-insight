// lib/pricing-db-cache.test.js —— 公共计费库缓存的契约测试
//
// 全部离线：fetchFn 是注入的假传输层，文件系统用真实临时目录（写故障另用 fs 替身）。
// 不读生产凭据、不碰真实数据、不发任何网络请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as nodeFs, readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPricingDatabaseCache,
  validatePricingDatabase,
  DEFAULT_PRICING_DB_URLS,
  MAX_DOCUMENT_BYTES,
  MAX_MODELS,
} from './pricing-db-cache.js';
import { setPricingConfig, getFxUsd } from './usage-parser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = DEFAULT_PRICING_DB_URLS[0];
const CDN = DEFAULT_PRICING_DB_URLS[1];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一份最小但完整的合法库 */
function makeDb(snapshotAt = '2026-10-21', models) {
  return {
    schemaVersion: 2,
    snapshotAt,
    currency: 'CNY',
    unit: 'per_million_tokens',
    fx: { USD: 6.8 },
    peakHours: { offsetMinutes: 480, weekdays: [1, 2, 3, 4, 5], ranges: [[9, 12]] },
    models: models || {
      'alpha::alpha-1': {
        provider: 'alpha',
        sourceUrl: 'https://example.com/pricing',
        flat: { inputMiss: 1, inputHit: 0.1, output: 2 },
        contextWindow: 128000,
      },
    },
  };
}

function clone(db) {
  return JSON.parse(JSON.stringify(db));
}

function okResponse(db) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(db),
  };
}

/** 假传输层：按 URL 路由，可延迟、可报错，并记录所有请求过的 URL */
function makeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const spec = routes[url];
    if (!spec) throw new Error(`unexpected url ${url}`);
    if (spec.delayMs) await delay(spec.delayMs);
    if (spec.error) throw new Error(spec.error);
    if (spec.status) return { ok: false, status: spec.status, headers: { get: () => null } };
    return okResponse(typeof spec.json === "string" ? JSON.parse(spec.json) : spec.db);
  };
  fn.calls = calls;
  return fn;
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'si-pricing-cache-'));
  test.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

/** 记录 apply 调用；模拟真实 setPricingConfig 的返回值语义 */
function makeApply(result = true) {
  const seen = [];
  const fn = async (db) => {
    seen.push(clone(db));
    return result;
  };
  fn.seen = seen;
  return fn;
}

// ───────────────────────── 校验器 ─────────────────────────

test('包内真实 pricing.json 全量通过校验，条目数不硬编码', () => {
  const db = JSON.parse(readFileSync(join(HERE, '..', 'pricing.json'), 'utf8'));
  assert.equal(validatePricingDatabase(db), true);
  assert.ok(Object.keys(db.models).length > 100);
});

test('全坏库与部分坏库都整份拒收，apply 零次', async () => {
  const dir = tempDir();
  const filePath = join(dir, 'cache.json');

  const fullyBroken = [
    null,
    {},
    { schemaVersion: 1 },
    { ...makeDb(), schemaVersion: 3 },
    { ...makeDb(), currency: 'USD' },
    { ...makeDb(), unit: 'per_1k_tokens' },
    { ...makeDb(), models: {} },
  ];
  for (const bad of fullyBroken) {
    assert.throws(() => validatePricingDatabase(bad), /pricing\.json 校验失败/);
  }

  const partiallyBroken = makeDb();
  partiallyBroken.models['alpha::alpha-2'] = {
    provider: 'alpha',
    flat: { inputMiss: -1, inputHit: 0.1, output: 2 },
  };
  assert.throws(() => validatePricingDatabase(partiallyBroken), /inputMiss/);

  const apply = makeApply();
  const cache = createPricingDatabaseCache({
    filePath,
    fetchFn: makeFetch({ [RAW]: { db: partiallyBroken }, [CDN]: { error: 'boom' } }),
    apply,
    builtinSnapshotAt: '2026-10-20',
  });
  const state = await cache.refresh(true);
  assert.equal(apply.seen.length, 0, '坏数据绝不能进 apply');
  assert.equal(state.ok, false);
  assert.equal(state.source, 'builtin');
  assert.equal(existsSync(filePath), false, '坏数据不能落盘');
});

test('拒绝伪造日期、缺计价、坏 cacheWrite、坏 provider 冲突', () => {
  const cases = [];

  const forged = makeDb('2026-02-30');
  cases.push([forged, /snapshotAt/]);

  const badFormat = makeDb('2026/10/21');
  cases.push([badFormat, /snapshotAt/]);

  const noPrice = makeDb();
  noPrice.models['alpha::alpha-1'] = { provider: 'alpha' };
  cases.push([noPrice, /没有任何可用计价/]);

  const halfPeak = makeDb();
  halfPeak.models['alpha::alpha-1'] = { provider: 'alpha', peak: { inputMiss: 1, inputHit: 0, output: 2 } };
  cases.push([halfPeak, /没有任何可用计价/]);

  const badCw = makeDb();
  badCw.models['alpha::alpha-1'] = {
    provider: 'alpha',
    flat: { inputMiss: 1, inputHit: 0.1, output: 2, cacheWrite: -5 },
  };
  cases.push([badCw, /cacheWrite/]);

  const nullCw = makeDb();
  nullCw.models['alpha::alpha-1'] = {
    provider: 'alpha',
    flat: { inputMiss: 1, inputHit: 0.1, output: 2, cacheWrite: null },
  };
  assert.equal(validatePricingDatabase(nullCw), true, 'cacheWrite:null 合法');

  const conflict = makeDb();
  conflict.models['alpha::alpha-1'].provider = 'beta';
  cases.push([conflict, /冲突/]);

  const badFx = makeDb();
  badFx.fx = { USD: -1 };
  cases.push([badFx, /fx\.USD/]);

  const noFx = makeDb();
  noFx.models['alpha::alpha-1'] = { provider: 'alpha', currency: 'USD', usd: { inputMiss: 1, inputHit: 0.1, output: 2 } };
  delete noFx.fx;
  cases.push([noFx, /缺少 fx\.USD/]);

  for (const [db, re] of cases) {
    assert.throws(() => validatePricingDatabase(db), re);
  }
});

test('裸键兼容，USD 条目可用 usd / usdPeak+usdOffPeak', () => {
  const db = makeDb();
  db.models['bare-model'] = { flat: { inputMiss: 0.5, inputHit: 0.05, output: 1 } };
  db.models['gamma::g-usd'] = {
    provider: 'gamma',
    currency: 'USD',
    usd: { inputMiss: 0.3, inputHit: 0.02, output: 1.2 },
    usdPeak: { inputMiss: 0.3, inputHit: 0.02, output: 1.2, cacheWrite: 0.1 },
    usdOffPeak: { inputMiss: 0.15, inputHit: 0.01, output: 0.6 },
  };
  assert.equal(validatePricingDatabase(db), true);
});

// ─────────────────────── 投毒与资源耗尽 ───────────────────────

test('递归拒绝 __proto__ / constructor / prototype（含 :: 后部与深层嵌套）', () => {
  const protoPayload = JSON.parse(
    '{"schemaVersion":2,"snapshotAt":"2026-10-21","currency":"CNY","unit":"per_million_tokens",' +
      '"models":{"__proto__":{"provider":"x","flat":{"inputMiss":0,"inputHit":0,"output":0}}}}',
  );
  assert.throws(() => validatePricingDatabase(protoPayload), /危险键名/);

  const scoped = JSON.parse(
    '{"schemaVersion":2,"snapshotAt":"2026-10-21","currency":"CNY","unit":"per_million_tokens",' +
      '"models":{"alpha::constructor":{"provider":"alpha","flat":{"inputMiss":1,"inputHit":0,"output":1}}}}',
  );
  assert.throws(() => validatePricingDatabase(scoped), /危险键名/);

  const deep = makeDb();
  deep.note = { a: { b: { prototype: { evil: true } } } };
  assert.throws(() => validatePricingDatabase(deep), /危险键名/);

  const inTiers = makeDb();
  inTiers.models['alpha::alpha-1'].tiers = [{ label: 'x', constructor: 'y' }];
  assert.throws(() => validatePricingDatabase(inTiers), /危险键名/);
});

test('sourceUrl 只接受 http/https 且不得带凭据', () => {
  const bad = [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>x</script>',
    'https://user:pass@example.com/pricing',
    'https://user@example.com/pricing',
    'not a url',
    'https://example.com/' + 'a'.repeat(2100),
    '',
  ];
  for (const url of bad) {
    const db = makeDb();
    db.models['alpha::alpha-1'].sourceUrl = url;
    assert.throws(() => validatePricingDatabase(db), /sourceUrl/);
  }
  const ok = makeDb();
  ok.models['alpha::alpha-1'].sourceUrl = 'http://example.com/pricing';
  assert.equal(validatePricingDatabase(ok), true);
});

test('超大数据防资源耗尽：条目数、文档体积、嵌套深度、节点数', async () => {
  const many = makeDb();
  many.models = {};
  for (let i = 0; i < MAX_MODELS + 1; i += 1) {
    many.models[`alpha::m${i}`] = { provider: 'alpha', flat: { inputMiss: 1, inputHit: 0, output: 1 } };
  }
  assert.throws(() => validatePricingDatabase(many), /条目数/);

  let deepObj = { leaf: 1 };
  for (let i = 0; i < 40; i += 1) deepObj = { n: deepObj };
  const deep = makeDb();
  deep.extra = deepObj;
  assert.throws(() => validatePricingDatabase(deep), /嵌套/);

  const wide = makeDb();
  wide.models['alpha::alpha-1'].tiers = new Array(200001).fill(1);
  assert.throws(() => validatePricingDatabase(wide), /节点数/);

  // 文档体积：传输层直接拦掉，不进 JSON.parse，更不进 apply
  const dir = tempDir();
  const apply = makeApply();
  const huge = 'x'.repeat(MAX_DOCUMENT_BYTES + 1024);
  const cache = createPricingDatabaseCache({
    filePath: join(dir, 'cache.json'),
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => huge,
    }),
    apply,
    builtinSnapshotAt: '2026-10-20',
  });
  const state = await cache.refresh(true);
  assert.equal(apply.seen.length, 0);
  assert.equal(state.ok, false);
  assert.match(state.error, /体积/);
});

test('校验只做静态检查，不会去请求条目里的 sourceUrl', async () => {
  const db = makeDb();
  db.models['alpha::alpha-1'].sourceUrl = 'https://evil.example.com/pricing.json';
  const fetchFn = makeFetch({ [RAW]: { db }, [CDN]: { db: clone(db) } });
  const cache = createPricingDatabaseCache({
    filePath: join(tempDir(), 'cache.json'),
    fetchFn,
    apply: makeApply(),
    builtinSnapshotAt: '2026-10-20',
  });
  await cache.refresh(true);
  for (const url of fetchFn.calls) assert.ok(url === RAW || url === CDN, `只应请求配置源，实际请求了 ${url}`);
});

// ─────────────────────── 落盘 / 回读 ───────────────────────

test('原子写入后重启可离线恢复，且 restore 不联网', async () => {
  const dir = tempDir();
  const filePath = join(dir, 'cache.json');
  const db = makeDb('2026-10-21');
  const fetchFn = makeFetch({ [RAW]: { db }, [CDN]: { db } });
  const apply1 = makeApply();
  const first = createPricingDatabaseCache({
    filePath,
    fetchFn,
    apply: apply1,
    builtinSnapshotAt: '2026-10-01',
    now: () => Date.UTC(2026, 9, 21, 4),
  });
  const s1 = await first.refresh();
  assert.equal(s1.ok, true);
  assert.equal(s1.persisted, true);
  assert.equal(s1.source, RAW);
  assert.ok(s1.savedAt);
  assert.equal(apply1.seen.length, 1);

  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], '不应残留临时文件');

  const payload = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(payload.cacheVersion, 1);
  assert.equal(payload.sourceUrl, RAW);
  assert.equal(typeof payload.hash, 'string');
  assert.equal(payload.database.snapshotAt, '2026-10-21');

  // 新实例：断网也必须能起来
  const offlineFetch = async () => {
    throw new Error('offline');
  };
  const apply2 = makeApply();
  const second = createPricingDatabaseCache({
    filePath,
    fetchFn: offlineFetch,
    apply: apply2,
    builtinSnapshotAt: '2026-10-01',
  });
  const s2 = await second.restore();
  assert.equal(s2.ok, true);
  assert.equal(s2.source, 'local-cache', '来源必须标 local-cache，不能误标 builtin');
  assert.equal(s2.snapshotAt, '2026-10-21');
  assert.equal(s2.persisted, true);
  assert.equal(s2.remoteOk, false);
  assert.equal(apply2.seen.length, 1, '恢复时必须把数据交给 apply');
});

test('写盘失败：运行可用但 persisted=false 且明确报错，旧文件保留', async () => {
  const dir = tempDir();
  const filePath = join(dir, 'cache.json');
  const oldDb = makeDb('2026-10-20');

  const good = createPricingDatabaseCache({
    filePath,
    fetchFn: makeFetch({ [RAW]: { db: oldDb }, [CDN]: { db: oldDb } }),
    apply: makeApply(),
    builtinSnapshotAt: '2026-10-01',
  });
  await good.refresh(true);
  const oldText = readFileSync(filePath, 'utf8');

  const failingFs = {
    ...nodeFs,
    rename: async () => {
      const err = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    },
  };
  const newDb = makeDb('2026-10-21', {
    'alpha::alpha-1': { provider: 'alpha', flat: { inputMiss: 9, inputHit: 1, output: 9 } },
  });
  const apply = makeApply();
  const cache = createPricingDatabaseCache({
    filePath,
    // 换个传输层：模拟「本地已有旧缓存，远端来了新数据」
    fetchFn: makeFetch({ [RAW]: { db: newDb }, [CDN]: { db: newDb } }),
    apply,
    builtinSnapshotAt: '2026-10-01',
    fs: failingFs,
  });
  const state = await cache.refresh(true);
  assert.equal(state.ok, true, '数据可用');
  assert.equal(state.persisted, false, '不能假报保存成功');
  assert.match(state.error, /写入缓存失败/);
  // restore 先跑（旧缓存进 apply 一次），远端选定后再 apply 一次；关键是不能多 apply
  assert.equal(apply.seen.length, 2, '一次来自本地缓存 restore，一次来自远端选定结果');
  assert.equal(apply.seen[0].snapshotAt, '2026-10-20', '第一次是旧缓存');
  assert.equal(apply.seen[1].snapshotAt, '2026-10-21', '第二次是远端新数据');
  assert.equal(apply.seen[1].models['alpha::alpha-1'].flat.inputMiss, 9);
  assert.equal(readFileSync(filePath, 'utf8'), oldText, '旧文件必须原样保留');
});

test('损坏缓存与哈希错缓存都不执行、不回退成 builtin', async () => {
  const dir = tempDir();
  const filePath = join(dir, 'cache.json');
  const db = makeDb('2026-10-21');

  // 哈希错：改 database 但不改 hash
  const payload = {
    cacheVersion: 1,
    savedAt: new Date(Date.UTC(2026, 9, 21)).toISOString(),
    sourceUrl: RAW,
    hash: 'deadbeef',
    database: db,
  };
  await nodeFs.writeFile(filePath, JSON.stringify(payload), 'utf8');
  const applyA = makeApply();
  const a = createPricingDatabaseCache({ filePath, fetchFn: async () => {}, apply: applyA, builtinSnapshotAt: '2026-10-01' });
  const sa = await a.restore();
  assert.equal(applyA.seen.length, 0);
  assert.equal(sa.ok, false, '内置数据初始 ok=false');
  assert.equal(sa.source, 'builtin');
  assert.match(sa.error, /SHA256/);

  // 结构损坏
  await nodeFs.writeFile(filePath, '{not json', 'utf8');
  const applyB = makeApply();
  const b = createPricingDatabaseCache({ filePath, fetchFn: async () => {}, apply: applyB, builtinSnapshotAt: '2026-10-01' });
  const sb = await b.restore();
  assert.equal(applyB.seen.length, 0);
  assert.equal(sb.ok, false);
  assert.match(sb.error, /JSON/);

  // 缓存里是坏数据但 hash 自洽（用一个能让 apply 拒绝的情形验证）
  const cacheWithBadDb = createPricingDatabaseCache({
    filePath,
    fetchFn: makeFetch({ [RAW]: { db }, [CDN]: { db } }),
    apply: makeApply(),
    builtinSnapshotAt: '2026-10-01',
  });
  await cacheWithBadDb.refresh(true);
  const goodPayload = JSON.parse(readFileSync(filePath, 'utf8'));
  goodPayload.database.models['alpha::alpha-1'].flat.inputMiss = 'oops';
  const { createHash } = await import('node:crypto');
  goodPayload.hash = createHash('sha256').update(JSON.stringify(goodPayload.database), 'utf8').digest('hex');
  await nodeFs.writeFile(filePath, JSON.stringify(goodPayload), 'utf8');
  const applyC = makeApply();
  const c = createPricingDatabaseCache({ filePath, fetchFn: async () => {}, apply: applyC, builtinSnapshotAt: '2026-10-01' });
  const sc = await c.restore();
  assert.equal(applyC.seen.length, 0, 'hash 对但 schema 不合法的缓存也不能进 apply');
  assert.match(sc.error, /校验失败/);
});

test('较旧缓存不覆盖较新的内置数据', async () => {
  const dir = tempDir();
  const filePath = join(dir, 'cache.json');
  const old = createPricingDatabaseCache({
    filePath,
    fetchFn: makeFetch({ [RAW]: { db: makeDb('2026-10-10') }, [CDN]: { db: makeDb('2026-10-10') } }),
    apply: makeApply(),
    builtinSnapshotAt: '2026-10-01',
  });
  await old.refresh(true);

  const apply = makeApply();
  const cache = createPricingDatabaseCache({
    filePath,
    fetchFn: async () => {
      throw new Error('offline');
    },
    apply,
    builtinSnapshotAt: '2026-10-21',
  });
  const state = await cache.restore();
  assert.equal(apply.seen.length, 0, '旧缓存不能盖掉更新的包内数据');
  assert.equal(state.ok, false);
  assert.equal(state.source, 'builtin');
  assert.equal(state.snapshotAt, '2026-10-21');
});

test('没有 filePath 时只在内存，绝不写 CWD', async () => {
  const before = new Set(readdirSync(process.cwd()));
  const db = makeDb('2026-10-21');
  const cache = createPricingDatabaseCache({
    fetchFn: makeFetch({ [RAW]: { db }, [CDN]: { db } }),
    apply: makeApply(),
    builtinSnapshotAt: '2026-10-01',
  });
  const state = await cache.refresh(true);
  assert.equal(state.ok, true);
  assert.equal(state.persisted, false);
  assert.equal(state.savedAt, null);
  const after = readdirSync(process.cwd()).filter((f) => !before.has(f));
  assert.deepEqual(after, [], '不得在 CWD 生成任何文件');
});

// ─────────────────────── 多源竞速 ───────────────────────

test('慢的旧 raw 与快的旧 CDN：只 apply 一次且是新数据', async () => {
  const dir = tempDir();
  const oldDb = makeDb('2026-10-20');
  const newDb = makeDb('2026-10-21', {
    'alpha::alpha-1': { provider: 'alpha', flat: { inputMiss: 7, inputHit: 0.7, output: 7 } },
  });
  const apply = makeApply();
  const cache = createPricingDatabaseCache({
    filePath: join(dir, 'cache.json'),
    fetchFn: makeFetch({
      [RAW]: { db: newDb, delayMs: 120 },
      [CDN]: { db: oldDb, delayMs: 5 },
    }),
    apply,
    builtinSnapshotAt: '2026-10-01',
  });
  const state = await cache.refresh(true);
  assert.equal(apply.seen.length, 1, '只能在全部结果落定后 apply 一次');
  assert.equal(state.snapshotAt, '2026-10-21');
  assert.equal(state.source, RAW);
  assert.equal(apply.seen[0].models['alpha::alpha-1'].flat.inputMiss, 7);
});

test('raw 坏、CDN 好时选合法的那份', async () => {
  const dir = tempDir();
  const bad = makeDb('2026-10-21');
  bad.models['alpha::alpha-1'].flat.output = -3;
  const good = makeDb('2026-10-20');
  const apply = makeApply();
  const cache = createPricingDatabaseCache({
    filePath: join(dir, 'cache.json'),
    fetchFn: makeFetch({ [RAW]: { db: bad }, [CDN]: { db: good } }),
    apply,
    builtinSnapshotAt: '2026-10-01',
  });
  const state = await cache.refresh(true);
  assert.equal(apply.seen.length, 1);
  assert.equal(state.source, CDN);
  assert.equal(state.snapshotAt, '2026-10-20');
});

test('同日多源按 urls 顺序优先（raw 优先），合法同日新内容允许替换', async () => {
  const dir = tempDir();
  const rawDb = makeDb('2026-10-21', {
    'alpha::alpha-1': { provider: 'alpha', flat: { inputMiss: 3, inputHit: 0.3, output: 3 } },
  });
  const cdnDb = makeDb('2026-10-21', {
    'alpha::alpha-1': { provider: 'alpha', flat: { inputMiss: 4, inputHit: 0.4, output: 4 } },
  });
  const apply = makeApply();
  const cache = createPricingDatabaseCache({
    filePath: join(dir, 'cache.json'),
    fetchFn: makeFetch({ [RAW]: { db: rawDb, delayMs: 30 }, [CDN]: { db: cdnDb, delayMs: 1 } }),
    apply,
    builtinSnapshotAt: '2026-10-01',
  });
  const state = await cache.refresh(true);
  assert.equal(state.source, RAW, '同一天选 raw');
  assert.equal(apply.seen[0].models['alpha::alpha-1'].flat.inputMiss, 3);

  // 同一天的新内容（换了 hash）应该被接受
  const changed = makeDb('2026-10-21', {
    'alpha::alpha-1': { provider: 'alpha', flat: { inputMiss: 5, inputHit: 0.5, output: 5 } },
  });
  const apply2 = makeApply();
  const cache2 = createPricingDatabaseCache({
    filePath: join(dir, 'cache2.json'),
    fetchFn: makeFetch({ [RAW]: { db: changed }, [CDN]: { db: changed } }),
    apply: apply2,
    builtinSnapshotAt: '2026-10-21',
  });
  const s2 = await cache2.refresh(true);
  assert.equal(s2.ok, true);
  assert.equal(apply2.seen.length, 1, '同日新内容必须能替换');
});

test('远端版本比当前旧时不倒退', async () => {
  const dir = tempDir();
  const filePath = join(dir, 'cache.json');
  const newDb = makeDb('2026-10-21');
  const oldDb = makeDb('2026-10-15');
  let payload = { db: newDb };
  const apply = makeApply();
  const cache = createPricingDatabaseCache({
    filePath,
    fetchFn: async (url) => {
      if (!payload.db) throw new Error('offline');
      if (!DEFAULT_PRICING_DB_URLS.includes(url)) throw new Error('bad url');
      return okResponse(payload.db);
    },
    apply,
    builtinSnapshotAt: '2026-10-01',
  });
  const first = await cache.refresh(true);
  assert.equal(first.snapshotAt, '2026-10-21');
  assert.equal(apply.seen.length, 1);

  payload = { db: oldDb };
  const second = await cache.refresh(true);
  assert.equal(apply.seen.length, 1, '旧版本不能被应用');
  assert.equal(second.snapshotAt, '2026-10-21');
  assert.equal(second.source, RAW, '来源不能被旧数据的地址顶掉');
  assert.match(second.error, /不新于当前有效数据/);
});

// ─────────────────────── TTL / 冷却 / singleflight ───────────────────────

test('TTL 内不重复联网，force 绕开 TTL，并发共享同一次请求', async () => {
  const dir = tempDir();
  let clock = Date.UTC(2026, 9, 21, 4);
  const db = makeDb('2026-10-21');
  let hits = 0;
  const fetchFn = async (url) => {
    hits += 1;
    assert.ok(DEFAULT_PRICING_DB_URLS.includes(url));
    await delay(20);
    return okResponse(db);
  };
  const apply = makeApply();
  const cache = createPricingDatabaseCache({
    filePath: join(dir, 'cache.json'),
    fetchFn,
    apply,
    builtinSnapshotAt: '2026-10-01',
    ttlMs: 24 * 60 * 60 * 1000,
    now: () => clock,
  });

  await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
  assert.equal(hits, 2, 'singleflight：两个源各一次，不因并发调用翻倍');
  assert.equal(apply.seen.length, 1, '并发下只 apply 一次');

  hits = 0;
  await cache.refresh();
  assert.equal(hits, 0, 'TTL 内不联网');

  clock += 25 * 60 * 60 * 1000;
  await cache.refresh();
  assert.equal(hits, 2, 'TTL 过期后重新联网');

  hits = 0;
  await cache.refresh(true);
  assert.equal(hits, 2, 'force 绕开 TTL');
});

test('失败后 5 分钟内不反复重试，过了冷却再试', async () => {
  const dir = tempDir();
  let clock = Date.UTC(2026, 9, 21, 4);
  let hits = 0;
  const fetchFn = async () => {
    hits += 1;
    throw new Error('network down');
  };
  const cache = createPricingDatabaseCache({
    filePath: join(dir, 'cache.json'),
    fetchFn,
    apply: makeApply(),
    builtinSnapshotAt: '2026-10-21',
    now: () => clock,
  });
  const s1 = await cache.refresh();
  assert.equal(s1.ok, false);
  assert.equal(s1.remoteOk, false);
  assert.equal(s1.source, 'builtin');
  const firstHits = hits;

  await cache.refresh();
  assert.equal(hits, firstHits, '冷却期内不重试');

  clock += 5 * 60 * 1000 + 1;
  await cache.refresh();
  assert.ok(hits > firstHits, '冷却结束后应重试');
});

test('网络失败时继续用最后有效数据，state 不误标 builtin', async () => {
  const dir = tempDir();
  const filePath = join(dir, 'cache.json');
  const db = makeDb('2026-10-21');
  let online = true;
  const fetchFn = async () => {
    if (!online) throw new Error('offline');
    return okResponse(db);
  };
  const cache = createPricingDatabaseCache({
    filePath,
    fetchFn,
    apply: makeApply(),
    builtinSnapshotAt: '2026-10-01',
  });
  await cache.refresh(true);
  online = false;
  const state = await cache.refresh(true);
  assert.equal(state.ok, true, '有可用数据');
  assert.equal(state.remoteOk, false, '最近联网失败');
  assert.equal(state.source, RAW, '来源必须是上次成功的远端 URL');
  assert.equal(state.snapshotAt, '2026-10-21');
  assert.match(state.error, /offline/);
});

test('apply 返回 false 时不写盘，也不改状态来源', async () => {
  const dir = tempDir();
  const filePath = join(dir, 'cache.json');
  const db = makeDb('2026-10-21');
  const apply = makeApply(false);
  const cache = createPricingDatabaseCache({
    filePath,
    fetchFn: makeFetch({ [RAW]: { db }, [CDN]: { db } }),
    apply,
    builtinSnapshotAt: '2026-10-01',
  });
  const state = await cache.refresh(true);
  assert.equal(apply.seen.length, 1);
  assert.equal(state.ok, false);
  assert.equal(state.source, 'builtin');
  assert.equal(state.persisted, false);
  assert.equal(existsSync(filePath), false, 'apply 拒绝后不能落盘');
});

// ─────────────────────── 状态与隔离 ───────────────────────

test('state() 每次返回副本，不泄露 database', async () => {
  const dir = tempDir();
  const db = makeDb('2026-10-21');
  const cache = createPricingDatabaseCache({
    filePath: join(dir, 'cache.json'),
    fetchFn: makeFetch({ [RAW]: { db }, [CDN]: { db } }),
    apply: makeApply(),
    builtinSnapshotAt: '2026-10-01',
  });
  await cache.refresh(true);
  const a = cache.state();
  assert.equal('database' in a, false);
  assert.equal('models' in a, false);
  for (const key of ['at', 'ok', 'source', 'snapshotAt', 'savedAt', 'persisted', 'remoteOk', 'error']) {
    assert.ok(key in a, `state 缺少 ${key}`);
  }
  a.ok = false;
  a.source = 'tampered';
  const b = cache.state();
  assert.equal(b.ok, true);
  assert.equal(b.source, RAW);
});

test('包内初始状态 ok=false、source=builtin、remoteOk=false', () => {
  const cache = createPricingDatabaseCache({
    fetchFn: async () => {},
    apply: async () => true,
    builtinSnapshotAt: '2026-10-21',
  });
  const s = cache.state();
  assert.equal(s.ok, false);
  assert.equal(s.source, 'builtin');
  assert.equal(s.snapshotAt, '2026-10-21');
  assert.equal(s.remoteOk, false);
  assert.equal(s.persisted, false);
});

test('坏库不会通过 apply 改掉 FX，本地自定义价不受缓存层影响', async () => {
  const fxBefore = getFxUsd();
  const bad = makeDb('2026-10-21');
  bad.fx = { USD: 999 };
  bad.models['alpha::alpha-1'].flat.output = -1;

  const cache = createPricingDatabaseCache({
    filePath: join(tempDir(), 'cache.json'),
    // 直接走真实 setPricingConfig：坏库必须在 apply 之前被拦下
    fetchFn: makeFetch({ [RAW]: { db: bad }, [CDN]: { db: bad } }),
    apply: (db) => {
      const ok = setPricingConfig(db);
      return ok;
    },
    builtinSnapshotAt: '2026-10-01',
  });
  await cache.refresh(true);
  assert.equal(getFxUsd(), fxBefore, '坏库不能改动全局汇率');

  const good = makeDb('2026-10-21');
  good.fx = { USD: 7.1 };
  const cache2 = createPricingDatabaseCache({
    filePath: join(tempDir(), 'cache.json'),
    fetchFn: makeFetch({ [RAW]: { db: good }, [CDN]: { db: good } }),
    apply: (db) => setPricingConfig(db),
    builtinSnapshotAt: '2026-10-01',
  });
  await cache2.refresh(true);
  assert.equal(getFxUsd(), 7.1, '合法库的汇率才会生效');

  // 缓存层没有碰本地覆盖镜像：本地覆盖由应用层注入，二者互不影响
  const { setLocalPricing, getLocalPricingEntries } = await import('./usage-parser.js');
  setLocalPricing({ 'alpha::alpha-1': { providerId: 'alpha', modelId: 'alpha-1', enabled: true, billingType: 'payg', prices: { inputMiss: 100, inputHit: 0, output: 100 } } }, 1);
  await cache2.refresh(true);
  const entries = getLocalPricingEntries();
  const localHit = entries.find((e) => e.providerId === 'alpha' && e.modelId === 'alpha-1');
  assert.ok(localHit, '本地覆盖条目应仍在册');
  assert.equal(localHit.prices.inputMiss, 100, '刷新公共库不得改写本地覆盖');
  setLocalPricing({}, 2);
});

test('默认双源与构造函数契约', () => {
  assert.equal(DEFAULT_PRICING_DB_URLS.length, 2);
  assert.match(DEFAULT_PRICING_DB_URLS[0], /raw\.githubusercontent\.com/);
  assert.match(DEFAULT_PRICING_DB_URLS[1], /cdn\.jsdelivr\.net/);
  assert.throws(() => createPricingDatabaseCache({ apply: async () => true }), /fetchFn/);
  assert.throws(() => createPricingDatabaseCache({ fetchFn: async () => {} }), /apply/);
});
