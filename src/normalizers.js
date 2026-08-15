import { SafeTradeValidationError } from './errors.js';

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function normalizeMarket(pair) {
  if (typeof pair !== 'string' || pair.trim() === '') {
    throw new SafeTradeValidationError('pair must be a non-empty string');
  }

  const market = pair.trim().toLowerCase().replace(/[-_/\s]/g, '');

  if (!/^[a-z0-9]+$/.test(market)) {
    throw new SafeTradeValidationError(`Invalid pair: ${pair}`);
  }

  return market;
}

export function normalizeAsset(asset) {
  if (typeof asset !== 'string' || asset.trim() === '') {
    throw new SafeTradeValidationError('asset must be a non-empty string');
  }

  const normalized = asset.trim().toUpperCase();

  if (!/^[A-Z0-9]+$/.test(normalized)) {
    throw new SafeTradeValidationError(`Invalid asset: ${asset}`);
  }

  return normalized;
}

export function normalizePositiveDecimal(value, fieldName) {
  const normalized = String(value).trim().replace(',', '.');

  if (!DECIMAL_PATTERN.test(normalized) || /^0(?:\.0+)?$/.test(normalized)) {
    throw new SafeTradeValidationError(
      `${fieldName} must be a positive decimal number`,
    );
  }

  return normalized;
}

export function normalizeBalancesPayload(payload) {
  const balances = extractArray(payload, ['balances', 'accounts', 'data']);

  return balances.map((balance) => {
    const asset = normalizeAsset(
      balance.currency ??
      balance.currency_code ??
      balance.code ??
      balance.asset,
    );
    const available = decimalString(
      balance.available ?? balance.balance ?? balance.free ?? '0',
    );
    const locked = decimalString(
      balance.locked ?? balance.hold ?? balance.frozen ?? '0',
    );
    const total = decimalString(
      balance.total ?? addDecimalStrings(available, locked),
    );

    return Object.freeze({
      asset,
      total,
      available,
      locked,
      raw: balance,
    });
  });
}

export function extractLastPrice(payload) {
  const candidates = [
    payload?.ticker?.last,
    payload?.ticker?.last_price,
    payload?.ticker?.close,
    payload?.last,
    payload?.last_price,
    payload?.close,
    payload?.price,
    payload?.data?.ticker?.last,
    payload?.data?.last,
  ];
  const value = candidates.find(
    (candidate) => candidate !== undefined && candidate !== null,
  );

  if (value === undefined) {
    throw new SafeTradeValidationError(
      'SafeTrade ticker response did not contain a last price',
    );
  }

  return decimalString(value);
}

function extractArray(payload, keys) {
  if (Array.isArray(payload)) {
    return payload;
  }

  for (const key of keys) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
  }

  throw new SafeTradeValidationError(
    'SafeTrade response did not contain a balance array',
  );
}

function decimalString(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new SafeTradeValidationError(`Invalid decimal value: ${value}`);
  }

  const normalized = String(value).trim();

  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    throw new SafeTradeValidationError(`Invalid decimal value: ${value}`);
  }

  return normalized;
}

function addDecimalStrings(left, right) {
  const [leftInteger, leftFraction = ''] = left.split('.');
  const [rightInteger, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftScaled = BigInt(leftInteger + leftFraction.padEnd(scale, '0'));
  const rightScaled = BigInt(rightInteger + rightFraction.padEnd(scale, '0'));
  const sum = (leftScaled + rightScaled).toString().padStart(scale + 1, '0');

  if (scale === 0) {
    return sum;
  }

  const integer = sum.slice(0, -scale);
  const fraction = sum.slice(-scale).replace(/0+$/, '');
  return fraction === '' ? integer : `${integer}.${fraction}`;
}
