import { createHash } from 'node:crypto';
import { queryVolcengineSubscription } from './volcengine-plan.js';
import { getFxUsd, getLocalPricingEntries } from './usage-parser.js';
import { billingModeOf } from './provider-directory.js';
import { subscriptionCost, summarizeSubscriptions } from './subscriptions-store.js';

const DAY = 86400000;
const round = n => Math.round(n * 1e6) / 1e6;
function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function dayStart(t) { const d = new Date(t); d.setHours(0,0,0,0); return +d; }
function nextDay(t) { const d = new Date(t); d.setDate(d.getDate()+1); d.setHours(0,0,0,0); return +d; }

export function createSubscriptionsService({ store, getConfig, sdk, query = queryVolcengineSubscription }) {
  let inflight = null, nextSyncAt = 0, configKey = '', diagnostics = [];
  async function sync(force = false) {
    if (inflight) return inflight;
    const cfg = await getConfig();
    if (inflight) return inflight;
    const key = createHash('sha256').update(String(cfg.volcengineAccessKey || '') + '\0' + String(cfg.volcengineSecretKey || '')).digest('hex');
    if (key !== configKey) { configKey = key; nextSyncAt = 0; }
    if (!force && Date.now() < nextSyncAt) return snapshot();
    inflight = (async () => {
      nextSyncAt = Date.now() + 60000;
      const ak = cfg.volcengineAccessKey, sk = cfg.volcengineSecretKey;
      if (!ak || !sk) { diagnostics = [{ providerId: 'volcengine-coding', status: 'no_key', note: '火山自动查询需要供应商设置中的管理端 AccessKey ID / SecretAccessKey，模型 API Key 不适用' }]; return snapshot(); }
      let baseUrl = '';
      try { baseUrl = (await sdk.providers.getCredentials({ providerId: 'volcengine-coding' }))?.baseUrl || ''; } catch {}
      let result;
      try { result = await query({ fetchFn: (url, options) => sdk.network.fetch(url, options), accessKeyId: ak, secretAccessKey: sk, baseUrl, planKind: 'coding', scope: 'personal', timeoutMs: 6000 }); }
      catch { result = { ok: false, reason: 'network' }; }
      if (result.ok) {
        const records = (result.subscriptions || []).map(row => ({
          providerId: 'volcengine-coding', externalId: row.externalId, planName: row.planName || '火山 Coding Plan',
          planKind: row.planKind || 'coding', scope: row.scope || 'personal', validFrom: row.validFrom || null, validTo: row.validTo || null,
          amount: null, currency: 'CNY', syncedAt: new Date().toISOString(),
        }));
        if (!records.some(row => row.validTo)) {
          diagnostics = [{ providerId: 'volcengine-coding', status: 'parse_failed', note: '响应中没有可确认的套餐结束时间，未自动创建计费记录' }];
          return snapshot();
        }
        await store.mergeOfficial(records);
        nextSyncAt = Date.now() + 15*60000;
        diagnostics = [{ providerId: 'volcengine-coding', status: result.reason === 'ambiguous' ? 'ambiguous' : 'ok', note: result.reason === 'ambiguous' ? '查到多个订阅，已分条列出但未替你选择，确认对应周期并补齐实付后才计费' : '已同步官方有效期；未取得的生效时间和实付金额需补录，不能用额度重置时间或官网标价推算' }];
      } else {
        const messages = { no_key: '管理凭据未配置', auth: '管理凭据签名失败，请检查 AccessKey ID / SecretAccessKey', permission: '缺少 ark:ListSubscribeTrade 只读权限，不影响原有额度查询', network: '套餐信息查询暂时失败，已保留上次记录', empty: '未查到可确认的个人 Coding Plan 订阅，团队席位需另行核实', ambiguous: '官方返回多个无法唯一识别的订阅，未自动选择', unsupported: '当前订阅类型尚未适配' };
        diagnostics = [{ providerId: 'volcengine-coding', status: result.reason || 'api', note: messages[result.reason] || '套餐信息未确认，保留原有记录及额度查询' }];
      }
      return snapshot();
    })();
    try { return await inflight; } finally { inflight = null; }
  }
  async function snapshot() {
    const data = await store.snapshot(), now = Date.now();
    return { entries: data.entries.map(e => ({ ...e, costCny: subscriptionCost(e, 0, now), incomplete: e.amount == null || !e.validFrom || !e.validTo })),
      revision: data.revision, fxUsd: getFxUsd(), diagnostics, nextSyncAt, summary: summarizeSubscriptions(data.entries, { now }) };
  }
  function scheduleSync() { sync().catch(() => {}); }
  async function totals(base) {
    scheduleSync(); const { entries, revision } = await store.snapshot(); const now = Date.now();
    const summary = summarizeSubscriptions(entries, { now }), today = summarizeSubscriptions(entries, { now, from: dayStart(now) });
    const perProvider = { ...(base.perProvider || {}) };
    for (const [id, cost] of Object.entries(summary.perProvider)) perProvider[id] = round((perProvider[id] || 0) + cost);
    const todayProvider = { ...(base.todayProvider || {}) };
    for (const [id, cost] of Object.entries(today.perProvider)) todayProvider[id] = round((todayProvider[id] || 0) + cost);
    return { ...base, tokenCostCny: base.totalCost ?? null,
      totalCost: base.totalCost == null && !summary.costCny ? null : round((base.totalCost || 0) + summary.costCny),
      todayCost: round((base.todayCost || 0) + today.costCny), perProvider, todayProvider,
      subscriptionCostCny: round(summary.costCny), subscriptionPaidCny: round(summary.paidCny),
      subscriptionIncompleteCount: summary.incompleteCount, subscriptionRevision: revision, costBasis: 'token-estimate-plus-subscription-accrual' };
  }
  async function ledger(base, providerId) {
    scheduleSync(); const { entries, revision } = await store.snapshot(); const now = Date.now();
    const selected = entries.filter(e => e.enabled && (!providerId || e.providerId === providerId));
    const summary = summarizeSubscriptions(selected, { now });
    const timeBuckets = {};
    const spans = { hour: DAY, d7: 7*DAY, d30: 30*DAY };
    for (const unit of ['hour','d7','d30','day']) {
      const original = base.timeBuckets?.[unit] || Array(256).fill(0);
      timeBuckets[unit] = Array.from({ length: 256 }, (_, i) => {
        let from, to;
        if (unit === 'day') { const d = new Date(dayStart(now)); d.setDate(d.getDate()-(255-i)); from=+d; to=Math.min(nextDay(from),now); }
        else { const width=spans[unit]/256; from=now-spans[unit]+i*width; to=from+width; }
        return round((Number(original[i]) || 0) + selected.reduce((n,e)=>n+subscriptionCost(e,from,to),0));
      });
    }
    const days = structuredClone(base.days || {});
    let daysTruncatedFrom = null;
    for (const entry of selected) {
      if (entry.amount == null || !entry.validFrom || !entry.validTo) continue;
      // Costs are calculated from records; never written into frozen Token aggregates.
      const cutoff = dayStart(now)-256*DAY;
      if (Date.parse(entry.validFrom) < cutoff) daysTruncatedFrom = dayKey(cutoff);
      let t = dayStart(Math.max(Date.parse(entry.validFrom), cutoff));
      const end = Math.min(now, Date.parse(entry.validTo)); let guard=0;
      while (t < end && guard++ < 258) {
        const next=nextDay(t), key=dayKey(t), cost=subscriptionCost(entry,t,Math.min(next,now));
        if (cost) { const row=days[key] || (days[key]={tokens:0,calls:0,cost:0}); row.cost=round((row.cost||0)+cost); row.subscriptionCostCny=round((row.subscriptionCostCny||0)+cost); }
        t=next;
      }
    }
    const providers=structuredClone(base.providers||{});
    for(const [id,cost] of Object.entries(summary.perProvider)) { const row=providers[id]||(providers[id]={calls:0,tokens:0,cost:0});row.cost=round((row.cost||0)+cost);row.subscriptionCostCny=round(cost); }
    return { ...base, days, timeBuckets, providers, daysTruncatedFrom, subscriptionCostCny:round(summary.costCny), subscriptionPaidCny:round(summary.paidCny), subscriptionIncompleteCount:summary.incompleteCount, subscriptionRevision:revision };
  }
  return { store, sync, scheduleSync, snapshot, totals, ledger };
}

