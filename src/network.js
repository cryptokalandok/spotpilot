import { setDefaultResultOrder } from 'node:dns';
import { ProxyAgent } from 'undici';
import { SpotPilotConfigError } from './errors.js';

export const DEFAULT_DNS_RESULT_ORDER = 'ipv4first';
export const SUPPORTED_DNS_RESULT_ORDERS = Object.freeze([
  'ipv4first',
  'ipv6first',
  'verbatim',
]);

export function normalizeDnsResultOrder(value) {
  const normalized = String(value ?? DEFAULT_DNS_RESULT_ORDER)
    .trim()
    .toLowerCase();

  if (!SUPPORTED_DNS_RESULT_ORDERS.includes(normalized)) {
    throw new SpotPilotConfigError(
      'SPOTPILOT_DNS_RESULT_ORDER must be one of: ' +
      SUPPORTED_DNS_RESULT_ORDERS.join(', '),
    );
  }

  return normalized;
}

export function configureDnsResultOrder(
  value,
  setResultOrder = setDefaultResultOrder,
) {
  const resultOrder = normalizeDnsResultOrder(value);
  setResultOrder(resultOrder);
  return resultOrder;
}

export function normalizeProxyUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  let url;
  try {
    url = new URL(String(value).trim());
  } catch (cause) {
    throw new SpotPilotConfigError(
      'SPOTPILOT_PROXY_URL must be a valid HTTP or HTTPS proxy URL',
      { cause },
    );
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SpotPilotConfigError(
      'SPOTPILOT_PROXY_URL must use the http: or https: protocol',
    );
  }
  if (!url.hostname) {
    throw new SpotPilotConfigError(
      'SPOTPILOT_PROXY_URL must include a proxy hostname',
    );
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new SpotPilotConfigError(
      'SPOTPILOT_PROXY_URL must not include a path, query or fragment',
    );
  }

  return url.toString();
}

export function createProxyFetch(
  proxyUrl,
  {
    fetchImpl = globalThis.fetch,
    proxyAgentFactory = (url) => new ProxyAgent(url),
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new SpotPilotConfigError('A fetch implementation is required');
  }
  if (typeof proxyAgentFactory !== 'function') {
    throw new SpotPilotConfigError('proxyAgentFactory must be a function');
  }

  const normalized = normalizeProxyUrl(proxyUrl);
  if (normalized === null) {
    return fetchImpl;
  }

  const dispatcher = proxyAgentFactory(normalized);
  return (input, init = {}) => fetchImpl(input, {
    ...init,
    dispatcher,
  });
}
