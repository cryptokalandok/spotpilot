import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as processStdin, stdout as processStdout } from 'node:process';
import {
  applyPercent,
  compareDecimals,
  divideDecimals,
  divideDecimalsCeil,
  multiplyDecimals,
  percentageOf,
  subtractDecimals,
} from './decimal.js';
import {
  SpotPilotApiError,
  SpotPilotValidationError,
} from './errors.js';
import {
  createExchangeClient,
  normalizeExchangeName,
} from './exchanges/index.js';
import {
  normalizeAsset,
  normalizePositiveDecimal,
  splitPair,
} from './normalizers.js';
import { configureDnsResultOrder } from './network.js';

const VERSION = '0.8.0';
const DEFAULT_BUY_RESERVE_PERCENT = '0.5';
const BOOLEAN_OPTIONS = new Set(['help', 'yes', 'dryrun', 'debug']);

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? ((line) => console.log(line));
  const stderr = dependencies.stderr ?? ((line) => console.error(line));
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  let debug = argv.includes('--debug');

  try {
    if (argv.length === 0) {
      stdout(helpText());
      return 0;
    }

    if (argv[0] === '--help' || argv[0] === '-h') {
      stdout(helpText());
      return 0;
    }

    if (argv[0] === '--version' || argv[0] === '-v') {
      stdout(VERSION);
      return 0;
    }

    const command = argv[0];
    const options = parseOptions(argv.slice(1));
    debug = debug || options.debug === true;

    if (options.help) {
      stdout(commandHelp(command));
      return 0;
    }

    const fileEnv = loadEnvFile(join(cwd, '.env'));
    const config = { ...fileEnv, ...env };
    configureDnsResultOrder(
      config.SPOTPILOT_DNS_RESULT_ORDER,
      dependencies.setDnsResultOrder,
    );
    const exchange = normalizeExchangeName(
      options.exchange ?? config.SPOTPILOT_EXCHANGE ?? 'safetrade',
    );
    const clientFactory = dependencies.clientFactory ?? ((clientOptions) => (
      createExchangeClient(clientOptions)
    ));
    const client = clientFactory({
      exchange,
      env: config,
      timeoutMs: parseTimeout(
        config.SPOTPILOT_TIMEOUT_MS ??
        (exchange === 'coinex'
          ? config.COINEX_TIMEOUT_MS
          : config.SAFETRADE_TIMEOUT_MS),
      ),
    });

    switch (command) {
      case 'price':
        assertKnownOptions(options, ['exchange', 'pair', 'debug']);
        await printPrice(client, options, stdout);
        return 0;
      case 'status':
        assertKnownOptions(options, ['exchange', 'coin', 'debug']);
        await printStatus(client, options, stdout);
        return 0;
      case 'balance':
        assertKnownOptions(options, ['exchange', 'coin', 'debug']);
        await printBalances(client, options, stdout);
        return 0;
      case 'order':
        assertKnownOptions(options, [
          'exchange', 'type', 'side', 'order', 'pair', 'amount', 'price',
          'balance-percent', 'receive', 'reserve-percent', 'price-percent', 'yes',
          'dryrun', 'debug',
        ]);
        await submitOrder(client, options, {
          stdout,
          confirm: dependencies.confirm ?? defaultConfirm,
          buyReservePercent: config.SPOTPILOT_BUY_RESERVE_PERCENT,
        });
        return 0;
      default:
        throw new SpotPilotValidationError(
          `Unknown command: ${command}. Use "node spotpilot --help".`,
        );
    }
  } catch (error) {
    stderr(formatCliError(error));
    if (debug && error?.stack) {
      stderr(error.stack);
    }
    return 1;
  }
}

async function printPrice(client, options, stdout) {
  const pair = normalizeDisplayPair(options.pair);
  const { base, quote } = splitPair(pair);
  const result = await client.getPrice(pair);
  stdout(
    `[${client.displayName ?? client.exchange}] ${pair}: ` +
    `1 ${base} = ${result.price} ${quote} (last traded price)`,
  );
}

