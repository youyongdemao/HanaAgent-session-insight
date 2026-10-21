// lib/volcengine-subscription.test.js —— 火山方舟套餐订阅（到期日）只读查询
//
// 全部用 fetch mock，不联网、不读凭据、不触发任何生产调用。
// 覆盖：no_key / auth / permission / 秒与毫秒与 ISO 解析 / 0 值 / 歧义 / 脱敏 /
//       JSON body 签名一致 / 分桶不混用 / team unsupported / 额度查询兼容与优先级。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { queryVolcenginePlan, queryVolcengineSubscription } from './volcengine-plan.js';

const AK = 'AKLTtestaccesskey0001';
const SK = 'testsecretkey0000000000000000000001';

/** 记录调用并按脚本回包的最小 fetch 替身。 */
function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = (await responder(url, init, calls.length)) || {};
    const status = r.status ?? 200;
    const body = r.body === undefined ? {} : r.body;
    return {
      status,
      ok: r.ok ?? status < 400,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function subBody(infoList) {
  return { ResponseMetadata: { RequestId: 'req-1' }, Result: { InfoList: infoList } };
}

async function call(mock, overrides = {}) {
  return queryVolcengineSubscription({
    fetchFn: mock,
    accessKeyId: AK,
    secretAccessKey: SK,
    timeoutMs: 30,
    ...overrides,
  });
}

test('缺凭据时不发请求，返回 no_key', async () => {
  const mock = mockFetch(() => ({ body: subBody([]) }));
  const r = await call(mock, { accessKeyId: '', secretAccessKey: '' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_key');
  assert.deepEqual(r.subscriptions, []);
  assert.equal(mock.calls.length, 0);
});

test('签名失败归 auth，且 detail 不含 AK/SK', async () => {
  const mock = mockFetch(() => ({
    body: {
      ResponseMetadata: {
        Error: { Code: 'SignatureFailure', Message: `bad signature for ${AK} / ${SK}` },
      },
    },
  }));
  const r = await call(mock);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'auth');
  assert.ok(!r.detail.includes(AK), 'detail 不应包含 AccessKey');
  assert.ok(!r.detail.includes(SK), 'detail 不应包含 SecretKey');
  assert.ok(r.detail.includes('***'));
});

test('IAM 未授权归 permission，与签名错误区分', async () => {
  const mock = mockFetch(() => ({
    body: { ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'no ark:ListSubscribeTrade' } } },
  }));
  const r = await call(mock);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'permission');
  assert.deepEqual(r.subscriptions, []);
});

test('EndTime 为 Unix 秒时换算成 ISO', async () => {
  const sec = 1790000000;
  const mock = mockFetch(() => ({ body: subBody([{ InstanceID: 'sub-1', EndTime: sec }]) }));
  const r = await call(mock);
  assert.equal(r.ok, true);
  assert.equal(r.reason, undefined);
  assert.equal(r.subscriptions.length, 1);
  assert.equal(r.subscriptions[0].validTo, new Date(sec * 1000).toISOString());
});

test('EndTime 为毫秒数字字符串时按毫秒解析', async () => {
  const ms = 1790000000000;
  const mock = mockFetch(() => ({ body: subBody([{ InstanceID: 'sub-2', EndTime: String(ms) }]) }));
  const r = await call(mock);
  assert.equal(r.subscriptions[0].validTo, new Date(ms).toISOString());
});

test('EndTime 为带时区 ISO 时按原时区解析', async () => {
  const iso = '2026-11-01T00:00:00+08:00';
  const mock = mockFetch(() => ({ body: subBody([{ InstanceID: 'sub-3', EndTime: iso }]) }));
  const r = await call(mock);
  assert.equal(r.subscriptions[0].validTo, new Date(iso).toISOString());
});

