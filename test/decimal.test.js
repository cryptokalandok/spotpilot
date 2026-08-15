import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPercent,
  compareDecimals,
  multiplyDecimals,
} from '../src/index.js';

test('decimal comparison does not use floating point', () => {
  assert.equal(compareDecimals('10.00000000', '10'), 0);
  assert.equal(compareDecimals('0.300000000000000001', '0.3'), 1);
  assert.equal(compareDecimals('9.99', '10'), -1);
});

test('decimal multiplication stays exact', () => {
  assert.equal(multiplyDecimals('10', '0.28'), '2.8');
  assert.equal(multiplyDecimals('0.1', '0.2'), '0.02');
});

test('percentage price uses the ticker precision and half-up rounding', () => {
  assert.equal(applyPercent('0.28000000', '10'), '0.30800000');
  assert.equal(applyPercent('0.28', '10'), '0.31');
  assert.equal(applyPercent('100', '-10'), '90');
  assert.throws(() => applyPercent('1', '-100'));
});
