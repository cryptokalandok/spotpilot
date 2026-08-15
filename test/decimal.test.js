import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPercent,
  compareDecimals,
  divideDecimals,
  multiplyDecimals,
  percentageOf,
  subtractDecimals,
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

test('decimal subtraction stays exact', () => {
  assert.equal(subtractDecimals('100', '0.5'), '99.5');
  assert.equal(subtractDecimals('1.25', '2'), '-0.75');
});

test('decimal division rounds down to the requested precision', () => {
  assert.equal(divideDecimals('99.5', '20', 8), '4.975');
  assert.equal(divideDecimals('10', '3', 4), '3.3333');
  assert.equal(divideDecimals('0.1', '2', 8), '0.05');
});

test('balance percentages round down to the asset precision', () => {
  assert.equal(percentageOf('12.34567891', '100', 8), '12.34567891');
  assert.equal(percentageOf('10', '33.33', 2), '3.33');
});

test('percentage price uses the ticker precision and half-up rounding', () => {
  assert.equal(applyPercent('0.28000000', '10'), '0.30800000');
  assert.equal(applyPercent('0.28', '10'), '0.31');
  assert.equal(applyPercent('100', '-10'), '90');
  assert.throws(() => applyPercent('1', '-100'));
});
