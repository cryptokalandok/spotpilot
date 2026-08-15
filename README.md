# SpotPilot

SpotPilot is a dependency-free SafeTrade spot trading CLI and reusable Node.js
client. The same client/service layer can later be called from an AWS Lambda
handler.

## Requirements

- Node.js 20 or newer
- A SafeTrade API key for balances and orders
- No npm runtime dependencies

## Why `npm install` creates no `node_modules`

The project deliberately has no third-party packages. It uses Node's built-in
`fetch`, `crypto`, `readline`, test runner and filesystem modules. Therefore an
`npm install` may create `package-lock.json`, but there is nothing to place in a
`node_modules` directory. This is expected and keeps a future Lambda deployment
small.

## Run the CLI

No install step is required:

```bash
node spotpilot --help
node spotpilot price --pair PRL-USDT
```

To make `spotpilot` available as a command while developing locally:

```bash
npm link
spotpilot --help
```

Alternatively, every command can be run through npm:

```bash
npm run spotpilot -- price --pair PRL-USDT
```

Running `node spotpilot` without a command prints the help screen.

## Configuration

Copy the example and insert a dedicated, trading-only API key:

```bash
cp .env.example .env
```

```dotenv
SAFETRADE_API_KEY=your-api-key
SAFETRADE_API_SECRET=your-api-secret
```

The CLI loads `.env` itself; no `dotenv` package is needed. Existing shell
environment variables override values from the file.

Optional variables:

```dotenv
SAFETRADE_BASE_URL=https://safe.trade/api/v2
SAFETRADE_TIMEOUT_MS=15000
```

Do not pass secrets as command-line flags: they can appear in shell history and
process listings.

## Commands

### Price

```bash
node spotpilot price --pair PRL-USDT
```

The displayed price is explicitly the ticker's **last traded price**.

### Balances

```bash
node spotpilot balance --coin PRL,USDT
```

Output contains total, available and locked amounts. A requested asset missing
from the API response is displayed as zero.

### Market order

```bash
node spotpilot order \
  --type market \
  --side sell \
  --pair PRL-USDT \
  --amount 10
```

Before a sell, SpotPilot checks the base asset's available balance. It then
shows an order summary and asks for confirmation. Use `--yes` only for an
intentional non-interactive submission.

The original `--order sell` spelling is accepted as a compatibility alias, but
`--side sell` is the preferred terminology.

### Limit order with an exact price

```bash
node spotpilot order \
  --type limit \
  --side sell \
  --amount 10 \
  --price 0,28
```

Hungarian decimal commas are accepted for individual numeric arguments and
normalized to decimal points.

### Limit order relative to the current price

```bash
node spotpilot order \
  --type limit \
  --side sell \
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
  --type limit \
  --side sell \
  --amount 10 \
  --price 0.28 \
  --dryrun
```

A dry run performs the required read-only API calls and validations, but never
submits an order.

For buy orders, SpotPilot estimates the required quote balance from the limit
price or last traded price. The estimate excludes fees and market-order
slippage; SafeTrade remains the final authority when accepting an order.

## Tests: what they do and do not prove

```bash
npm test
```

The test suite uses Node's built-in test runner. Most tests inject a fake
`fetch` function or a fake client and then verify:

- HMAC-SHA256 signatures and monotonically increasing nonces;
- exact URL, authentication headers and JSON order body;
- market/limit validation and mutually exclusive price options;
- balance normalization and insufficient-balance rejection;
- exact decimal and percentage calculations without floating-point rounding;
- CLI parsing, help, human-readable output, confirmation and dryrun behavior;
- concise handling of SafeTrade/Cloudflare HTTP 403 pages;
- parsed SafeTrade error responses.

They deliberately do **not** contact SafeTrade or create a real order. This is
why they can pass even when the live API is blocked. To make one real public,
read-only request, run:

```bash
npm run smoke:live
```

## SafeTrade/Cloudflare HTTP 403

SafeTrade's Cloudflare configuration may block a legitimate API request before
it reaches the exchange. This affects even public ticker requests and has also
been reported against SafeTrade's official example client. SpotPilot now
recognizes this response and prints a short actionable error instead of the
complete HTML page.

This is not an API-key or Node.js error, and swapping in another Node library
does not inherently solve it. Try the public smoke test from another normal
network and contact SafeTrade support with the displayed Cloudflare Ray ID if
the block persists. Before choosing AWS Lambda, ask SafeTrade whether requests
from AWS IP ranges are supported; Lambda will not help if those addresses are
blocked too.

## Node.js library usage

```js
import { SafeTradeClient } from './src/index.js';

const client = new SafeTradeClient({
  apiKey: process.env.SAFETRADE_API_KEY,
  apiSecret: process.env.SAFETRADE_API_SECRET,
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

All financial values stay as decimal strings.

## API mapping

The client is based on SafeTrade's current API page and official Python example
client:

| Capability | HTTP request |
| --- | --- |
| Markets | `GET /trade/public/markets` |
| Ticker | `GET /trade/public/tickers/{market}` |
| Spot balances | `GET /trade/account/balances/spot` |
| Orders | `GET /trade/market/orders` |
| Create order | `POST /trade/market/orders` |

Default base URL: `https://safe.trade/api/v2`

Private requests use:

```text
X-Auth-Apikey: <api key>
X-Auth-Nonce: <monotonically increasing millisecond timestamp>
X-Auth-Signature: HMAC-SHA256(apiSecret, nonce + apiKey), hex encoded
```

No official SafeTrade Node/NPM SDK was found. SafeTrade currently publishes a
Python example client; third-party TypeScript wrappers use the same REST and
HMAC mechanism implemented here.

## Security

- Use a dedicated API key with trading permission only; disable withdrawals.
- IP-lock the API key if SafeTrade supports it for your account.
- Keep `.env` out of version control.
- For Lambda, use AWS Secrets Manager or encrypted SSM Parameter Store.
- Start with `--dryrun`, then test the smallest permitted real amount.
- A successfully created limit order may remain open or fill only partially.

## Sources

- SafeTrade API documentation: https://safetrade.com/api
- SafeTrade official example client: https://github.com/safetrade-exchange/example-client
- Reported Cloudflare block: https://github.com/safetrade-exchange/example-client/issues/1