async function printStatus(client, options, stdout) {
  const assets = parseAssetList(options.coin);
  const statuses = await client.getAssetStatuses(assets);
  const rows = [];

  stdout(`Exchange: ${client.displayName ?? client.exchange}`);

  for (const asset of statuses) {
    rows.push([
      asset.asset,
      'ALL',
      formatAvailability(asset.depositEnabled),
      formatAvailability(asset.withdrawalEnabled),
    ]);

    for (const network of asset.networks ?? []) {
      rows.push([
        asset.asset,
        network.network,
        formatAvailability(network.depositEnabled),
        formatAvailability(network.withdrawalEnabled),
      ]);
    }
  }

  printTable(['ASSET', 'NETWORK', 'DEPOSIT', 'WITHDRAWAL'], rows, stdout);
}

async function printBalances(client, options, stdout) {
  const assets = parseAssetList(options.coin);
  const balances = await client.getBalances({ coins: assets });
  const byAsset = new Map(balances.map((balance) => [balance.asset, balance]));
  const rows = assets.map((asset) => {
    const balance = byAsset.get(asset) ?? {
      total: '0',
      available: '0',
      locked: '0',
    };
    return [asset, balance.total, balance.available, balance.locked];
  });

  stdout(`Exchange: ${client.displayName ?? client.exchange}`);
  printTable(['ASSET', 'TOTAL', 'AVAILABLE', 'LOCKED'], rows, stdout);
}

