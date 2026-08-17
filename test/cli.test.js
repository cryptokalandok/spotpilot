import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from '../src/cli.js';

test('no command prints help instead of doing nothing', async () => {
  const result = await runWithClient([], {});
  assert.equal(result.code, 0);
  assert.match(result.output, /SpotPilot 0\.8\.0/);
  assert.match(result.output, /node spotpilot price/);
});

test('--exchange coinex selects the CoinEx client', async () => {
  const factoryCalls = [];
  const stdout = [];
  const stderr = [];
  const code = await runCli(
    ['price', '--exchange', 'coinex', '--pair', 'BTC-USDT'],
    {
      clientFactory: (options) => {
        factoryCalls.push(options);
        return {
          exchange: 'coinex',
          displayName: 'CoinEx',
          getPrice: async () => ({ price: '0.30' }),
        };
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      setDnsResultOrder: () => {},
      env: {},
      cwd: '/directory-that-does-not-exist',
    },
  );

  assert.equal(code, 0);
  assert.equal(factoryCalls[0].exchange, 'coinex');
  assert.match(stdout.join('\n'), /\[CoinEx\].*0\.30 USDT/);
  assert.deepEqual(stderr, []);
});

test('CLI prefers IPv4 by default for every exchange', async () => {
  const dnsOrders = [];
  const result = await runWithClient(
    ['price', '--exchange', 'coinex', '--pair', 'BTC-USDT'],
    { getPrice: async () => ({ price: '60000' }) },
    { setDnsResultOrder: (value) => dnsOrders.push(value) },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(dnsOrders, ['ipv4first']);
});

test('CLI DNS result order can be overridden from the environment', async () => {
  const dnsOrders = [];
  const result = await runWithClient(
    ['price', '--pair', 'BTC-USDT'],
    { getPrice: async () => ({ price: '60000' }) },
    {
      env: { SPOTPILOT_DNS_RESULT_ORDER: 'verbatim' },
      setDnsResultOrder: (value) => dnsOrders.push(value),
    },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(dnsOrders, ['verbatim']);
});

test('price prints a human-readable last traded price', async () => {
  const result = await runWithClient(
    ['price', '--pair', 'BTC-USDT'],
    { getPrice: async () => ({ price: '60000' }) },
  );
  assert.equal(result.code, 0);
  assert.match(result.output, /1 BTC = 60000 USDT/);
});

test('commands require an explicit pair or coin selector', async () => {
  const price = await runWithClient(['price'], {});
  const status = await runWithClient(['status'], {});
  const balance = await runWithClient(['balance'], {});

  assert.match(price.error, /--pair is required/);
  assert.match(status.error, /--coin is required/);
  assert.match(balance.error, /--coin is required/);
});

test('status accepts comma-separated assets and prints an aligned table', async () => {
  const result = await runWithClient(
    ['status', '--coin', 'PEARL,USDT'],
    {
      displayName: 'CoinEx',
      getAssetStatuses: async () => ([
        {
          asset: 'PEARL',
          depositEnabled: false,
          withdrawalEnabled: true,
          networks: [{
            network: 'PEARL',
            depositEnabled: false,
            withdrawalEnabled: true,
          }],
        },
        {
          asset: 'USDT',
          depositEnabled: true,
          withdrawalEnabled: true,
          networks: [],
        },
      ]),
    },
  );

  assert.equal(result.code, 0);
  assert.match(result.output, /ASSET  NETWORK  DEPOSIT   WITHDRAWAL/);
  assert.match(result.output, /PEARL  ALL      DISABLED  ENABLED/);
  assert.match(result.output, /PEARL  PEARL    DISABLED  ENABLED/);
  assert.match(result.output, /USDT   ALL      ENABLED   ENABLED/);
  assert.doesNotMatch(result.output, /\t/);
});

test('balance prints requested assets including a missing zero balance', async () => {
  const result = await runWithClient(
    ['balance', '--coin', 'QUAI,RVN'],
    {
      getBalances: async () => [{
        asset: 'QUAI', total: '282.85705135', available: '282.85705135', locked: '0',
      }],
    },
  );
  assert.equal(result.code, 0);
  assert.match(result.output, /ASSET  TOTAL         AVAILABLE     LOCKED/);
  assert.match(result.output, /QUAI   282\.85705135  282\.85705135  0/);
  assert.match(result.output, /RVN    0             0             0/);
  assert.doesNotMatch(result.output, /\t/);
});

test('market sell checks available balance and submits after --yes', async () => {
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell',
      '--pair', 'BTC-USDT', '--amount', '10', '--yes',
    ],
    {
      getBalance: async () => ({ available: '10.5' }),
      createOrder: async (order) => {
        submitted.push(order);
        return { order_id: 42, state: 'wait' };
      },
    },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(submitted, [{
    pair: 'BTC-USDT', side: 'sell', type: 'market', amount: '10', price: undefined,
  }]);
  assert.match(result.output, /Order submitted successfully: id=42/);
});

test('insufficient sell balance prevents submission', async () => {
  let submitted = false;
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell',
      '--pair', 'BTC-USDT', '--amount', '10', '--yes',
    ],
    {
      getBalance: async () => ({ available: '9.99' }),
      createOrder: async () => { submitted = true; },
    },
  );
  assert.equal(result.code, 1);
  assert.equal(submitted, false);
  assert.match(result.error, /Insufficient BTC balance/);
});

