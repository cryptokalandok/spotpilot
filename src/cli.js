import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as processStdin, stdout as processStdout } from 'node:process';
import { SafeTradeClient } from './client.js';
import { compareDecimals, applyPercent, multiplyDecimals } from './decimal.js';
import {
  SafeTradeApiError,
  SafeTradeValidationError,
} from './errors.js';
import {
  normalizeAsset,
  normalizePositiveDecimal,
} from './normalizers.js';

const VERSION = '0.2.0';
const DEFAULT_PAIR = 'PRL-USDT';
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
    const clientFactory = dependencies.clientFactory ?? ((clientOptions) => (
      new SafeTradeClient(clientOptions)
    ));
    const client = clientFactory({
      apiKey: config.SAFETRADE_API_KEY,
      apiSecret: config.SAFETRADE_API_SECRET,
      baseUrl: config.SAFETRADE_BASE_URL,
      timeoutMs: parseTimeout(config.SAFETRADE_TIMEOUT_MS),
    });

    switch (command) {
      case 'price':
        assertKnownOptions(options, ['pair', 'debug']);
        await printPrice(client, options, stdout);
        return 0;
      case 'balance':
        assertKnownOptions(options, ['coin', 'debug']);
        await printBalances(client, options, stdout);
        return 0;
      case 'order':
        assertKnownOptions(options, [
          'type', 'side', 'order', 'pair', 'amount', 'price',
          'price-percent', 'yes', 'dryrun', 'debug',
        ]);
        await submitOrder(client, options, {
          stdout,
          confirm: dependencies.confirm ?? defaultConfirm,
        });
        return 0;
      default:
        throw new SafeTradeValidationError(
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
  const pair = normalizeDisplayPair(options.pair ?? DEFAULT_PAIR);
  const { base, quote } = splitPair(pair);
  const result = await client.getPrice(pair);
  stdout(`${pair}: 1 ${base} = ${result.price} ${quote} (last traded price)`);
}

async function printBalances(client, options, stdout) {
  const assets = String(options.coin ?? 'PRL')
    .split(',')
    .map(normalizeAsset);
  const balances = await client.getBalances({ coins: assets });
  const byAsset = new Map(balances.map((balance) => [balance.asset, balance]));

  stdout('ASSET\tTOTAL\tAVAILABLE\tLOCKED');
  for (const asset of assets) {
    const balance = byAsset.get(asset) ?? {
      total: '0',
      available: '0',
      locked: '0',
    };
    stdout(
      `${asset}\t${balance.total}\t${balance.available}\t${balance.locked}`,
    );
  }
}

async function submitOrder(client, options, { stdout, confirm }) {
  const pair = normalizeDisplayPair(options.pair ?? DEFAULT_PAIR);
  const { base, quote } = splitPair(pair);
  const type = normalizeChoice(options.type, 'type', ['market', 'limit']);
  const sideOption = resolveSideOption(options);
  const side = normalizeChoice(sideOption, 'side', ['buy', 'sell']);
  const amount = normalizePositiveDecimal(options.amount, 'amount');
  const hasPrice = options.price !== undefined;
  const hasPricePercent = options['price-percent'] !== undefined;

  if (hasPrice && hasPricePercent) {
    throw new SafeTradeValidationError(
      '--price and --price-percent are mutually exclusive',
    );
  }

  if (type === 'market' && (hasPrice || hasPricePercent)) {
    throw new SafeTradeValidationError(
      'Market orders must not use --price or --price-percent',
    );
  }

  if (type === 'limit' && !hasPrice && !hasPricePercent) {
    throw new SafeTradeValidationError(
      'A limit order requires exactly one of --price or --price-percent',
    );
  }

  let price;
  let marketPrice;

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

  if (side === 'sell') {
    const balance = await client.getBalance(base);
    const available = balance?.available ?? '0';
    if (compareDecimals(available, amount) < 0) {
      throw new SafeTradeValidationError(
        `Insufficient ${base} balance: ${available} available, ${amount} required`,
      );
    }
    stdout(`Balance check: ${available} ${base} available`);
  } else {
    if (!price) {
      marketPrice = marketPrice ?? await client.getPrice(pair);
    }
    const referencePrice = price ?? marketPrice.price;
    const requiredQuote = multiplyDecimals(amount, referencePrice);
    const balance = await client.getBalance(quote);
    const available = balance?.available ?? '0';
    if (compareDecimals(available, requiredQuote) < 0) {
      throw new SafeTradeValidationError(
        `Insufficient ${quote} balance: ${available} available, approximately ${requiredQuote} required`,
      );
    }
    stdout(
      `Balance check: ${available} ${quote} available; estimated principal ${requiredQuote} ${quote} (fees/slippage excluded)`,
    );
  }

  const summary = [
    side.toUpperCase(),
    amount,
    pair,
    type.toUpperCase(),
    price ? `@ ${price} ${quote}` : '',
  ].filter(Boolean).join(' ');
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

  const order = await client.createOrder({
    pair,
    side,
    type,
    amount,
    price,
  });
  const id = order?.id ?? order?.uuid ?? 'unknown';
  const state = order?.state ? `, state=${order.state}` : '';
  stdout(`Order submitted successfully: id=${id}${state}`);
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
      throw new SafeTradeValidationError(`Unexpected argument: ${argument}`);
    }

    const [rawName, inlineValue] = argument.slice(2).split(/=(.*)/s, 2);
    const name = rawName.trim();

    if (!name) {
      throw new SafeTradeValidationError('Invalid empty option');
    }

    if (Object.hasOwn(options, name)) {
      throw new SafeTradeValidationError(`Option --${name} was provided twice`);
    }

    if (BOOLEAN_OPTIONS.has(name)) {
      if (inlineValue !== undefined && !['true', 'false'].includes(inlineValue)) {
        throw new SafeTradeValidationError(
          `Boolean option --${name} accepts only true or false`,
        );
      }
      options[name] = inlineValue === undefined ? true : inlineValue === 'true';
      continue;
    }

    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new SafeTradeValidationError(`Option --${name} requires a value`);
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
    throw new SafeTradeValidationError(
      'Use either --side or the compatibility alias --order, not both',
    );
  }
  return options.side ?? options.order;
}