async function submitOrder(
  client,
  options,
  { stdout, confirm, buyReservePercent },
) {
  const pair = normalizeDisplayPair(options.pair);
  const { base, quote } = splitPair(pair);
  const type = normalizeChoice(options.type, 'type', ['market', 'limit']);
  const sideOption = resolveSideOption(options);
  const side = normalizeChoice(sideOption, 'side', ['buy', 'sell']);
  const hasAmount = options.amount !== undefined;
  const hasBalancePercent = options['balance-percent'] !== undefined;
  const hasReceive = options.receive !== undefined;
  const hasPrice = options.price !== undefined;
  const hasPricePercent = options['price-percent'] !== undefined;

  const sizingOptionCount = [hasAmount, hasBalancePercent, hasReceive]
    .filter(Boolean)
    .length;
  if (sizingOptionCount !== 1) {
    throw new SpotPilotValidationError(
      'Use exactly one of --amount, --balance-percent or --receive',
    );
  }
  if (hasReceive && side !== 'sell') {
    throw new SpotPilotValidationError(
      '--receive can only be used with sell orders',
    );
  }
  if (
    options['reserve-percent'] !== undefined &&
    (!hasBalancePercent || side !== 'buy')
  ) {
    throw new SpotPilotValidationError(
      '--reserve-percent can only be used with buy orders sized by --balance-percent',
    );
  }

  if (hasPrice && hasPricePercent) {
    throw new SpotPilotValidationError(
      '--price and --price-percent are mutually exclusive',
    );
  }

  if (type === 'market' && (hasPrice || hasPricePercent)) {
    throw new SpotPilotValidationError(
      'Market orders must not use --price or --price-percent',
    );
  }

  if (type === 'limit' && !hasPrice && !hasPricePercent) {
    throw new SpotPilotValidationError(
      'A limit order requires exactly one of --price or --price-percent',
    );
  }

  let price;
  let marketPrice;
  let amount = hasAmount
    ? normalizePositiveDecimal(options.amount, 'amount')
    : undefined;
  let amountAsset;

  if (hasAmount) {
    const marketInfo = await requireMarketInfo(client, pair);
    assertMinimumAmount(amount, marketInfo, base);
  }

  if (hasPrice) {
    price = normalizePositiveDecimal(options.price, 'price');
  } else if (hasPricePercent) {
    const percent = String(options['price-percent']).trim().replace(',', '.');
    marketPrice = await client.getPrice(pair);
    price = applyPercent(marketPrice.price, percent);
    stdout(
      `Price calculation: ${marketPrice.price} ${quote} ${formatPercent(percent)} = ${price} ${quote}`,
    );
  }

  if (hasBalancePercent) {
    ({ amount, amountAsset, marketPrice } = await resolveBalancePercentOrder({
      client,
      options,
      pair,
      base,
      quote,
      type,
      side,
      price,
      marketPrice,
      buyReservePercent,
      stdout,
    }));
  } else if (hasReceive) {
    ({ amount, marketPrice } = await resolveReceiveSellOrder({
      client,
      options,
      pair,
      base,
      quote,
      price,
      marketPrice,
      stdout,
    }));
    await checkSellBalance(client, base, amount, stdout);
  } else if (side === 'sell') {
    await checkSellBalance(client, base, amount, stdout);
  } else {
    if (!price) {
      marketPrice = marketPrice ?? await client.getPrice(pair);
    }
    const referencePrice = price ?? marketPrice.price;
    const requiredQuote = multiplyDecimals(amount, referencePrice);
    const balance = await client.getBalance(quote);
    const available = balance?.available ?? '0';
    if (compareDecimals(available, requiredQuote) < 0) {
      throw new SpotPilotValidationError(
        `Insufficient ${quote} balance: ${available} available, approximately ${requiredQuote} required`,
      );
    }
    stdout(
      `Balance check: ${available} ${quote} available; estimated principal ${requiredQuote} ${quote} (fees/slippage excluded)`,
    );
  }

  const summary = amountAsset === quote
    ? [
      side.toUpperCase(),
      pair,
      type.toUpperCase(),
      `using ${amount} ${quote}`,
    ].join(' ')
    : [
      side.toUpperCase(),
      amount,
      pair,
      type.toUpperCase(),
      price ? `@ ${price} ${quote}` : '',
    ].filter(Boolean).join(' ');
  stdout(`Exchange: ${client.displayName ?? client.exchange}`);
  stdout(`Order: ${summary}`);

  if (options['dryrun']) {
    stdout('Dry run complete: no order was submitted.');
    return;
  }

  if (!options.yes) {
    const approved = await confirm('Submit this order? [y/N] ');
    if (!approved) {
      stdout('Order cancelled; nothing was submitted.');
      return;
    }
  }

  const orderRequest = {
    pair,
    side,
    type,
    amount,
    price,
  };
  if (amountAsset !== undefined) {
    orderRequest.amountAsset = amountAsset;
  }

  const order = await client.createOrder(orderRequest);
  const id = order?.id ?? order?.order_id ?? order?.uuid ?? 'unknown';
  const state = order?.state ? `, state=${order.state}` : '';
  stdout(`Order submitted successfully: id=${id}${state}`);
}

