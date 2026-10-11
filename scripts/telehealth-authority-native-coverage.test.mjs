import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_NATIVE_AUTHORITY_SCENARIOS, completeNativeAuthorityCoverage } from './telehealth-authority-native-coverage.mjs';
const complete = () => REQUIRED_NATIVE_AUTHORITY_SCENARIOS.map(id => ({ id, passed: true }));

test('the expanded source diagnostic has 28 distinct mandatory cases', () => {
  assert.equal(REQUIRED_NATIVE_AUTHORITY_SCENARIOS.length, 28);
  assert.equal(new Set(REQUIRED_NATIVE_AUTHORITY_SCENARIOS).size, 28);
  assert.equal(completeNativeAuthorityCoverage(complete()), true);
});
test('missing or empty evidence cannot pass', () => {
  assert.equal(completeNativeAuthorityCoverage(complete().slice(1)), false);
  assert.equal(completeNativeAuthorityCoverage([]), false);
  assert.equal(completeNativeAuthorityCoverage(null), false);
});
test('a duplicate cannot substitute for a mandatory case', () => {
  const result = complete(); result[1] = result[0];
  assert.equal(completeNativeAuthorityCoverage(result), false);
});
test('extra and unknown cases cannot substitute for exact coverage', () => {
  assert.equal(completeNativeAuthorityCoverage([...complete(), { id: 'extra', passed: true }]), false);
  const result = complete(); result[0] = { id: 'unknown', passed: true };
  assert.equal(completeNativeAuthorityCoverage(result), false);
});
test('failed, unobserved and nonboolean verdicts cannot pass', () => {
  for (const passed of [false, undefined, null, 'true', 1]) {
    const result = complete(); result[0] = { ...result[0], passed };
    assert.equal(completeNativeAuthorityCoverage(result), false);
  }
});
