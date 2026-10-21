import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSubscriptionsStore, subscriptionCost, summarizeSubscriptions, normalizeSubscription } from './subscriptions-store.js';
import { createSubscriptionsService, registerSubscriptionsRoutes } from './subscriptions-service.js';
const DAY = 86400000, start = Date.parse('2026-10-01T00:00:00Z');
const base = { providerId:'volcengine-coding',planName:'Coding',validFrom:new Date(start).toISOString(),validTo:new Date(start+30*DAY).toISOString(),amount:90,currency:'CNY',enabled:true };
async function fixture(fn) { const dir=await fs.mkdtemp(path.join(os.tmpdir(),'si-subscriptions-'));const filePath=path.join(dir,'subscriptions.json');try{await fn(createSubscriptionsStore({filePath}),filePath);}finally{await fs.rm(dir,{recursive:true,force:true});} }
const official = (end=base.validTo) => ({ providerId:'volcengine-coding',planKind:'coding',scope:'personal',externalId:'instance-a',planName:'Coding',validFrom:null,validTo:end,amount:null,currency:'CNY' });

test('90元30天，10天分摊30，实付90，不超有效期',()=>{
 const entry=normalizeSubscription(base);
 assert.equal(subscriptionCost(entry,0,start+10*DAY),30);
 assert.equal(subscriptionCost(entry,0,start+60*DAY),90);
 assert.equal(subscriptionCost(entry,0,start-1),0);
 assert.equal(subscriptionCost(entry,start+10*DAY,start+11*DAY),3);
 const s=summarizeSubscriptions([entry],{now:start+10*DAY});assert.equal(s.paidCny,90);assert.equal(s.costCny,30);
});
test('缺起始、金额或结束不计费，0金额可明确免费，停用不计费',()=>{
 for(const key of ['validFrom','validTo','amount']){const e=normalizeSubscription({...base,[key]:null});assert.equal(subscriptionCost(e,0,start+10*DAY),0);assert.equal(summarizeSubscriptions([e]).incompleteCount,1);}
 assert.equal(summarizeSubscriptions([normalizeSubscription({...base,amount:0})]).incompleteCount,0);
 assert.equal(subscriptionCost(normalizeSubscription({...base,enabled:false}),0,start+10*DAY),0);
});
test('不接受字符串金额、负数、无时区日期、倒置周期与伪来源',()=>{
 for(const bad of [{amount:'90'},{amount:-1},{validFrom:'2026-10-01T00:00:00'},{validTo:base.validFrom},{enabled:'true'}])assert.throws(()=>normalizeSubscription({...base,...bad}));
 assert.equal(normalizeSubscription({...base,source:'official',externalId:'spoof'}).source,'manual');
});
test('美元入账汇率固定，不随后续公共汇率变动',()=>{
 const e=normalizeSubscription({...base,currency:'USD'},undefined,{fxUsd:7});assert.equal(e.fxRate,7);assert.equal(subscriptionCost(e,0,start+30*DAY),630);
 const next=normalizeSubscription({...e,planName:'Changed'},e,{fxUsd:9});assert.equal(next.fxRate,7);
});
test('原子保存、重启读回、CAS冲突不污染记录',()=>fixture(async(store,filePath)=>{
 const saved=await store.upsert(base,0);assert.equal(saved.revision,1);
 await assert.rejects(()=>store.upsert({...saved.entry,amount:100},0),e=>e.status===409);
 assert.equal((await store.snapshot()).entries[0].amount,90);
 assert.equal((await createSubscriptionsStore({filePath}).snapshot()).revision,1);
}));
test('并发写入不丢记录',()=>fixture(async store=>{
 await Promise.all([store.upsert(base),store.upsert({...base,planName:'Another'})]);assert.equal((await store.snapshot()).entries.length,2);
}));
test('官方同步缺项不计费，重复同步幂等，手填金额/起始不被抹掉',()=>fixture(async store=>{
 await store.mergeOfficial([official()]);let s=await store.snapshot();assert.equal(s.entries.length,1);assert.equal(s.entries[0].amount,null);const revision=s.revision;
 await store.mergeOfficial([official()]);assert.equal((await store.snapshot()).revision,revision);
 await store.upsert({...s.entries[0],validFrom:base.validFrom,amount:90},s.revision);
 await store.mergeOfficial([official()]);s=await store.snapshot();assert.equal(s.entries[0].amount,90);assert.equal(s.entries[0].validFrom,base.validFrom);
}));
test('官方结束日期不可手改，续费延长不改旧付款，而是新增缺项记录',()=>fixture(async store=>{
 await store.mergeOfficial([official()]);let s=await store.snapshot();const old=s.entries[0];
 await assert.rejects(()=>store.upsert({...old,validTo:new Date(start+60*DAY).toISOString()},s.revision),/官方结束/);
 await store.upsert({...old,validFrom:base.validFrom,amount:90},s.revision);
 await store.mergeOfficial([official(new Date(start+60*DAY).toISOString())]);s=await store.snapshot();assert.equal(s.entries.length,2);assert.equal(s.entries[0].amount,90);assert.equal(s.entries[1].amount,null);
 await assert.rejects(()=>store.upsert({...s.entries[1],validFrom:base.validFrom,amount:90},s.revision),/重叠/);
}));
test('删除官方记录会抑制同步复活，删除不存在记录幂等',()=>fixture(async store=>{
 await store.mergeOfficial([official()]);const s=await store.snapshot();assert.equal((await store.remove(s.entries[0].id,s.revision)).removed,true);
 await store.mergeOfficial([official()]);assert.equal((await store.snapshot()).entries.length,0);assert.equal((await store.remove('none')).removed,false);
}));
test('损坏文件不静默重置',()=>fixture(async(store,filePath)=>{
 await fs.writeFile(filePath,'{bad');await assert.rejects(()=>store.upsert(base),e=>e.code==='store-corrupt');assert.equal(await fs.readFile(filePath,'utf8'),'{bad');
}));
test('自动查询复用管理凭据、只读默认个人Coding、输出不含密钥',()=>fixture(async store=>{
 let calls=0;const service=createSubscriptionsService({store,getConfig:async()=>({volcengineAccessKey:'secret-ak',volcengineSecretKey:'secret-sk'}),sdk:{providers:{getCredentials:async()=>({baseUrl:'https://ark.cn-beijing.volces.com/api/coding'})},network:{}},query:async args=>{calls++;assert.equal(args.planKind,'coding');assert.equal(args.scope,'personal');return {ok:true,subscriptions:[{...official(),validFrom:null}]};}});
 const data=await service.sync(true);assert.equal(calls,1);assert.equal(data.entries.length,1);assert.equal(data.summary.costCny,0);assert.equal(data.summary.incompleteCount,1);assert.ok(!JSON.stringify(data).includes('secret-'));
}));
test('缺Key不请求，权限不足保留旧记录，刷新失败不影响计费',()=>fixture(async store=>{
 let calls=0;const noKey=createSubscriptionsService({store,getConfig:async()=>({}),sdk:{},query:async()=>{calls++;}});assert.equal((await noKey.sync()).diagnostics[0].status,'no_key');assert.equal(calls,0);
 await store.upsert({...base,validFrom:new Date(Date.now()-30*DAY).toISOString(),validTo:new Date(Date.now()+DAY).toISOString()});
 const denied=createSubscriptionsService({store,getConfig:async()=>({volcengineAccessKey:'a',volcengineSecretKey:'b'}),sdk:{providers:{getCredentials:async()=>({})}},query:async()=>({ok:false,reason:'permission'})});
 const data=await denied.sync(true);assert.equal(data.entries.length,1);assert.equal(data.diagnostics[0].status,'permission');assert.ok(data.summary.costCny>0);
}));
test('总额overlay不改原Token账本、不重复累加，日桶和各跨度含套餐分摊',()=>fixture(async store=>{
 const now=Date.now();await store.upsert({...base,validFrom:new Date(now-10*DAY).toISOString(),validTo:new Date(now+20*DAY).toISOString()});
 const service=createSubscriptionsService({store,getConfig:async()=>({}),sdk:{}});const raw={totalCost:12,perProvider:{'volcengine-coding':0}};
 const a=await service.totals(raw),b=await service.totals(raw);assert.ok(Math.abs(a.totalCost-42)<0.01);assert.ok(Math.abs(a.totalCost-b.totalCost)<0.01);assert.equal(raw.totalCost,12);
 const ledger={at:now,days:{},timeBuckets:{hour:Array(256).fill(0),d7:Array(256).fill(0),d30:Array(256).fill(0),day:Array(256).fill(0)}};const result=await service.ledger(ledger,null);
 assert.ok(result.timeBuckets.hour.some(x=>x>0));assert.ok(result.timeBuckets.d7.some(x=>x>0));assert.ok(result.timeBuckets.day.some(x=>x>0));assert.equal(ledger.timeBuckets.hour.every(x=>x===0),true);
 const other=await service.ledger(ledger,'other');assert.equal(other.subscriptionCostCny,0);
}));
test('管理凭据变更立即重试，不被上次失败的15分钟缓存挡住',()=>fixture(async store=>{
 let cfg={volcengineAccessKey:'old',volcengineSecretKey:'sk'},calls=0;
 const service=createSubscriptionsService({store,getConfig:async()=>cfg,sdk:{providers:{getCredentials:async()=>({})}},query:async()=>{calls++;return calls===1?{ok:false,reason:'auth'}:{ok:true,subscriptions:[official()]};}});
 await service.sync();await service.sync();assert.equal(calls,1);
 cfg={volcengineAccessKey:'new',volcengineSecretKey:'sk'};const result=await service.sync();assert.equal(calls,2);assert.equal(result.entries.length,1);
}));
test('长期套餐总额完整累计，日曲线裁剪范围明确标识',()=>fixture(async store=>{
 const now=Date.now();await store.upsert({...base,amount:365,validFrom:new Date(now-300*DAY).toISOString(),validTo:new Date(now+65*DAY).toISOString()});
 const service=createSubscriptionsService({store,getConfig:async()=>({}),sdk:{}});const result=await service.ledger({days:{},timeBuckets:{}},null);
 assert.ok(result.daysTruncatedFrom);assert.ok(result.subscriptionCostCny>299.99);assert.ok(Object.keys(result.days).length<=258);
}));
test('HTTP保存、CAS与停用立即反映，按量供应商不允许重复叠套餐',()=>fixture(async store=>{
 const service=createSubscriptionsService({store,getConfig:async()=>({}),sdk:{}});const routes=new Map(),app={get:(p,h)=>routes.set('GET '+p,h),post:(p,h)=>routes.set('POST '+p,h)};registerSubscriptionsRoutes(app,service);
 const call=async(method,p,body)=>routes.get(method+' '+p)({req:{json:async()=>body},json:(data,status=200)=>({data,status})});
 const saved=await call('POST','/api/subscriptions',{entry:base,expectedRevision:0});assert.equal(saved.status,200);
 const conflict=await call('POST','/api/subscriptions',{entry:base,expectedRevision:0});assert.equal(conflict.status,409);
 const metered=await call('POST','/api/subscriptions',{entry:{...base,providerId:'deepseek'}});assert.equal(metered.status,400);
 const listing=await call('GET','/api/subscriptions');assert.equal(listing.data.entries.length,1);
}));