async function resolveBalancePercentOrder({
  client,
  options,
  pair,
  base,
  quote,
  type,
  side,
  price,
  marketPrice,
  buyReservePercent,
  stdout,
}) {
  const balancePercent = normalizeBalancePercent(options['balance-percent']);
  const marketInfo = await requireMarketInfo(client, pair);
  const balanceAsset = side === 'sell' ? base : quote;
  const balancePrecision = side === 'sell'
    ? marketInfo.basePrecision
    : marketInfo.quotePrecision;
  const balance = await client.getBalance(balanceAsset);
  const available = balance?.available ?? '0';
  const allocation = percentageOf(
    available,
    balancePercent,
    balancePrecision,
  );

  if (compareDecimals(allocation, '0') <= 0) {
    throw new SpotPilotValidationError(
      `${balancePercent}% of the available ${balanceAsset} balance rounds down to zero`,
    );
  }

  stdout(
    `Balance allocation: ${balancePercent}% of ${available} ${balanceAsset} = ` +
    `${allocation} ${balanceAsset}`,
  );

  if (side === 'sell') {
    assertMinimumAmount(allocation, marketInfo, base);
    return { amount: allocation, amountAsset: undefined, marketPrice };
  }

  const reservePercent = normalizeReservePercent(
    options['reserve-percent'] ??
    buyReservePercent ??
    DEFAULT_BUY_RESERVE_PERCENT,
  );
  const spendPercent = subtractDecimals('100', reservePercent);
  const budget = percentageOf(
    allocation,
    spendPercent,
    marketInfo.quotePrecision,
  );

  if (compareDecimals(budget, '0') <= 0) {
    throw new SpotPilotValidationError(
      `The ${quote} order budget rounds down to zero after applying the reserve`,
    );
  }

  stdout(
    `Buy reserve: ${reservePercent}% of the selected allocation; ` +
    `order budget ${budget} ${quote}`,
  );

  if (type === 'market' && marketInfo.marketBuyAmountAsset === 'quote') {
    stdout(
      `Market-buy amount: ${budget} ${quote} (quote-denominated by the exchange)`,
    );
    return { amount: budget, amountAsset: quote, marketPrice };
  }

  if (!price) {
    marketPrice = marketPrice ?? await client.getPrice(pair);
  }
  const referencePrice = price ?? marketPrice.price;
  const amount = divideDecimals(
    budget,
    referencePrice,
    marketInfo.basePrecision,
  );

  if (compareDecimals(amount, '0') <= 0) {
    throw new SpotPilotValidationError(
      `The calculated ${base} order amount rounds down to zero`,
    );
  }
  assertMinimumAmount(amount, marketInfo, base);
  stdout(
    `Calculated order amount: ${amount} ${base} using ` +
    `${referencePrice} ${quote} per ${base}`,
  );

  return { amount, amountAsset: undefined, marketPrice };
}

async function resolveReceiveSellOrder({
  client,
  options,
  pair,
  base,
  quote,
  price,
  marketPrice,
  stdout,
}) {
  const target = normalizePositiveDecimal(options.receive, 'receive');
  const marketInfo = await requireMarketInfo(client, pair);
  if (!price) {
    marketPrice = marketPrice ?? await client.getPrice(pair);
  }
  const referencePrice = price ?? marketPrice.price;
  const amount = divideDecimalsCeil(
    target,
    referencePrice,
    marketInfo.basePrecision,
  );

  if (compareDecimals(amount, '0') <= 0) {
    throw new SpotPilotValidationError(
      `The calculated ${base} order amount rounds to zero`,
    );
  }

  assertMinimumAmount(amount, marketInfo, base);
  const estimatedGross = multiplyDecimals(amount, referencePrice);
  const priceKind = price ? 'limit price' : 'last traded price';

  stdout(`Receive target: ${target} ${quote} gross`);
  stdout(
    `Calculated order amount: ${amount} ${base} using ${referencePrice} ` +
    `${quote} per ${base} (${priceKind}, rounded up to ` +
    `${marketInfo.basePrecision} decimal places)`,
  );
  stdout(
    `Estimated gross proceeds: ${estimatedGross} ${quote} ` +
    '(exchange fees and market-order slippage excluded)',
  );

  return { amount, marketPrice };
}

async function checkSellBalance(client, base, amount, stdout) {
  const balance = await client.getBalance(base);
  const available = balance?.available ?? '0';
  if (compareDecimals(available, amount) < 0) {
    throw new SpotPilotValidationError(
      `Insufficient ${base} balance: ${available} available, ` +
      `${amount} requested for this order`,
    );
  }
  stdout(`Balance check: ${available} ${base} available`);
}

async function requireMarketInfo(client, pair) {
  if (typeof client.getMarketInfo !== 'function') {
    throw new SpotPilotValidationError(
      'The selected exchange client does not provide market precision metadata',
    );
  }
  return client.getMarketInfo(pair);
}

