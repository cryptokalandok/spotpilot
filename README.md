# SpotPilot

SpotPilot is a dependency-free, multi-exchange spot trading CLI and reusable
Node.js library. It currently supports SafeTrade and CoinEx. The same
client/service layer can later be called from an AWS Lambda handler.

## Requirements

- Node.js 20 or newer
- An API key for balances and orders on the selected exchange
- No npm runtime dependencies

Public price requests do not require an API key.

## Why `npm install` creates no `node_modules`

The project deliberately has no third-party packages. It uses Node's built-in
`fetch`, `crypto`, `readline`, test runner and filesystem modules. Therefore an
`npm install` may create or update `package-lock.json`, but there is nothing to
place in a `node_modules` directory. This is expected and keeps a future Lambda
deployment small.

## Run the CLI

No install step is required:

```bash
node spotpilot --help
node spotpilot price --exchange coinex --pair PRL-USDT
```

To make `spotpilot` available as a command while developing locally:

```bash
npm link
spotpilot --help
```

Alternatively, every command can be run through npm:

```bash
npm run spotpilot -- price --exchange coinex --pair PRL-USDT
```

Running `node spotpilot` without a command prints the help screen.

## Configuration

Copy the example and insert dedicated, trading-only API credentials for the
exchange you want to use:

```bash
cp .env.example .env
```

```dotenv
SPOTPILOT_EXCHANGE=coinex

COINEX_API_KEY=your-access-id
COINEX_API_SECRET=your-secret-key

SAFETRADE_API_KEY=your-api-key
SAFETRADE_API_SECRET=your-api-secret
```

Exchange selection uses this precedence:

1. the command's `--exchange safetrade|coinex` option;
2. `SPOTPILOT_EXCHANGE` from the environment or `.env`;
3. `safetrade` for backward compatibility.

The CLI loads `.env` itself; no `dotenv` package is needed. Existing shell
environment variables override values from the file.

Optional variables:

```dotenv
SPOTPILOT_TIMEOUT_MS=15000
SAFETRADE_BASE_URL=https://safe.trade/api/v2
COINEX_BASE_URL=https://api.coinex.com/v2
COINEX_WINDOW_TIME_MS=5000
```

`SAFETRADE_TIMEOUT_MS` and `COINEX_TIMEOUT_MS` can be used instead of the shared
timeout. Do not pass secrets as command-line flags: they can appear in shell
history and process listings.

## Commands

The following examples select CoinEx explicitly. You can omit
`--exchange coinex` after setting `SPOTPILOT_EXCHANGE=coinex`.

### Price

```bash
node spotpilot price --exchange coinex --pair PRL-USDT
```

The displayed price is the ticker's **last traded price**.

### Balances

```bash
node spotpilot balance --exchange coinex --coin PRL,USDT
```

Output contains total, available and locked amounts. CoinEx's `frozen` balance
is exposed as `locked`, and `total` is calculated exactly as
`available + locked`. A requested asset missing from the API response is
displayed as zero.

### Market order

```bash
node spotpilot order \
  --exchange coinex \
  --type market \
  --side sell \
  --pair PRL-USDT \
  --amount 10
```

`--amount` always means the base-asset amount: in `PRL-USDT`, `--amount 10`
means 10 PRL for both buys and sells. SpotPilot explicitly sends this
denomination to CoinEx for market orders.

Before a sell, SpotPilot checks the base asset's available balance. It then
shows an order summary and asks for confirmation. Use `--yes` only for an
intentional non-interactive submission.

The original `--order sell` spelling is accepted as a compatibility alias, but
`--side sell` is the preferred terminology.

### Limit order with an exact price

```bash
node spotpilot order \
  --exchange coinex \
  --type limit \
  --side sell \
  --pair PRL-USDT \
  --amount 10 \
  --price 0,28
```

Hungarian decimal commas are accepted for individual numeric arguments and
normalized to decimal points.

### Limit order relative to the current price

```bash
node spotpilot order \
  --exchange coinex \
  --type limit \
  --side sell \
  --pair PRL-USDT \
  --amount 10 \
  --price-percent 10
```

This uses the last traded price and places the limit price 10% higher. The
calculation uses exact decimal arithmetic and rounds to the number of decimal
places present in the ticker response. `--price` and `--price-percent` are
mutually exclusive.

### Dry run

```bash
node spotpilot order \
  --exchange coinex \
  --type limit \
  --side sell \
  --amount 10 \
  --price 0.28 \
  --dryrun
```

