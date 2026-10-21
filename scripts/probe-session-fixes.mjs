// Isolated real workbench regression for the three screenshot bugs. No host credentials.
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'si-three-fixes-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const buckets=Object.fromEntries(['hour','d7','d30','day'].map((unit,j)=>[unit,Array.from({length:256},(_,i)=>i%(19+j*3)===0?(i%5+1)*(j+1):0)]));
const stats={file:'probe.jsonl',title:'隔离测试会话',turns:1,sessionTokens:1000000,sessionCostCny:2,contextPercent:10,contextWindow:128000,lastWindowTokens:12800,series:[{turn:1,total:1000000,cost:2,input:1000000,output:0,cacheRead:0,cacheMiss:1000000,hit:0}],providers:[{provider:'deepseek',tokens:1000000,turns:1,models:[{model:'deepseek-v4-flash',tokens:1000000}]}]};
const sdk=`export const hana={ready(){},sessions:{getActive:async()=>({sessionPath:'probe.jsonl'}),onActiveChanged:()=>()=>{}},theme:{subscribe:()=>()=>{}},resources:{pick:async()=>({resources:[]})},external:{open:async()=>({opened:true})}};`;
const theme=`:root{--bg:#15181b;--bg-card:#252a30;--text:#e8ebee;--text-light:#d1d5da;--text-muted:#9ba4ad;--accent:#7d9cab;--green:#8aae91;--warn:#c98a35;--danger:#c76559;--font-ui:system-ui;--font-mono:monospace;--r-md:12px;--r-lg:16px;--si-glass-border:#8893a430;--si-glass-hi:#ffffff10;--si-glow:#54768820;--ease:ease;--fx-lens-lg:none;--fx-lens-sm:none}`;
const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}</style><link rel="stylesheet" href="/assets/panel-v2.css"><link rel="stylesheet" href="/assets/custom-pricing.css"></head><body data-surface="page"><div id="root" data-surface="page"></div><script type="module" src="/assets/panel-v2.js"></script></body></html>`;
const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://localhost'),p=u.pathname;
  const send=(type,body)=>{res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(body);};const json=data=>send('application/json',JSON.stringify(data));
  if(p==='/')return send('text/html; charset=utf-8',html);
  if(p.startsWith('/assets/')){const name=p.slice(8);if(!/^[a-zA-Z0-9._-]+$/.test(name)){res.writeHead(400);return res.end();}if(name==='sdk.js')return send('text/javascript',sdk);return send(name.endsWith('.css')?'text/css':'text/javascript',await fs.readFile(path.join(root,'ui/assets',name)));}
  const api=p.replace('/api/apps/session-insight/routes/api/','');
  if(api==='stats')return json(stats);
  if(api==='sessions')return json({sessions:[{name:'probe.jsonl',title:'隔离测试会话',model:'deepseek-v4-flash',mtime:new Date().toISOString(),turns:1,size:1}],count:1});
  if(api==='active')return json({file:'probe.jsonl'});
  if(api==='fx-config')return json({glass:false,glow:false});
  if(api==='panel-prefs')return json({homeView:'api'});
  if(api==='ledger-stats')return json({at:Date.now(),calls:1,errors:0,days:{[new Date().toLocaleDateString('sv-SE')]:{cost:2,tokens:1000000,calls:1}},providers:{deepseek:{tokens:1000000,cost:2,calls:1}},models:{},tokens:{input:1000000,output:0,cacheHit:0,cacheMiss:1000000,total:1000000,hitRate:0},timeBuckets:buckets,tokenBuckets:buckets,cacheRateBuckets:buckets,latency:{buckets:{}},subs:{},subsystems:{},coverage:{days:1},rangeProviders:{},rangeModels:{}});
  if(api==='balance')return json({balances:[{provider:'deepseek',name:'DeepSeek',status:'ok',kind:'balance',total:20,currency:'CNY',summary:'¥20.00'}],unsupported:[]});
  if(api==='providers')return json({providers:[{id:'deepseek',name:'DeepSeek',models:['deepseek-v4-flash'],view:'money'}]});
  if(api==='local-providers')return json({providers:[]});
  if(api==='pricing')return json({rows:[{provider:'deepseek',model:'deepseek-v4-flash',miss:2,hit:0.2,out:3,status:'listed',tier:'flat'}]});
  if(api==='total-cost')return json({totalCost:2,perProvider:{deepseek:2},todayCost:2});
  if(api==='hero-stats')return json({tokens:1000000,calls:1,totalCost:2});
  if(api==='events')return json({events:[]});
  if(api==='version')return json({version:'2.1.5'});
  if(api==='rules')return json({});
  return json({ok:true});
 }catch(e){res.writeHead(500,{'content-type':'text/plain'});res.end(e.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','D:/Google/Chrome/Application/chrome.exe','D:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
if(!chrome){server.close();throw Error('Chrome unavailable');}
const profile=path.join(tmp,'profile');
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let ws;const errors=[],results=[];
try{
 let port;for(let i=0;i<100;i++){try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await delay(100);}}
 if(!port)throw Error('Chrome failed');
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error('CDP timeout '+method)),10000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
 const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 const wait=async expression=>{const start=Date.now();while(!(await ev(expression))){if(Date.now()-start>15000)throw Error('UI timeout '+expression);await delay(100);}};
 await call('Runtime.enable');await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1000,height:950,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
 await wait(`document.querySelector('#costViz svg')&&document.querySelector('#api-overview').offsetWidth>0`);
 assert.equal(await ev(`document.querySelector('#costBrief h3').textContent.includes('详情')`),false);results.push('fee brief details badge removed');
 const paths=[];
 for(const unit of ['hour','d7','d30','day']){
  await ev(`document.querySelector('#costUnitSeg [data-v="${unit}"]').click()`);
  const pathData=await ev(`(()=>{const s=document.querySelector('#costViz svg');return {svg:!!s,paths:s?[...s.querySelectorAll('path')].map(p=>p.getAttribute('d')):[]}})()`);
  assert.equal(pathData.svg,true);assert.ok(pathData.paths.some(p=>p&&p.length>100));paths.push(JSON.stringify(pathData.paths));results.push(`${unit} cost line has data`);
  await ev(`document.querySelector('#costModeSeg [data-v="heat"]').click()`);
  assert.equal(await ev(`document.querySelectorAll('#costViz .heat i').length`),256);
  assert.ok(await ev(`!!document.querySelector('#costViz .heat i:not(.l0)')`));results.push(`${unit} cost heat has nonzero cells`);
  await ev(`document.querySelector('#costModeSeg [data-v="line"]').click()`);
 }
 assert.ok(new Set(paths).size>1);
 await ev(`document.querySelector('.tab[data-view="usage"]').click();document.querySelector('[data-page="usage-session"][class*="subtab"]').click()`);
 await wait(`document.querySelector('#sessionTriggerLabel').textContent.includes('隔离')`);
 for(const mode of ['dark','light']){
  for(const glass of ['off','on']){
   await ev(`document.documentElement.style.setProperty('--bg','${mode==='dark'?'#15181b':'#f8f4ed'}');document.documentElement.style.setProperty('--bg-card','${mode==='dark'?'#252a30':'#ffffff'}');document.body.dataset.fxGlass='${glass}';document.documentElement.style.setProperty('--fx-lens-lg','${glass==='on'?'blur(18px)':'none'}');document.querySelector('#sessionTrigger').click()`);
   await wait(`document.querySelector('#sessionMenu').classList.contains('open')`);await wait(`getComputedStyle(document.querySelector('#sessionMenu')).opacity==='1'`);
   const style=await ev(`(()=>{const m=document.querySelector('#sessionMenu'),s=getComputedStyle(m),r=m.getBoundingClientRect();return {parent:m.parentElement.tagName,bg:s.backgroundColor,image:s.backgroundImage,blur:s.backdropFilter,opacity:s.opacity,visible:r.width>0&&r.height>0}})()`);
   assert.equal(style.parent,'BODY');assert.equal(style.visible,true);assert.equal(style.opacity,'1');
   assert.ok(style.image.startsWith('linear-gradient('));
   if(glass==='off'){assert.notEqual(style.bg,'rgba(0, 0, 0, 0)');assert.ok(!style.bg.startsWith('rgba('));assert.equal(style.blur,'none');}
   else{assert.equal(style.bg,'rgba(0, 0, 0, 0)');assert.match(style.blur,/blur\(18px\)/);}
   results.push(`${mode} glass ${glass}: ${glass==='off'?'opaque fallback':'original translucent glass preserved'}`);
   if(mode==='dark'&&glass==='off'){const shot=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(tmp,'session-menu-dark.png'),Buffer.from(shot.data,'base64'));}
   await ev(`document.querySelector('#sessionTrigger').click()`);
  }
 }
 // Preserve the old idle cell; first two active levels remove grey, final two deepen.
 await ev(`(()=>{const scale=document.createElement('div');scale.id='heatPaletteProbe';scale.className='heat';scale.innerHTML=[0,1,2,3,4].map(i=>'<i class="l'+i+'" style="transition:none;animation:none"></i>').join('');document.body.append(scale);})()`);
 for(const mode of ['dark','light']){
  for(const accent of ['#7d9cab','#4c956c','#b8735b','#888888']){
   await ev(`document.body.dataset.colorMode='${mode}';document.documentElement.style.setProperty('--accent','${accent}')`);
   const samples=await ev(`(()=>{const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d',{willReadFrequently:true});return [...document.querySelectorAll('#heatPaletteProbe i')].map(el=>{g.clearRect(0,0,1,1);const color=getComputedStyle(el).backgroundColor;g.fillStyle=color;g.fillRect(0,0,1,1);const p=[...g.getImageData(0,0,1,1).data],v=p.slice(0,3).map(x=>{const s=x/255;return s<=.04045?s/12.92:Math.pow((s+.055)/1.055,2.4)});return {color,p,lum:.2126*v[0]+.7152*v[1]+.0722*v[2]}})})()`);
   assert.equal(new Set(samples.map(s=>s.p.join(','))).size,5);
   assert.ok(Math.abs(samples[0].p[3]-255*.08)<=1, 'idle cell keeps original 8% opacity');
   const original=await ev(`(()=>{const e=document.createElement('i');e.style.background='color-mix(in srgb,var(--accent) 8%,transparent)';document.body.append(e);const color=getComputedStyle(e).backgroundColor;e.remove();return color})()`);
   assert.equal(samples[0].color,original, 'idle color must exactly match original');
   let previousL=Infinity,previousC=-1;
   for(let i=1;i<samples.length;i++){
    assert.ok(samples[i].p[3]>samples[i-1].p[3], 'higher usage has greater color density');
    assert.ok(samples[i].color.startsWith('oklch('), samples[i].color);
    const parts=samples[i].color.slice(6).split(' ').filter(Boolean);
    const lightness=Number(parts[0]),chroma=Number(parts[1]);
    if(i===2) assert.ok(Math.abs(lightness-previousL)<1e-5, 'first two active levels remove grey without deepening');
    else assert.ok(lightness<previousL, 'only later active levels deepen');
    assert.ok(chroma>=previousC-1e-6, 'higher levels reduce greyness');previousL=lightness;previousC=chroma;
   }
   results.push(`${mode} ${accent}: original idle cell; remove grey first, deepen only high levels`);
  }
 }
 await ev(`document.getElementById('heatPaletteProbe').remove()`);
 assert.deepEqual(errors,[]);results.push('no browser runtime exceptions');console.log(JSON.stringify({ok:true,passed:results.length,results,tempDir:tmp},null,2));
}finally{ws?.close();child.kill();await new Promise(r=>server.close(r));await delay(500);await fs.rm(profile,{recursive:true,force:true}).catch(()=>{});}