function assertMinimumAmount(amount, marketInfo, base) {
  if (
    marketInfo.minAmount !== null &&
    marketInfo.minAmount !== undefined &&
    compareDecimals(amount, marketInfo.minAmount) < 0
  ) {
    const market = marketInfo.pair ?? marketInfo.market ?? 'selected';
    throw new SpotPilotValidationError(
      `Order amount ${amount} ${base} is below the ${market} market minimum ` +
      `of ${marketInfo.minAmount} ${base}`,
    );
  }
}

function normalizeBalancePercent(value) {
  const percent = normalizePositiveDecimal(value, 'balance-percent');
  if (compareDecimals(percent, '100') > 0) {
    throw new SpotPilotValidationError(
      'balance-percent must be greater than 0 and at most 100',
    );
  }
  return percent;
}

function normalizeReservePercent(value) {
  const percent = String(value).trim().replace(',', '.');
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(percent)) {
    throw new SpotPilotValidationError(
      'reserve-percent must be a decimal from 0 up to, but not including, 100',
    );
  }
  if (compareDecimals(percent, '100') >= 0) {
    throw new SpotPilotValidationError(
      'reserve-percent must be a decimal from 0 up to, but not including, 100',
    );
  }
  return percent;
}

function parseOptions(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '-h') {
      options.help = true;
      continue;
    }

    if (!argument.startsWith('--')) {
      throw new SpotPilotValidationError(`Unexpected argument: ${argument}`);
    }

    const [rawName, inlineValue] = argument.slice(2).split(/=(.*)/s, 2);
    const name = rawName.trim();

    if (!name) {
      throw new SpotPilotValidationError('Invalid empty option');
    }

    if (Object.hasOwn(options, name)) {
      throw new SpotPilotValidationError(`Option --${name} was provided twice`);
    }

    if (BOOLEAN_OPTIONS.has(name)) {
      if (inlineValue !== undefined && !['true', 'false'].includes(inlineValue)) {
        throw new SpotPilotValidationError(
          `Boolean option --${name} accepts only true or false`,
        );
      }
      options[name] = inlineValue === undefined ? true : inlineValue === 'true';
      continue;
    }

    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new SpotPilotValidationError(`Option --${name} requires a value`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
    options[name] = value;
  }

  return options;
}

function resolveSideOption(options) {
  if (options.side !== undefined && options.order !== undefined) {
    throw new SpotPilotValidationError(
      'Use either --side or the compatibility alias --order, not both',
    );
  }
  return options.side ?? options.order;
}

function normalizeChoice(value, name, allowed) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new SpotPilotValidationError(
      `--${name} is required and must be one of: ${allowed.join(', ')}`,
    );
  }
  return normalized;
}

function normalizeDisplayPair(value) {
  requireOption(value, '--pair');
  const { base, quote } = splitPair(value);
  return `${base}-${quote}`;
}

function parseAssetList(value) {
  requireOption(value, '--coin');
  return String(value).split(',').map(normalizeAsset);
}

function requireOption(value, name) {
  if (value === undefined || String(value).trim() === '') {
    throw new SpotPilotValidationError(`${name} is required`);
  }
}

function assertKnownOptions(options, allowed) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(options).find((name) => !allowedSet.has(name));
  if (unknown) {
    throw new SpotPilotValidationError(`Unknown option: --${unknown}`);
  }
}

function parseTimeout(value) {
  if (value === undefined || value === '') {
    return 15_000;
  }
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new SpotPilotValidationError(
      'The configured timeout must be a positive integer',
    );
  }
  return timeout;
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  const result = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

async function defaultConfirm(question) {
  if (!processStdin.isTTY) {
    throw new SpotPilotValidationError(
      'Non-interactive order submission requires --yes',
    );
  }
  const readline = createInterface({ input: processStdin, output: processStdout });
  try {
    const answer = await readline.question(question);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    readline.close();
  }
}

function formatPercent(percent) {
  return percent.startsWith('-') ? `${percent}%` : `+${percent}%`;
}

