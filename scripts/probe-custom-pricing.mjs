// Isolated headless UI regression: no production host, credentials, or browser profile.
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createCustomPricingStore } from '../lib/custom-pricing-store.js';
import { registerCustomPricingRoutes } from '../lib/custom-pricing-api.js';
import { calcCost } from '../lib/usage-parser.js';
import { createSubscriptionsStore } from '../lib/subscriptions-store.js';
import { createSubscriptionsService, registerSubscriptionsRoutes } from '../lib/subscriptions-service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(r => setTimeout(r, ms));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'si-custom-ui-'));
const store = createCustomPricingStore({ filePath: path.join(tmp, 'prices.json') });
const routes = new Map();
registerCustomPricingRoutes({ get(p, h) { routes.set('GET ' + p, h); }, post(p, h) { routes.set('POST ' + p, h); } }, { store });
const subStore = createSubscriptionsStore({ filePath: path.join(tmp, 'subscriptions.json') });
const expiry = new Date(Date.now() + 20 * 86400000); expiry.setUTCSeconds(7, 0);
const subService = createSubscriptionsService({ store: subStore, getConfig: async () => ({ volcengineAccessKey: 'mock-ak', volcengineSecretKey: 'mock-sk' }), sdk: { providers: { getCredentials: async () => ({ baseUrl: 'https://ark.cn-beijing.volces.com/api/coding' }) }, network: {} }, query: async () => ({ ok: true, subscriptions: [{ externalId: 'probe-instance', planName: 'Coding Plan', planKind: 'coding', scope: 'personal', validFrom: null, validTo: expiry.toISOString(), amount: null }] }) });
registerSubscriptionsRoutes({ get(p,h){routes.set('GET '+p,h);},post(p,h){routes.set('POST '+p,h);} }, subService);
const SDK = `export const hana={ready(){},external:{async open(v){window.__opened=v.url;return {opened:true}}},clipboard:{async writeText(v){window.__copied=v.text;return {written:true}}},resources:{async pick(){return {resources:[]}}}};`;
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/custom-pricing.css"><style>:root{--text:#e8e8e8;--text-muted:#9da4ab;--bg:#17191b;--bg-card:#202327;--border:#42474c;--accent:#63899c}body{margin:0;background:var(--bg);padding:16px}*{box-sizing:border-box}</style></head><body><div id="manager"></div><script type="module">import{mountPricingManager}from'/assets/custom-pricing.js';mountPricingManager(document.getElementById('manager'))</script></body></html>`;
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    const json = v => send(200, 'application/json', JSON.stringify(v));
    if (u.pathname === '/') return send(200, 'text/html; charset=utf-8', html);
    if (u.pathname === '/subscriptions-probe') return send(200, 'text/html; charset=utf-8', html.replace('mountPricingManager', 'mountSubscriptionsManager').replace("from'/assets/custom-pricing.js'", "from'/assets/subscriptions.js'").replace('mountPricingManager(document', 'mountSubscriptionsManager(document').replace('</head>', '<link rel="stylesheet" href="/assets/subscriptions.css"></head>'));
    if (u.pathname === '/reload-probe') return send(200, 'text/html; charset=utf-8', `<!doctype html><html><body><button id="wReload" type="button">实时</button><script type="module">import{bindWidgetReload}from'/assets/widget-refresh.js';const n=Number(sessionStorage.getItem('reload-probe')||0)+1;sessionStorage.setItem('reload-probe',String(n));bindWidgetReload(document.getElementById('wReload'));document.body.dataset.boot=String(n);</script></body></html>`);
    if (u.pathname.startsWith('/assets/')) {
      const name = u.pathname.slice('/assets/'.length);
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) return send(400, 'text/plain', 'bad path');
      if (name === 'sdk.js') return send(200, 'text/javascript', SDK);
      return send(200, name.endsWith('.css') ? 'text/css' : 'text/javascript', await fs.readFile(path.join(root, 'ui/assets', name)));
    }
    const p = u.pathname.replace('/api/apps/session-insight/routes', '');
    if (p === '/api/providers') return json({ providers: [{ id: 'relay', name: '测试中转', models: ['vendor/test@2026'] }, { id: 'volcengine-coding', name: '火山 Coding', billingType: 'subscription', billing: 'subscription', view: 'quota', models: ['doubao'] }] });
    if (p === '/api/pricing') return json({ rows: [] });
    const h = routes.get(req.method + ' ' + p);
    if (!h) return send(404, 'text/plain', 'not found');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const result = await h({ req: { json: async () => JSON.parse(raw) }, json: (body, status = 200) => ({ body, status }) });
    send(result.status, 'application/json', JSON.stringify(result.body));
  } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'D:/Google/Chrome/Application/chrome.exe', 'D:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
