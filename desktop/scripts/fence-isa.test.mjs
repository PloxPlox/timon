import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARCH_CFLAGS, assertBaselineIsa } from '../../native/timon-fence/build.mjs';

test('the x64 launcher is compiled for the x86-64 baseline, never the build machine default', () => {
  assert.deepEqual(ARCH_CFLAGS.x64, ['-march=x86-64', '-mtune=generic']);
});

test('an x64 launcher that needs more than the baseline is refused', () => {
  const v3 = () => 'x86-64-baseline, x86-64-v2, x86-64-v3';
  assert.throws(() => assertBaselineIsa('/out/timon-fence', 'x64', v3), /requires x86-64-baseline, x86-64-v2, x86-64-v3/);
});

test('a baseline launcher, one without the note, or another architecture passes', () => {
  assert.doesNotThrow(() => assertBaselineIsa('/out/timon-fence', 'x64', () => 'x86-64-baseline'));
  assert.doesNotThrow(() => assertBaselineIsa('/out/timon-fence', 'x64', () => null));
  assert.doesNotThrow(() => assertBaselineIsa('/out/timon-fence', 'arm64', () => { throw new Error('never read'); }));
});