function formatAvailability(value) {
  if (value === true) {
    return 'ENABLED';
  }
  if (value === false) {
    return 'DISABLED';
  }
  return 'UNKNOWN';
}

function printTable(headers, rows, stdout) {
  const normalizedRows = [headers, ...rows].map((row) => (
    row.map((cell) => String(cell))
  ));
  const widths = headers.map((_, column) => Math.max(
    ...normalizedRows.map((row) => row[column]?.length ?? 0),
  ));

  for (const row of normalizedRows) {
    stdout(row.map((cell, column) => (
      cell.padEnd(widths[column])
    )).join('  ').trimEnd());
  }
}

function formatCliError(error) {
  if (error instanceof SpotPilotApiError && error.code === 'CLOUDFLARE_BLOCKED') {
    const ray = error.rayId ? ` Cloudflare Ray ID: ${error.rayId}.` : '';
    return [
      'SafeTrade blocked the API request through Cloudflare (HTTP 403).',
      'This happened before SafeTrade processed the API call; it is not an API-key error.',
      `Try again from another network or contact SafeTrade support.${ray}`,
    ].join('\n');
  }
  return error?.message ?? String(error);
}

function helpText() {
  return `SpotPilot ${VERSION} — multi-exchange spot trading CLI

Usage:
  node spotpilot <command> [options]

Commands:
  price      Show the last traded price for a pair
  status     Show asset and network deposit/withdrawal status
  balance    Show total, available and locked balances
  order      Validate and submit a market or limit order

Examples:
  node spotpilot price --exchange coinex --pair BTC-USDT
  node spotpilot status --exchange coinex --coin PEARL,USDT
  node spotpilot balance --exchange coinex --coin QUAI,RVN
  node spotpilot order --exchange coinex --type market --side sell --pair BTC-USDT --amount 0.001
  node spotpilot order --exchange coinex --type market --side sell --pair BTC-USDT --balance-percent 100
  node spotpilot order --exchange coinex --type market --side sell --pair BTC-USDT --receive 100 --dryrun
  node spotpilot order --exchange coinex --type market --side buy --pair BTC-USDT --balance-percent 100 --dryrun
  node spotpilot order --exchange coinex --type limit --side sell --pair BTC-USDT --amount 0.001 --price-percent 10
  node spotpilot order --exchange coinex --type limit --side sell --pair BTC-USDT --amount 0.001 --price 60000 --dryrun

Run "node spotpilot <command> --help" for command-specific help.`;
}

function commandHelp(command) {
  const help = {
    price: `Usage: node spotpilot price [--exchange safetrade|coinex] --pair BTC-USDT`,
    status: `Usage: node spotpilot status [--exchange safetrade|coinex] --coin PEARL,USDT

Shows deposit/withdrawal availability for one or more comma-separated assets.
Network-specific rows are included when the exchange provides them.`,
    balance: `Usage: node spotpilot balance [--exchange safetrade|coinex] --coin QUAI,RVN`,
    order: `Usage: node spotpilot order --type market|limit --side buy|sell [options]

Options:
  --exchange coinex     Exchange (default: SPOTPILOT_EXCHANGE or safetrade)
  --pair BTC-USDT       Trading pair; required
  --amount 0.001        Exact base-asset amount
  --balance-percent 100 Percentage of available base (sell) or quote (buy)
  --receive 100         Target gross quote proceeds for a sell order
                        Use exactly one of --amount, --balance-percent or --receive
  --reserve-percent 0.5 Buy-side reserve used with --balance-percent
                        (default: SPOTPILOT_BUY_RESERVE_PERCENT or 0.5)
  --price 0.28          Exact limit price
  --price-percent 10    Limit price relative to last traded price
  --dryrun              Validate without submitting
  --yes                 Skip the interactive confirmation
  --order sell          Compatibility alias for --side sell`,
  };
  if (!help[command]) {
    throw new SpotPilotValidationError(`Unknown command: ${command}`);
  }
  return help[command];
}
