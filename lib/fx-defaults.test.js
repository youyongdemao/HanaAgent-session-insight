import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Test the real parser without running the App's defineApp startup.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const block = index.match(/const FX_DEFAULTS = \{[^;]+\};\s*function parseFx\(raw\) \{[\s\S]*?return out;\s*\}/);
assert.ok(block, 'actual parseFx function must be present');
const { parseFx } = new Function(block[0] + ';return {parseFx};')();

test('缺省、损坏或空配置时，毛玻璃与光晕都开启', () => {
  for (const value of [undefined, null, '', '{bad', {}, 'null']) assert.deepEqual(parseFx(value), { glass: true, glow: true });
});
test('显式关闭不被新默认值覆盖，部分配置只补缺项', () => {
  assert.deepEqual(parseFx({ glass: false }), { glass: false, glow: true });
  assert.deepEqual(parseFx({ glow: false }), { glass: true, glow: false });
  assert.deepEqual(parseFx('{"glass":false,"glow":false}'), { glass: false, glow: false });
});
test('非法布尔值不当成关闭', () => {
  assert.deepEqual(parseFx({ glass: 'false', glow: 0 }), { glass: true, glow: true });
});
test('设置页与面板默认值及设置回读都与后端一致', () => {
  const settings = readFileSync(new URL('../ui/assets/settings.js', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../ui/assets/panel-v2.js', import.meta.url), 'utf8');
  assert.ok(settings.includes('let fxState = { glass: true, glow: true };'));
  assert.ok(settings.includes('glass: fx?.glass !== false'));
  assert.ok(settings.includes('glass: back?.glass !== false'));
  assert.ok(panel.includes('const FX={glass:true,glow:true}'));
});
