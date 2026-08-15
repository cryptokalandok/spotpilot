import { createHmac } from 'node:crypto';
import {
  SafeTradeApiError,
  SafeTradeConfigError,
  SafeTradeValidationError,
} from './errors.js';
import {
  extractLastPrice,
  normalizeAsset,
  normalizeBalancesPayload,
  normalizeMarket,
  normalizePositiveDecimal,
} from './normalizers.js';
import {
  extractItems,
  normalizeAssetTransferStatus,
} from './status.js';

export const DEFAULT_BASE_URL = 'https://safe.trade/api/v2';

export function createSignature({ nonce, apiKey, apiSecret }) {
  return createHmac('sha256', apiSecret)
    .update(`${nonce}${apiKey}`)
    .digest('hex');
}

export class SafeTradeClient {
  exchange = 'safetrade';
  displayName = 'SafeTrade';

  #apiKey;
  #apiSecret;
  #baseUrl;
  #fetch;
  #timeoutMs;
  #nextNonce;

  constructor({
    apiKey,
    apiSecret,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
    now = Date.now,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new SafeTradeConfigError(
        'A fetch implementation is required (Node.js 20 or newer is recommended)',
      );
    }

    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new SafeTradeConfigError('timeoutMs must be a positive integer');
    }

    this.#apiKey = apiKey;
    this.#apiSecret = apiSecret;
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#nextNonce = createMonotonicNonce(now);
  }

  async getMarkets(options = {}) {
    return this.#request('/trade/public/markets', {
      signal: options.signal,
    });
  }

  async getCurrencies(options = {}) {
    return this.#request('/trade/public/currencies', {
      signal: options.signal,
    });
  }

  async getAssetStatuses(coins, options = {}) {
    if (coins === undefined) {
      throw new SafeTradeValidationError('coins is required');
    }
    const assets = normalizeCoinList(coins);
    const currenciesPayload = await this.getCurrencies({
      signal: options.signal,
    });
    const currencies = extractItems(currenciesPayload, ['currencies']);

    return assets.map((asset) => {
      const currency = currencies.find(
        (item) => safeTradeAssetCode(item) === asset,
      );
      if (!currency) {
        throw new SafeTradeApiError(
          `SafeTrade returned no currency status for ${asset}`,
          {
            exchange: 'safetrade',
            response: currenciesPayload,
            code: 'CURRENCY_NOT_FOUND',
          },
        );
      }
      return normalizeAssetTransferStatus(asset, currency);
    });
  }

  async getTicker(pair, options = {}) {
    const market = normalizeMarket(pair);
    return this.#request(`/trade/public/tickers/${market}`, {
      signal: options.signal,
    });
  }

  async getPrice(pair, options = {}) {
    const ticker = await this.getTicker(pair, options);
    return {
      pair,
      market: normalizeMarket(pair),
      price: extractLastPrice(ticker),
      ticker,
    };
  }

  async getBalances({ coins, signal } = {}) {
    const payload = await this.#request('/trade/account/balances/spot', {
      auth: true,
      signal,
    });
    const balances = normalizeBalancesPayload(payload);

    if (coins === undefined) {
      return balances;
    }

    const requested = new Set(normalizeCoinList(coins));
    return balances.filter(({ asset }) => requested.has(asset));
  }

  async getBalance(coin, options = {}) {
    const asset = normalizeAsset(coin);
    const balances = await this.getBalances({
      coins: [asset],
      signal: options.signal,
    });
    return balances.find((balance) => balance.asset === asset) ?? null;
  }

  async getOrders({ state, pair, signal } = {}) {
    return this.#request('/trade/market/orders', {
      auth: true,
      query: {
        state,
        market: pair === undefined ? undefined : normalizeMarket(pair),
      },
      signal,
    });
  }

  async createOrder({
    pair,
    side,
    type,
    amount,
    price,
    signal,
  }) {
    const market = normalizeMarket(pair);
    const normalizedSide = normalizeEnum(side, 'side', ['buy', 'sell']);
    const normalizedType = normalizeEnum(type, 'type', ['market', 'limit']);
    const normalizedAmount = normalizePositiveDecimal(amount, 'amount');

    if (normalizedType === 'limit' && price === undefined) {
      throw new SafeTradeValidationError('price is required for a limit order');
    }

    if (normalizedType === 'market' && price !== undefined) {
      throw new SafeTradeValidationError(
        'price must not be provided for a market order',
      );
    }

    const body = {
      market,
      side: normalizedSide,
      amount: normalizedAmount,
      type: normalizedType,
    };

    if (price !== undefined) {
      body.price = normalizePositiveDecimal(price, 'price');
    }

    return this.#request('/trade/market/orders', {
      method: 'POST',
      auth: true,
      body,
      signal,
    });
  }

  async #request(path, {
    method = 'GET',
    query,
    body,
    auth = false,
    signal,
  } = {}) {
    const url = new URL(path.replace(/^\//, ''), `${this.#baseUrl}/`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = { Accept: 'application/json' };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json;charset=utf-8';
    }

    if (auth) {
      headers['Content-Type'] = 'application/json;charset=utf-8';
      Object.assign(headers, this.#authenticationHeaders());
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), this.#timeoutMs);
    const abortFromCaller = () => controller.abort(signal.reason);

    if (signal) {
      if (signal.aborted) {
        abortFromCaller();
      } else {
        signal.addEventListener('abort', abortFromCaller, { once: true });
      }
    }

    try {
      const response = await this.#fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await parseResponse(response);

      if (!response.ok) {
        if (isCloudflareBlock(response, payload)) {
          const rayId = response.headers.get('cf-ray');
          throw new SafeTradeApiError(
            'SafeTrade API request was blocked by Cloudflare',
            {
              exchange: 'safetrade',
              status: response.status,
              method,
              url: url.toString(),
              response: {
                cloudflare: true,
                bodyPreview: String(payload).slice(0, 300),
              },
              code: 'CLOUDFLARE_BLOCKED',
              rayId,
            },
          );
        }
        throw new SafeTradeApiError(
          apiErrorMessage(response.status, payload),
          {
            exchange: 'safetrade',
            status: response.status,
            method,
            url: url.toString(),
            response: payload,
          },
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof SafeTradeApiError) {
        throw error;
      }

      if (controller.signal.aborted) {
        const timedOut = controller.signal.reason === 'timeout';
        throw new SafeTradeApiError(
          timedOut ? 'SafeTrade request timed out' : 'SafeTrade request was aborted',
          {
            exchange: 'safetrade',
            method,
            url: url.toString(),
            code: timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED',
            cause: error,
          },
        );
      }

      throw new SafeTradeApiError('SafeTrade request failed', {
        exchange: 'safetrade',
        method,
        url: url.toString(),
        code: 'NETWORK_ERROR',
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  #authenticationHeaders() {
    if (!this.#apiKey || !this.#apiSecret) {
      throw new SafeTradeConfigError(
        'apiKey and apiSecret are required for private SafeTrade endpoints',
      );
    }

    const nonce = this.#nextNonce();
    return {
      'X-Auth-Apikey': this.#apiKey,
      'X-Auth-Nonce': nonce,
      'X-Auth-Signature': createSignature({
        nonce,
        apiKey: this.#apiKey,
        apiSecret: this.#apiSecret,
      }),
    };
  }
}

function createMonotonicNonce(now) {
  let previous = 0n;

  return () => {
    const current = BigInt(now());
    previous = current > previous ? current : previous + 1n;
    return previous.toString();
  };
}

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new SafeTradeConfigError('baseUrl must be a non-empty URL');
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new SafeTradeConfigError('baseUrl must be a valid URL', { cause });
  }

  return url.toString().replace(/\/$/, '');
}

function normalizeEnum(value, fieldName, allowed) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new SafeTradeValidationError(
      `${fieldName} must be one of: ${allowed.join(', ')}`,
    );
  }
  return normalized;
}

function normalizeCoinList(coins) {
  const values = Array.isArray(coins) ? coins : String(coins).split(',');
  return values.map(normalizeAsset);
}

function safeTradeAssetCode(currency) {
  const value = currency?.code ?? currency?.id ?? currency?.currency;
  try {
    return value === undefined ? null : normalizeAsset(String(value));
  } catch {
    return null;
  }
}

async function parseResponse(response) {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (text === '') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function apiErrorMessage(status, payload) {
  const detail =
    payload?.errors?.join?.(', ') ??
    payload?.error ??
    payload?.message ??
    (typeof payload === 'string' ? payload : null);
  const safeDetail = detail ? String(detail).slice(0, 500) : null;
  return safeDetail
    ? `SafeTrade API returned HTTP ${status}: ${safeDetail}`
    : `SafeTrade API returned HTTP ${status}`;
}

function isCloudflareBlock(response, payload) {
  if (response.status !== 403) {
    return false;
  }
  const text = typeof payload === 'string' ? payload : '';
  return Boolean(
    response.headers.get('cf-ray') ||
    /cloudflare|attention required|sorry, you have been blocked/i.test(text),
  );
}
