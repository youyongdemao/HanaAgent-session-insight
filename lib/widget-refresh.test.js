import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bindWidgetReload } from '../ui/assets/widget-refresh.js';

function harness(reload = () => {}) {
  const button = new EventTarget(); const attrs = new Map(), classes = new Set();
  button.disabled = false; button.textContent = '实时';
  button.setAttribute = (key, value) => attrs.set(key, value);
  button.classList = { add: (...names) => names.forEach(x => classes.add(x)), remove: (...names) => names.forEach(x => classes.delete(x)) };
  const timers = new Map(), paints = []; let serial = 0;
  const ctl = bindWidgetReload(button, { reload, paint: fn => paints.push(fn), later: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; }, cancel: id => timers.delete(id) });
  const click = () => button.dispatchEvent(new Event('click'));
  const advance = ms => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } };
  return { button, ctl, click, advance, paints, classes, attrs };
}

test('状态灯点击反馈、禁用与防重复 reload', () => {
  let calls = 0; const h = harness(() => calls++);
  h.click(); h.click();
  assert.equal(h.button.textContent, '刷新中'); assert.equal(h.button.disabled, true); assert.equal(h.ctl.ownsStatus, true);
  h.paints[0](); h.advance(160); assert.equal(calls, 1); h.ctl.dispose();
});
test('reload 抛错时显示失败，允许重试', () => {
  let calls = 0; const h = harness(() => { calls++; throw new Error('blocked'); });
  h.click(); h.paints[0]();
  assert.equal(h.button.textContent, '刷新失败'); assert.equal(h.button.disabled, false); assert.match(h.button.title, /blocked/);
  h.click(); h.paints[1](); assert.equal(calls, 2); h.ctl.dispose();
});
test('页面未导航成功不报告已刷新', () => {
  const h = harness(); h.click(); h.paints[0](); h.advance(8000);
  assert.equal(h.button.textContent, '刷新失败'); assert.equal(h.button.disabled, false); assert.equal(h.ctl.ownsStatus, true); h.ctl.dispose();
});
test('动画帧挂起仍有一次性 reload 兜底，卸载后不触发', () => {
  let calls = 0; const h = harness(() => calls++);
  h.click(); h.advance(160); h.paints[0](); assert.equal(calls, 1); h.ctl.dispose();
  h.click(); assert.equal(calls, 1);
});
test('真实 widget 绑定按钮，副标题只保留轮数，缺价说明仍可在费用提示查看', () => {
  const source = fs.readFileSync(new URL('../ui/assets/panel-v2.js', import.meta.url), 'utf8');
  assert.ok(source.includes('id="wReload"'));
  assert.ok(source.includes("bindWidgetReload(document.getElementById('wReload'))"));
  assert.ok(source.includes('if(m)m.textContent=st.turns!=null?`第 ${st.turns} 轮`:"";'));
  assert.ok(!source.includes('轮缺少价格，费用未计全'));
  assert.ok(source.includes('widgetReloadController?.ownsStatus'));
});