export function registerSubscriptionsRoutes(app, service) {
  const safe = fn => async c => { try { return c.json(await fn(c)); } catch(e) { return c.json({ ok:false,error:e.code||'subscription-error',message:e.code?e.message:'订阅记录操作失败，未报告成功' },e.status||500); } };
  app.get('/api/subscriptions', safe(async()=>{ service.scheduleSync();return service.snapshot(); }));
  app.post('/api/subscriptions/sync', safe(()=>service.sync(true)));
  app.post('/api/subscriptions', safe(async c=>{
    const body=await c.req.json().catch(()=>null);if(!body?.entry)throw Object.assign(new Error('请求内容无效'),{code:'invalid-body',status:400});
    const provider = String(body.entry.providerId || '').trim().toLowerCase();
    const hasSubscriptionModel = Object.values(getLocalPricingEntries()).some(e => e.enabled && e.providerId === provider && e.billingType === 'subscription');
    if (billingModeOf(provider, null) !== 'subscription' && !hasSubscriptionModel) throw Object.assign(new Error('请先为此供应商的套内模型配置「订阅」计费类型，再登记套餐，避免与按量费用重复计算'), { code:'validation',status:400 });
    const saved=await service.store.upsert(body.entry,body.expectedRevision,{fxUsd:getFxUsd()});return {ok:true,...saved};
  }));
  app.post('/api/subscriptions/remove', safe(async c=>{
    const body=await c.req.json().catch(()=>null);if(typeof body?.id!=='string')throw Object.assign(new Error('记录 ID 无效'),{code:'invalid-body',status:400});
    return {ok:true,...await service.store.remove(body.id,body.expectedRevision)};
  }));
}
