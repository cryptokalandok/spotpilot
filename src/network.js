import { setDefaultResultOrder } from 'node:dns';
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
