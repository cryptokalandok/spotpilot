import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  SafeTradeApiError,
  SafeTradeClient,
  SafeTradeConfigError,
  SafeTradeValidationError,
  createSignature,
} from '../src/index.js';

const FIXED_TIME = 1_700_000_000_000;

test('createSignature implements HMAC-SHA256(secret, nonce + apiKey)', () => {
  const expected = createHmac('sha256', 'secret')
    .update(`${FIXED_TIME}key`)
    .digest('hex');

  assert.equal(
    createSignature({
      nonce: String(FIXED_TIME),
      apiKey: 'key',
      apiSecret: 'secret',
    }),
    expected,
  );
});

test('getPrice calls the public ticker endpoint and extracts last price', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse({
    at: FIXED_TIME,
    ticker: { last: '0.28000000', buy: '0.27', sell: '0.29' },
  }));

  const result = await client.getPrice('BTC-USDT');

  assert.equal(calls[0].url, 'https://safe.trade/api/v2/trade/public/tickers/btcusdt');
  assert.equal(calls[0].options.headers['X-Auth-Apikey'], undefined);
  assert.equal(result.market, 'btcusdt');
  assert.equal(result.price, '0.28000000');
});

test('getAssetStatuses normalizes multiple SafeTrade currencies', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse({
    data: [
      {
        id: 'pearl',
        deposit_enabled: false,
        withdrawal_enabled: true,
        networks: [{
          code: 'pearl',
          deposit_enabled: false,
          withdrawal_enabled: true,
        }],
      },
      { code: 'USDT', can_deposit: true, can_withdraw: true },
    ],
  }));

  const result = await client.getAssetStatuses('PEARL,USDT');

  assert.equal(
    calls[0].url,
    'https://safe.trade/api/v2/trade/public/currencies',
  );
  assert.equal(
    calls.some(({ options }) => options.headers['X-Auth-Apikey'] !== undefined),
    false,
  );
  assert.equal(result[0].asset, 'PEARL');
  assert.equal(result[0].depositEnabled, false);
  assert.equal(result[0].withdrawalEnabled, true);
  assert.equal(result[0].networks[0].network, 'pearl');
  assert.equal(result[1].depositEnabled, true);
});

test('getBalances authenticates, normalizes and filters balances', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse([
    { currency: 'quai', balance: '10.5', locked: '1.25' },
    { currency: 'rvn', balance: '22', locked: '0' },
    { currency: 'btc', balance: '0.1', locked: '0' },
  ]));

  const result = await client.getBalances({ coins: 'QUAI,RVN' });
  const headers = calls[0].options.headers;

  assert.equal(calls[0].url, 'https://safe.trade/api/v2/trade/account/balances/spot');
  assert.equal(headers['X-Auth-Apikey'], 'key');
  assert.equal(headers['Content-Type'], 'application/json;charset=utf-8');
  assert.equal(headers['X-Auth-Nonce'], String(FIXED_TIME));
  assert.equal(
    headers['X-Auth-Signature'],
    createSignature({
      nonce: String(FIXED_TIME),
      apiKey: 'key',
      apiSecret: 'secret',
    }),
  );
  assert.deepEqual(
    result.map(({ asset, total, available, locked }) => ({
      asset,
      total,
      available,
      locked,
    })),
    [
      { asset: 'QUAI', total: '11.75', available: '10.5', locked: '1.25' },
      { asset: 'RVN', total: '22', available: '22', locked: '0' },
    ],
  );
});

test('createOrder sends a market sell without price', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse({ id: 123 }, 201));

  const order = await client.createOrder({
    pair: 'BTC-USDT',
    side: 'sell',
    type: 'market',
    amount: 10,
  });

  assert.equal(order.id, 123);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    market: 'btcusdt',
    side: 'sell',
    amount: '10',
    type: 'market',
  });
});

test('createOrder sends a normalized decimal price for a limit order', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse({ id: 124 }, 201));

  await client.createOrder({
    pair: 'BTC/USDT',
    side: 'SELL',
    type: 'LIMIT',
    amount: '10.0',
    price: '0,28',
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    market: 'btcusdt',
    side: 'sell',
    amount: '10.0',
    type: 'limit',
    price: '0.28',
  });
});

test('private calls require API credentials', async () => {
  const client = new SafeTradeClient({
    fetchImpl: () => {
      throw new Error('fetch should not be called');
    },
  });

  await assert.rejects(
    client.getBalances(),
    SafeTradeConfigError,
  );
});

test('market order rejects price and limit order requires it', async () => {
  const client = createClient([], () => jsonResponse({}));

  await assert.rejects(
    client.createOrder({
      pair: 'BTC-USDT',
      side: 'sell',
      type: 'market',
      amount: '10',
      price: '0.28',
    }),
    SafeTradeValidationError,
  );

  await assert.rejects(
    client.createOrder({
      pair: 'BTC-USDT',
      side: 'sell',
      type: 'limit',
      amount: '10',
    }),
    SafeTradeValidationError,
  );
});

test('API failures preserve status and parsed response', async () => {
  const client = createClient([], () => jsonResponse({ error: 'insufficient balance' }, 422));

  await assert.rejects(
    client.createOrder({
      pair: 'BTC-USDT',
      side: 'sell',
      type: 'market',
      amount: '1000',
    }),
    (error) => {
      assert.ok(error instanceof SafeTradeApiError);
      assert.equal(error.status, 422);
      assert.equal(error.response.error, 'insufficient balance');
      return true;
    },
  );
});

test('Cloudflare HTML block is converted to a concise structured error', async () => {
  const client = createClient([], () => new Response(
    '<!DOCTYPE html><title>Attention Required! | Cloudflare</title>',
    {
      status: 403,
      headers: {
        'Content-Type': 'text/html',
        'CF-Ray': 'test-ray-id',
      },
    },
  ));

  await assert.rejects(
    client.getPrice('BTC-USDT'),
    (error) => {
      assert.ok(error instanceof SafeTradeApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'CLOUDFLARE_BLOCKED');
      assert.equal(error.rayId, 'test-ray-id');
      assert.doesNotMatch(error.message, /<!DOCTYPE html>/);
      return true;
    },
  );
});

test('nonces remain strictly increasing when requests share a millisecond', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse([]));

  await client.getBalances();
  await client.getBalances();

  assert.deepEqual(
    calls.map(({ options }) => options.headers['X-Auth-Nonce']),
    [String(FIXED_TIME), String(FIXED_TIME + 1)],
  );
});

function createClient(calls, responder) {
  return new SafeTradeClient({
    apiKey: 'key',
    apiSecret: 'secret',
    now: () => FIXED_TIME,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return responder(url, options);
    },
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
