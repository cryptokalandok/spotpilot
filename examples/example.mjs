import { SafeTradeClient } from '../src/index.js';

const client = new SafeTradeClient({
  apiKey: process.env.SAFETRADE_API_KEY,
  apiSecret: process.env.SAFETRADE_API_SECRET,
});

try {
  const price = await client.getPrice('PRL-USDT');
  console.log(`1 PRL = ${price.price} USDT (last traded price)`);

  const balances = await client.getBalances({ coins: 'PRL,USDT' });
  console.table(balances.map(({ raw: _raw, ...balance }) => balance));
} catch (error) {
  if (error.code === 'CLOUDFLARE_BLOCKED') {
    console.error(
      'SafeTrade/Cloudflare blocked this API request (HTTP 403). ' +
      'This is not an API-key error; try another network or contact SafeTrade support.',
    );
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
}

// Order creation is deliberately not called in this example.
// Market sell:
// await client.createOrder({
//   pair: 'PRL-USDT',
//   side: 'sell',
//   type: 'market',
//   amount: '10',
// });

// Limit sell (Hungarian decimal comma is accepted and normalized):
// await client.createOrder({
//   pair: 'PRL-USDT',
//   side: 'sell',
//   type: 'limit',
//   amount: '10',
//   price: '0,28',
// });
