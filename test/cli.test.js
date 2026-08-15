import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from '../src/cli.js';

test('no command prints help instead of doing nothing', async () => {
  const result = await runWithClient([], {});
  assert.equal(result.code, 0);
  assert.match(result.output, /SpotPilot 0\.5\.0/);
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
      env: {},
      cwd: '/directory-that-does-not-exist',
    },
  );

  assert.equal(code, 0);
  assert.equal(factoryCalls[0].exchange, 'coinex');
  assert.match(stdout.join('\n'), /\[CoinEx\].*0\.30 USDT/);
  assert.deepEqual(stderr, []);
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
    cwd: '/directory-that-does-not-exist',
    ...extra,
  });
  return {
    code,
    output: stdout.join('\n'),
    error: stderr.join('\n'),
  };
}