test('EndTime 为 0 或缺失时 validTo 为 null，不伪造 1970', async () => {
  const mock = mockFetch(() => ({ body: subBody([{ InstanceID: 'sub-4', EndTime: 0 }]) }));
  const r = await call(mock);
  assert.equal(r.ok, true);
  assert.equal(r.subscriptions[0].validTo, null);

  const mock2 = mockFetch(() => ({ body: subBody([{ InstanceID: 'sub-5' }]) }));
  const r2 = await call(mock2);
  assert.equal(r2.subscriptions[0].validTo, null);
});

test('取 InstanceID 作 externalId，validFrom/amount/currency 一律 null', async () => {
  const mock = mockFetch(() => ({ body: subBody([{ InstanceID: 'trade-abc', EndTime: 1790000000 }]) }));
  const r = await call(mock);
  const s = r.subscriptions[0];
  assert.equal(s.externalId, 'trade-abc');
  assert.equal(s.planName, 'Coding Plan');
  assert.equal(s.planKind, 'coding');
  assert.equal(s.scope, 'personal');
  assert.equal(s.validFrom, null);
  assert.equal(s.amount, null);
  assert.equal(s.currency, null);
});

test('缺 ID 时用 kind/scope/到期拼稳定指纹', async () => {
  const sec = 1790000000;
  const mock = mockFetch(() => ({ body: subBody([{ EndTime: sec }]) }));
  const r = await call(mock);
  assert.equal(r.subscriptions[0].externalId, `volc:coding:personal:${new Date(sec * 1000).toISOString()}`);
});

test('多条订阅条目标 ambiguous，不自动取第一条', async () => {
  const mock = mockFetch(() => ({
    body: subBody([
      { InstanceID: 'a', EndTime: 1790000000 },
      { InstanceID: 'b', EndTime: 1795000000 },
    ]),
  }));
  const r = await call(mock);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ambiguous');
  assert.equal(r.subscriptions.length, 2);
  assert.match(r.detail, /2 条/);
});

test('重复条目同样标 ambiguous', async () => {
  const mock = mockFetch(() => ({
    body: subBody([
      { InstanceID: 'dup', EndTime: 1790000000 },
      { InstanceID: 'dup', EndTime: 1790000000 },
    ]),
  }));
  const r = await call(mock);
  assert.equal(r.reason, 'ambiguous');
  assert.match(r.detail, /重复/);
});

test('投影只含白名单字段，不外流原始响应', async () => {
  const mock = mockFetch(() => ({
    body: {
      ResponseMetadata: { RequestId: 'req-xyz', Action: 'ListSubscribeTrade' },
      Result: {
        InfoList: [
          {
            InstanceID: 'sub-9',
            EndTime: 1790000000,
            BuyerID: '2100000000',
            SecretToken: 'should-not-leak',
            InnerNote: 'internal',
          },
        ],
        TotalCount: 1,
      },
    },
  }));
  const r = await call(mock);
  const keys = Object.keys(r.subscriptions[0]).sort();
  assert.deepEqual(keys, [
    'amount',
    'currency',
    'externalId',
    'planKind',
    'planName',
    'scope',
    'validFrom',
    'validTo',
  ]);
  const flat = JSON.stringify(r);
  assert.ok(!flat.includes('should-not-leak'));
  assert.ok(!flat.includes('BuyerID'));
  assert.ok(!flat.includes('2100000000'));
});

test('Coding 个人版只传空 ResourceNames，不混用 RealAgentPlanPersonal', async () => {
  const mock = mockFetch(() => ({ body: subBody([{ InstanceID: 'c1', EndTime: 1790000000 }]) }));
  await call(mock, { planKind: 'coding' });
  assert.equal(mock.calls.length, 1);
  const sent = JSON.parse(mock.calls[0].init.body);
  assert.deepEqual(sent.ResourceNames, ['']);
  assert.ok(!mock.calls[0].init.body.includes('RealAgentPlanPersonal'));
});