if (!chrome) { server.close(); throw new Error('Headless Chrome unavailable'); }
const profile = path.join(tmp, 'profile');
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let ws; const errors = [], results = [];
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await delay(100); } }
  if (!port) throw new Error('Chrome did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout: ' + method)); }, 10000); pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async expression => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
  const wait = async expression => { const start = Date.now(); while (!(await ev(expression))) { if (Date.now() - start > 8000) throw new Error('UI condition timed out: ' + expression); await delay(80); } };
  const click = text => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent===${JSON.stringify(text)});if(!b)throw Error('Missing button '+${JSON.stringify(text)});b.click();return true})()`);
  const fill = (name, value) => ev(`(()=>{const i=document.querySelector('dialog:last-of-type [name="${name}"]');i.value=${JSON.stringify(String(value))};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 900, height: 850, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: base });
  await wait(`document.querySelector('.cp-manager .cp-status')?.textContent.includes('0 条')`);
  results.push('manager boot');
  await click('添加自定义计费'); await wait(`document.querySelector('dialog form')`);
  assert.equal(await ev(`document.querySelectorAll('datalist,input[list]').length`), 0);
  await ev(`document.querySelector('[name="providerId"]').focus();document.querySelector('[name="providerId"]').click()`);
  await wait(`document.querySelector('[name="providerId"]').getAttribute('aria-expanded')==='true'`);
  assert.equal(await ev(`document.querySelector('.cp-suggestions:not([hidden])').textContent.includes('测试中转')`), true);
  for (const mode of ['dark', 'light']) {
    await ev(`document.documentElement.style.setProperty('--text',${JSON.stringify(mode === 'dark' ? '#e8e8e8' : '#30343b')});document.documentElement.style.setProperty('--bg-card',${JSON.stringify(mode === 'dark' ? '#202327' : '#f5f5f5')})`);
    for (const width of [320, 500, 900]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
      await ev(`window.dispatchEvent(new Event('resize'))`);
      const bounds = await ev(`(()=>{const m=document.querySelector('.cp-suggestions:not([hidden])'),r=m.getBoundingClientRect();return {inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,overflow:m.scrollWidth>m.clientWidth+1,bg:getComputedStyle(m).backgroundColor,fg:getComputedStyle(m).color}})()`);
      assert.equal(bounds.inside, true); assert.equal(bounds.overflow, false); assert.notEqual(bounds.bg, bounds.fg);
      results.push(`${mode} ${width}px themed suggestions in viewport`);
    }
  }
  const menuShot = await call('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(tmp, 'custom-pricing-suggestions.png'), Buffer.from(menuShot.data, 'base64'));
  await ev(`document.querySelector('[name="providerId"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  assert.equal(await ev(`document.querySelector('dialog').open&&!document.querySelector('.cp-suggestions:not([hidden])')`), true);
  await fill('providerId', 'unknown-local');
  assert.equal(await ev(`document.querySelector('.cp-suggestions:not([hidden])').textContent.includes('可直接输入自定义 ID')`), true);
  await fill('providerId', 'relay');
  await ev(`const p=document.querySelector('[name="providerId"]');p.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));p.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`);
  assert.equal(await ev(`document.querySelector('[name="providerName"]').value`), '测试中转');
  await ev(`document.querySelector('[name="modelId"]').focus();document.querySelector('[name="modelId"]').click();document.querySelector('.cp-suggestions:not([hidden]) [role="option"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}));`);
  assert.equal(await ev(`document.querySelector('[name="modelId"]').value`), 'vendor/test@2026');
  results.push('combobox keyboard, Escape, free text, linked models and pointer selection');
  for (const [name, value] of Object.entries({ providerId: 'relay', modelId: 'vendor/test@2026', providerName: '测试中转', inputMiss: 0, inputHit: 1, output: 2, sourceUrl: 'https://example.com/pricing?private=do-not-publish' })) await fill(name, value);
  await ev(`document.querySelector('dialog form').requestSubmit()`);
  await wait(`!document.querySelector('dialog')&&document.querySelector('.cp-list')?.textContent.includes('vendor/test@2026')`);
  assert.equal(calcCost(1e6, 1e6, 1e6, 0, 'vendor/test@2026', Date.now(), 'relay', 0), 3);
  results.push('zero price + slash model saved and actual calcCost=3');
  await click('停用'); await wait(`document.querySelector('.cp-list').textContent.includes('已停用')`);
  assert.equal(calcCost(1e6, 0, 0, 0, 'vendor/test@2026', Date.now(), 'relay'), null);
  await click('启用'); await wait(`document.querySelector('.cp-list').textContent.includes('已启用')`); results.push('disable / enable');
  await click('编辑'); await wait(`document.querySelector('dialog form')`);
  assert.equal(await ev(`document.querySelector('[name="modelId"]').readOnly`), true);
  await fill('output', 4);
  await click('预览计费 Issue'); await wait(`document.querySelectorAll('dialog').length===2`);
  assert.equal(await ev(`document.querySelector('dialog:last-of-type .cp-actions .cp-primary').disabled`), true);
  assert.equal(await ev(`document.querySelector('dialog:last-of-type textarea').value.includes('do-not-publish')`), false);
  await ev(`document.querySelector('dialog:last-of-type input[type=checkbox]').click()`);
  await click('前往 GitHub 提交 Issue'); await wait(`Boolean(window.__opened)`);
  assert.ok((await ev('window.__opened')).startsWith('https://github.com/youyongdemao/HanaAgent-session-insight/issues/new?'));
  results.push('public preview + consent + external shim, URL query removed');
  await ev(`document.querySelector('dialog:last-of-type').close()`);
  await ev(`document.querySelector('dialog form').requestSubmit()`); await wait(`!document.querySelector('dialog')`);
  assert.equal(calcCost(0, 0, 1e6, 0, 'vendor/test@2026', Date.now(), 'relay'), 4); results.push('edit changes actual calculation');
  await click('编辑'); await wait(`document.querySelector('dialog form')`);
  const snap = await store.snapshot(); const entry = { ...snap.entries[0], providerName: '另一窗口' };
  await fetch(base + '/api/apps/session-insight/routes/api/custom-pricing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry, expectedRevision: snap.revision }) });
  await ev(`document.querySelector('dialog form').requestSubmit()`);
  await wait(`document.querySelector('dialog .cp-status').textContent.includes('另一窗口')`);
  results.push('CAS conflict visible, no false success');
  await ev(`document.querySelector('dialog').close()`); await click('刷新'); await wait(`document.querySelector('.cp-list').textContent.includes('另一窗口')`);
  await click('编辑'); await wait(`document.querySelector('dialog form')`);
  for (const mode of ['dark', 'light']) {
    await ev(`document.documentElement.style.setProperty('--text',${JSON.stringify(mode === 'dark' ? '#e8e8e8' : '#30343b')});document.documentElement.style.setProperty('--bg-card',${JSON.stringify(mode === 'dark' ? '#202327' : '#f5f5f5')})`);
    for (const width of [320, 500, 900]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
      const overflow = await ev(`(()=>{const d=document.querySelector('dialog');return {body:document.documentElement.scrollWidth>innerWidth+1,dialog:d.scrollWidth>d.clientWidth+1}})()`);
      assert.deepEqual(overflow, { body: false, dialog: false }, `${mode} ${width}px horizontal overflow`);
      results.push(`${mode} ${width}px layout`);
    }
  }
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(tmp, 'custom-pricing-editor.png'); await fs.writeFile(shotPath, Buffer.from(shot.data, 'base64'));
  await ev(`document.querySelector('dialog').close()`);
  await click('删除'); assert.equal((await store.list()).length, 1); await click('确认删除');
  await wait(`document.querySelector('.cp-list').textContent.includes('还没有')`); assert.equal((await store.list()).length, 0); results.push('explicit delete confirmation');
  await call('Page.navigate', { url: base + '/reload-probe' });
  await wait(`document.body?.dataset.boot==='1'`);
  await ev(`document.getElementById('wReload').click()`);
  await wait(`document.body?.dataset.boot==='2'`);
  assert.equal(await ev(`document.getElementById('wReload').textContent`), '实时');
  results.push('status button performs actual browser page reload and recovers');
  await call('Page.navigate', { url: base + '/subscriptions-probe' });
  await wait(`document.querySelector('.sc-manager .cp-status')?.textContent.includes('条套餐')`);
  await click('同步到期（只读）'); await click('开始只读查询');
  await wait(`document.querySelector('dialog .cp-status')?.textContent.includes('查询完成')`);
  await ev(`document.querySelector('dialog').close()`);
  await wait(`document.querySelector('.sc-list')?.textContent.includes('Coding Plan')`);
  assert.equal((await subStore.snapshot()).entries[0].amount, null);
  results.push('official expiry sync creates incomplete non-billed record');
  await click('编辑'); await wait(`document.querySelector('dialog form')`);
  assert.equal(await ev(`document.querySelector('[name="validTo"]').readOnly`), true);
  await ev(`(()=>{const d=new Date(Date.now()-10*86400000),pad=x=>String(x).padStart(2,'0');const el=document.querySelector('[name="validFrom"]');el.value=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await fill('amount', 90);
  for (const mode of ['dark', 'light']) {
    await ev(`document.documentElement.style.setProperty('--text','${mode === 'dark' ? '#e8e8e8' : '#30343b'}');document.documentElement.style.setProperty('--bg-card','${mode === 'dark' ? '#202327' : '#f5f5f5'}')`);
    for (const width of [320, 500, 900]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: false });
      assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth+1`), true);
      results.push(`${mode} ${width}px subscription editor layout`);
    }
  }
  await ev(`document.querySelector('dialog form').requestSubmit()`); await wait(`!document.querySelector('dialog')`);
  const subData = await subService.snapshot(); assert.equal(subData.entries[0].amount, 90); assert.equal(subData.entries[0].validTo, expiry.toISOString()); assert.ok(subData.summary.costCny > 0);
  results.push('fill missing subscription data preserves official seconds and accrues cost');
  await click('编辑'); await wait(`document.querySelector('dialog form')`);
  assert.equal(await ev(`document.querySelector('[name="validFrom"]').readOnly`), false);
  await ev(`document.querySelector('dialog').close()`);
  assert.deepEqual(errors, []); results.push('no browser runtime errors');
  console.log(JSON.stringify({ ok: true, passed: results.length, results, screenshot: shotPath, tempDir: tmp }, null, 2));
} finally {
  ws?.close();
  child.kill();
  await new Promise(r => server.close(r));
  // Keep only the screenshot for inspection; cleanup this test's own profile/data.
  await delay(500);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(tmp, 'prices.json'), { force: true }).catch(() => {});
}