test('market sell derives a base amount from the target quote proceeds', async () => {
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell',
      '--pair', 'BTC-USDT', '--receive', '5', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        basePrecision: 8,
        quotePrecision: 2,
        minAmount: '0.0005',
        marketBuyAmountAsset: 'base',
      }),
      getPrice: async () => ({ price: '0.28' }),
      getBalance: async (asset) => {
        assert.equal(asset, 'BTC');
        return { available: '20' };
      },
      createOrder: async (order) => {
        submitted.push(order);
        return { id: 46 };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(submitted, [{
    pair: 'BTC-USDT',
    side: 'sell',
    type: 'market',
    amount: '17.85714286',
    price: undefined,
  }]);
  assert.match(result.output, /Receive target: 5 USDT gross/);
  assert.match(result.output, /Calculated order amount: 17\.85714286 BTC/);
  assert.match(result.output, /Estimated gross proceeds: 5\.0000000008 USDT/);
  assert.match(result.output, /fees and market-order slippage excluded/);
});

test('limit sell uses its limit price for target quote sizing', async () => {
  let priceRequested = false;
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'limit', '--side', 'sell', '--pair', 'BTC-USDT',
      '--receive', '5', '--price', '3', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        basePrecision: 2,
        quotePrecision: 2,
        minAmount: '0.01',
        marketBuyAmountAsset: 'base',
      }),
      getPrice: async () => {
        priceRequested = true;
        return { price: '2.5' };
      },
      getBalance: async () => ({ available: '2' }),
      createOrder: async (order) => {
        submitted.push(order);
        return { id: 47 };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(priceRequested, false);
  assert.equal(submitted[0].amount, '1.67');
  assert.equal(submitted[0].price, '3');
  assert.match(result.output, /Estimated gross proceeds: 5\.01 USDT/);
  assert.match(result.output, /limit price, rounded up to 2 decimal places/);
});

test('balance-percent 100 sells the available base balance rounded down', async () => {
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell',
      '--pair', 'BTC-USDT', '--balance-percent', '100', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        basePrecision: 8,
        quotePrecision: 2,
        minAmount: '0.0005',
        marketBuyAmountAsset: 'base',
      }),
      getBalance: async (asset) => {
        assert.equal(asset, 'BTC');
        return { available: '1.234567899' };
      },
      createOrder: async (order) => {
        submitted.push(order);
        return { id: 43 };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(submitted[0].amount, '1.23456789');
  assert.equal(submitted[0].amountAsset, undefined);
  assert.match(result.output, /100% of 1\.234567899 BTC = 1\.23456789 BTC/);
});

test('SafeTrade-style market buy calculates base amount with the buy reserve', async () => {
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'buy',
      '--pair', 'BTC-USDT', '--balance-percent', '100', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        basePrecision: 4,
        quotePrecision: 2,
        minAmount: '0.0005',
        marketBuyAmountAsset: 'base',
      }),
      getBalance: async (asset) => {
        assert.equal(asset, 'USDT');
        return { available: '100' };
      },
      getPrice: async () => ({ price: '20' }),
      createOrder: async (order) => {
        submitted.push(order);
        return { id: 44 };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(submitted[0].amount, '4.975');
  assert.equal(submitted[0].amountAsset, undefined);
  assert.match(result.output, /Buy reserve: 0\.5%.*order budget 99\.5 USDT/);
  assert.match(result.output, /Calculated order amount: 4\.975 BTC/);
});

