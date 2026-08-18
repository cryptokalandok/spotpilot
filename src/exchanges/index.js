import { SafeTradeClient } from '../client.js';
import {
  HozamoConfigError,
  HozamoValidationError,
} from '../errors.js';
import { createProxyFetch } from '../network.js';
import { CoinExClient } from './coinex.js';

export const SUPPORTED_EXCHANGES = Object.freeze(['safetrade', 'coinex']);

export function normalizeExchangeName(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[-_\s]/g, '');
  const aliases = {
    safetrade: 'safetrade',
    coinex: 'coinex',
  };
  const exchange = aliases[normalized];
  if (!exchange) {
    throw new HozamoValidationError(
      `Unsupported exchange: ${value}. Supported: ${SUPPORTED_EXCHANGES.join(', ')}`,
    );
  }
  return exchange;
}

export function createExchangeClient({
  exchange = 'safetrade',
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  now = Date.now,
} = {}) {
  const normalized = normalizeExchangeName(exchange);

  if (!env || typeof env !== 'object') {
    throw new HozamoConfigError('env must be an object');
  }

  const requestFetch = createProxyFetch(env.HOZAMO_PROXY_URL, {
    fetchImpl,
  });

  if (normalized === 'coinex') {
    return new CoinExClient({
      apiKey: env.COINEX_API_KEY,
      apiSecret: env.COINEX_API_SECRET,
      baseUrl: env.COINEX_BASE_URL,
      windowTimeMs: parseOptionalPositiveInteger(
        env.COINEX_WINDOW_TIME_MS,
        'COINEX_WINDOW_TIME_MS',
      ),
      fetchImpl: requestFetch,
      timeoutMs,
      now,
    });
  }

  return new SafeTradeClient({
    apiKey: env.SAFETRADE_API_KEY,
    apiSecret: env.SAFETRADE_API_SECRET,
    baseUrl: env.SAFETRADE_BASE_URL,
    fetchImpl: requestFetch,
    timeoutMs,
    now,
  });
}

function parseOptionalPositiveInteger(value, name) {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HozamoConfigError(`${name} must be a positive integer`);
  }
  return parsed;
}
