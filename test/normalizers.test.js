import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractLastPrice,
  normalizeMarket,
  normalizePositiveDecimal,
} from '../src/index.js';

test('normalizeMarket accepts common pair separators', () => {
  assert.equal(normalizeMarket('BTC-USDT'), 'btcusdt');
  assert.equal(normalizeMarket('BTC/USDT'), 'btcusdt');
  assert.equal(normalizeMarket('btc_usdt'), 'btcusdt');
  assert.equal(normalizeMarket('btcusdt'), 'btcusdt');
});

test('normalizePositiveDecimal accepts a decimal comma without using Number', () => {
  assert.equal(normalizePositiveDecimal('0,28000000', 'price'), '0.28000000');
  assert.throws(() => normalizePositiveDecimal('0', 'amount'));
  assert.throws(() => normalizePositiveDecimal('-1', 'amount'));
  assert.throws(() => normalizePositiveDecimal('1e-8', 'amount'));
});

test('extractLastPrice handles common ticker response shapes', () => {
  assert.equal(extractLastPrice({ ticker: { last: '0.28' } }), '0.28');
  assert.equal(extractLastPrice({ last: '0.29' }), '0.29');
  assert.equal(extractLastPrice({ data: { last: '0.30' } }), '0.30');
});