test('CoinEx-style market buy submits a quote-denominated balance allocation', async () => {
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'buy',
      '--pair', 'BTC-USDT', '--balance-percent', '100', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        basePrecision: 8,
        quotePrecision: 2,
        minAmount: '0.0005',
        marketBuyAmountAsset: 'quote',
      }),
      getBalance: async () => ({ available: '100.129' }),
      createOrder: async (order) => {
        submitted.push(order);
        return { order_id: 45 };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(submitted[0].amount, '99.61');
  assert.equal(submitted[0].amountAsset, 'USDT');
  assert.match(result.output, /quote-denominated by the exchange/);
  assert.match(result.output, /Order: BUY BTC-USDT MARKET using 99\.61 USDT/);
});

test('order sizing options are mutually exclusive and percentage is capped', async () => {
  const both = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell', '--pair', 'BTC-USDT',
      '--amount', '1', '--balance-percent', '100', '--dryrun',
    ],
    {},
  );
  const tooHigh = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell', '--pair', 'BTC-USDT',
      '--balance-percent', '100.01', '--dryrun',
    ],
    {},
  );
  const receiveWithAmount = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell', '--pair', 'BTC-USDT',
      '--amount', '1', '--receive', '5', '--dryrun',
    ],
    {},
  );
  const receiveBuy = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'buy', '--pair', 'BTC-USDT',
      '--receive', '5', '--dryrun',
    ],
    {},
  );

  assert.equal(both.code, 1);
  assert.match(
    both.error,
    /exactly one of --amount, --balance-percent or --receive/,
  );
  assert.equal(tooHigh.code, 1);
  assert.match(tooHigh.error, /at most 100/);
  assert.equal(receiveWithAmount.code, 1);
  assert.match(receiveWithAmount.error, /exactly one/);
  assert.equal(receiveBuy.code, 1);
  assert.match(receiveBuy.error, /--receive can only be used with sell orders/);
});

test('limit price-percent is calculated and dryrun never submits', async () => {
  let submitted = false;
  const result = await runWithClient(
    [
      'order', '--type', 'limit', '--order', 'sell', '--amount', '10',
      '--pair', 'BTC-USDT', '--price-percent', '10', '--dryrun',
    ],
    {
      getPrice: async () => ({ price: '0.28000000' }),
      getBalance: async () => ({ available: '100' }),
      createOrder: async () => { submitted = true; },
    },
  );
  assert.equal(result.code, 0);
  assert.equal(submitted, false);
  assert.match(result.output, /0\.30800000 USDT/);
  assert.match(result.output, /Dry run complete/);
});

test('limit order rejects simultaneous price options', async () => {
  const result = await runWithClient(
    [
      'order', '--type', 'limit', '--side', 'sell', '--amount', '10',
      '--pair', 'BTC-USDT', '--price', '0.28', '--price-percent', '10', '--dryrun',
    ],
    {},
  );
  assert.equal(result.code, 1);
  assert.match(result.error, /mutually exclusive/);
});

test('interactive rejection cancels without submission', async () => {
  let submitted = false;
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell',
      '--pair', 'BTC-USDT', '--amount', '1',
    ],
    {
      getBalance: async () => ({ available: '2' }),
      createOrder: async () => { submitted = true; },
    },
    { confirm: async () => false },
  );
  assert.equal(result.code, 0);
  assert.equal(submitted, false);
  assert.match(result.output, /Order cancelled/);
});

test('Cloudflare API error is concise and actionable', async () => {
  const error = Object.assign(new Error('blocked'), {
    code: 'CLOUDFLARE_BLOCKED',
    status: 403,
    rayId: 'abc123',
  });
  Object.setPrototypeOf(error, (await import('../src/errors.js')).SafeTradeApiError.prototype);

  const result = await runWithClient(
    ['price', '--pair', 'BTC-USDT'],
    { getPrice: async () => { throw error; } },
  );
  assert.equal(result.code, 1);
  assert.match(result.error, /blocked the API request through Cloudflare/);
  assert.doesNotMatch(result.error, /<!DOCTYPE html>/);
});

async function runWithClient(args, client, extra = {}) {
  const stdout = [];
  const stderr = [];
  const code = await runCli(args, {
    clientFactory: () => client,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env: {},
    setDnsResultOrder: () => {},
    cwd: '/directory-that-does-not-exist',
    ...extra,
  });
  return {
    code,
    output: stdout.join('\n'),
    error: stderr.join('\n'),
  };
}
