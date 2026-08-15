export function extractItems(payload, keys = []) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  for (const key of keys) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
    if (Array.isArray(payload?.data?.[key])) {
      return payload.data[key];
    }
  }

  return [];
}

export function normalizeAssetTransferStatus(asset, raw) {
  const depositEnabled = normalizeAvailability(firstDefined(raw, [
    'deposit_enabled',
    'can_deposit',
    'depositEnabled',
  ]));
  const withdrawalEnabled = normalizeAvailability(firstDefined(raw, [
    'withdraw_enabled',
    'withdrawal_enabled',
    'can_withdraw',
    'withdrawEnabled',
    'withdrawalEnabled',
  ]));
  const rawNetworks = [raw?.chains, raw?.networks]
    .find((value) => Array.isArray(value)) ?? [];

  return {
    asset,
    depositEnabled,
    withdrawalEnabled,
    networks: rawNetworks.map((network, index) => ({
      network: String(firstDefined(network, [
        'chain',
        'code',
        'network',
        'network_name',
        'name',
        'id',
      ]) ?? `network-${index + 1}`),
      depositEnabled: normalizeAvailability(firstDefined(network, [
        'deposit_enabled',
        'can_deposit',
        'depositEnabled',
      ])) ?? depositEnabled,
      withdrawalEnabled: normalizeAvailability(firstDefined(network, [
        'withdraw_enabled',
        'withdrawal_enabled',
        'can_withdraw',
        'withdrawEnabled',
        'withdrawalEnabled',
      ])) ?? withdrawalEnabled,
      raw: network,
    })),
    raw,
  };
}

export function normalizeAvailability(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 1) {
    return true;
  }
  if (value === 0) {
    return false;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'enabled', 'active', 'open', 'trading'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'disabled', 'inactive', 'closed', 'halted', 'suspended'].includes(normalized)) {
    return false;
  }
  return null;
}

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null) {
      return object[key];
    }
  }
  return undefined;
}