function normalizeChoice(value, name, allowed) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new SafeTradeValidationError(
      `--${name} is required and must be one of: ${allowed.join(', ')}`,
    );
  }
  return normalized;
}

function normalizeDisplayPair(value) {
  const { base, quote } = splitPair(value);
  return `${base}-${quote}`;
}

function splitPair(value) {
  const match = String(value ?? '').trim().toUpperCase().match(
    /^([A-Z0-9]+)[-_/]([A-Z0-9]+)$/,
  );
  if (!match) {
    throw new SafeTradeValidationError(
      'Pair must contain a separator, for example PRL-USDT',
    );
  }
  return { base: match[1], quote: match[2] };
}

function assertKnownOptions(options, allowed) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(options).find((name) => !allowedSet.has(name));
  if (unknown) {
    throw new SafeTradeValidationError(`Unknown option: --${unknown}`);
  }
}

function parseTimeout(value) {
  if (value === undefined || value === '') {
    return 15_000;
  }
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new SafeTradeValidationError(
      'SAFETRADE_TIMEOUT_MS must be a positive integer',
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
    throw new SafeTradeValidationError(
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

function formatCliError(error) {
  if (error instanceof SafeTradeApiError && error.code === 'CLOUDFLARE_BLOCKED') {
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
  return `SpotPilot ${VERSION} — SafeTrade spot trading CLI

Usage:
  node spotpilot <command> [options]

Commands:
  price      Show the last traded price (default pair: PRL-USDT)
  balance    Show total, available and locked balances
  order      Validate and submit a market or limit order

Examples:
  node spotpilot price --pair PRL-USDT
  node spotpilot balance --coin PRL,USDT
  node spotpilot order --type market --side sell --pair PRL-USDT --amount 10
  node spotpilot order --type limit --side sell --amount 10 --price-percent 10
  node spotpilot order --type limit --side sell --amount 10 --price 0,28 --dryrun

Run "node spotpilot <command> --help" for command-specific help.`;
}

function commandHelp(command) {
  const help = {
    price: `Usage: node spotpilot price [--pair PRL-USDT]`,
    balance: `Usage: node spotpilot balance [--coin PRL,USDT]`,
    order: `Usage: node spotpilot order --type market|limit --side buy|sell [options]

Options:
  --pair PRL-USDT       Trading pair (default: PRL-USDT)
  --amount 10           Base-asset amount; required
  --price 0.28          Exact limit price
  --price-percent 10    Limit price relative to last traded price
  --dryrun             Validate without submitting
  --yes                 Skip the interactive confirmation
  --order sell          Compatibility alias for --side sell`,
  };
  if (!help[command]) {
    throw new SafeTradeValidationError(`Unknown command: ${command}`);
  }
  return help[command];
}