A dry run performs the required private, read-only balance call and all local
validations, but never submits an order. It therefore still needs API
credentials.

For buy orders, SpotPilot estimates the required quote balance from the limit
price or last traded price. The estimate excludes fees and market-order
slippage; the selected exchange remains the final authority when accepting an
order.

## Tests: what they do and do not prove

```bash
npm test
```

The test suite uses Node's built-in test runner. Tests inject fake `fetch`
functions or fake clients and verify:

- SafeTrade and CoinEx HMAC-SHA256 signatures and monotonic timestamps;
- exact URLs, authentication headers and JSON order bodies;
- exchange selection through the CLI and factory;
- market/limit validation and mutually exclusive price options;
- balance normalization and insufficient-balance rejection;
- exact decimal and percentage calculations without floating-point rounding;
- CLI parsing, help, human-readable output, confirmation and dryrun behavior;
- concise handling of SafeTrade/Cloudflare HTTP 403 pages;
- structured SafeTrade and CoinEx API errors.

They deliberately do **not** contact either exchange or create a real order.
This is why they can pass even when a live API is unavailable. Use one of these
public, read-only smoke tests to check network access:

```bash
npm run smoke:coinex
npm run smoke:safetrade
```

## SafeTrade/Cloudflare HTTP 403

SafeTrade's Cloudflare configuration may block a legitimate API request before
it reaches the exchange. This affects even public ticker requests and has also
been reported against SafeTrade's official example client. SpotPilot recognizes
this response and prints a short actionable error instead of the full HTML
page.

This is not an API-key or Node.js error. Try the public SafeTrade smoke test
from another normal network and contact SafeTrade support with the displayed
Cloudflare Ray ID if the block persists. Before choosing AWS Lambda, ask
SafeTrade whether requests from AWS IP ranges are supported.

## Node.js library usage

Use the exchange factory when application configuration chooses the provider:

```js
import { createExchangeClient } from './src/index.js';

const client = createExchangeClient({
  exchange: process.env.SPOTPILOT_EXCHANGE ?? 'coinex',
  env: process.env,
});

const { price } = await client.getPrice('PRL-USDT');
const balances = await client.getBalances({ coins: 'PRL,USDT' });

await client.createOrder({
  pair: 'PRL-USDT',
  side: 'sell',
  type: 'market',
  amount: '10',
});
```

`SafeTradeClient` and `CoinExClient` can also be instantiated directly. All
financial values stay as decimal strings.

## API mapping

| Capability | SafeTrade | CoinEx |
| --- | --- | --- |
| Markets | `GET /trade/public/markets` | `GET /spot/market` |
| Ticker | `GET /trade/public/tickers/{market}` | `GET /spot/ticker?market={market}` |
| Spot balances | `GET /trade/account/balances/spot` | `GET /assets/spot/balance` |
| Pending orders | `GET /trade/market/orders` | `GET /spot/pending-order` |
| Create order | `POST /trade/market/orders` | `POST /spot/order` |

Default base URLs:

- SafeTrade: `https://safe.trade/api/v2`
- CoinEx: `https://api.coinex.com/v2`

CoinEx private requests sign the exact HTTP method, `/v2` request path including
its query string, optional JSON body, and millisecond timestamp. Authentication
uses `X-COINEX-KEY`, `X-COINEX-SIGN`, `X-COINEX-TIMESTAMP` and
`X-COINEX-WINDOWTIME` headers.

## Security

- Use a dedicated API key with spot-trading permission only; disable withdrawals.
- IP-lock the API key if the selected exchange supports it for your account.
- Keep `.env` out of version control.
- For Lambda, use AWS Secrets Manager or encrypted SSM Parameter Store.
- Start with `--dryrun`, then test the smallest permitted real amount.
- A successfully created limit order may remain open or fill only partially.

## Sources

- [CoinEx API v2 introduction](https://docs.coinex.com/api/v2/)
- [CoinEx authentication](https://docs.coinex.com/api/v2/authorization)
- [CoinEx ticker endpoint](https://docs.coinex.com/api/v2/spot/market/http/list-market-ticker)
- [CoinEx spot balance endpoint](https://docs.coinex.com/api/v2/assets/balance/http/get-spot-balance)
- [CoinEx create-order endpoint](https://docs.coinex.com/api/v2/spot/order/http/put-order)
- [SafeTrade API documentation](https://safetrade.com/api)
- [SafeTrade official example client](https://github.com/safetrade-exchange/example-client)
- [Reported SafeTrade Cloudflare block](https://github.com/safetrade-exchange/example-client/issues/1)