test('Agent 个人版才传 RealAgentPlanPersonal', async () => {
  const mock = mockFetch(() => ({ body: subBody([{ InstanceID: 'a1', EndTime: 1790000000 }]) }));
  const r = await call(mock, { planKind: 'agent' });
  assert.deepEqual(JSON.parse(mock.calls[0].init.body).ResourceNames, ['RealAgentPlanPersonal']);
  assert.equal(r.subscriptions[0].planName, 'Agent Plan');
  assert.equal(r.subscriptions[0].planKind, 'agent');
});

test('JSON body 的签名与实际发送逐字一致', async () => {
  const mock = mockFetch(() => ({ body: subBody([{ InstanceID: 'x', EndTime: 1790000000 }]) }));
  await call(mock);
  const body = mock.calls[0].init.body;
  assert.equal(typeof body, 'string');
  assert.equal(mock.calls[0].init.headers['X-Content-Sha256'], sha256(body));
  assert.match(mock.calls[0].url, /Action=ListSubscribeTrade/);
  assert.match(mock.calls[0].url, /Version=2024-01-01/);
});

test('scope=team 明确 unsupported，且不发起请求', async () => {
  const mock = mockFetch(() => ({ body: subBody([]) }));
  const r = await call(mock, { scope: 'team' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsupported');
  assert.deepEqual(r.subscriptions, []);
  assert.equal(mock.calls.length, 0);
});

test('InfoList 缺失或非数组时归 parse_failed', async () => {
  const mock = mockFetch(() => ({ body: { Result: {} } }));
  const r = await call(mock);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'parse_failed');
});

test('InfoList 为空时归 empty', async () => {
  const mock = mockFetch(() => ({ body: subBody([]) }));
  const r = await call(mock);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('网络异常归 network，detail 已脱敏', async () => {
  const mock = mockFetch(() => {
    throw new Error(`connect ECONNREFUSED while using ${SK}`);
  });
  const r = await call(mock);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'network');
  assert.ok(!r.detail.includes(SK));
});

test('额度查询仍走无 body 的 POST（签名空串）', async () => {
  const mock = mockFetch(() => ({
    body: {
      Result: {
        AFPFiveHour: { Quota: '100', Used: '25', ResetTime: 1790000000000 },
      },
    },
  }));
  const r = await queryVolcenginePlan({
    fetchFn: mock,
    accessKeyId: AK,
    secretAccessKey: SK,
    timeoutMs: 30,
  });
  assert.equal(r.ok, true);
  assert.equal(mock.calls[0].init.body, '');
  assert.equal(mock.calls[0].init.headers['X-Content-Sha256'], sha256(''));
});

test('Coding 专用 baseUrl 优先查 GetCodingPlanUsage，避免串 Agent 套餐', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('Action=GetCodingPlanUsage')) {
      return {
        body: {
          Result: {
            QuotaUsage: [{ Level: 'session', Percent: 12, ResetTimestamp: 1790000000 }],
          },
        },
      };
    }
    return {
      status: 400,
      body: { ResponseMetadata: { Error: { Code: 'InvalidAction', Message: 'nope' } } },
    };
  });
  const r = await queryVolcenginePlan({
    fetchFn: mock,
    accessKeyId: AK,
    secretAccessKey: SK,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    timeoutMs: 30,
  });
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'Coding Plan');
  assert.match(mock.calls[0].url, /Action=GetCodingPlanUsage/);
  assert.equal(mock.calls.length, 1);
});

test('非 Coding baseUrl 仍先查 Agent 额度', async () => {
  const mock = mockFetch(() => ({
    body: { Result: { AFPFiveHour: { Quota: '100', Used: '1', ResetTime: 1790000000000 } } },
  }));
  const r = await queryVolcenginePlan({
    fetchFn: mock,
    accessKeyId: AK,
    secretAccessKey: SK,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    timeoutMs: 30,
  });
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'Agent Plan');
  assert.match(mock.calls[0].url, /Action=GetAFPUsage/);
});
