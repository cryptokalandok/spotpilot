import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureDnsResultOrder,
  createProxyFetch,
  normalizeDnsResultOrder,
  normalizeProxyUrl,
} from '../src/network.js';
import { HozamoConfigError } from '../src/errors.js';

test('DNS result order defaults to IPv4 first', () => {
  const calls = [];
  const result = configureDnsResultOrder(undefined, (value) => calls.push(value));

  assert.equal(result, 'ipv4first');
  assert.deepEqual(calls, ['ipv4first']);
});

test('DNS result order can restore the Node resolver order', () => {
  assert.equal(normalizeDnsResultOrder(' VERBATIM '), 'verbatim');
  assert.equal(normalizeDnsResultOrder('ipv6first'), 'ipv6first');
});

test('invalid DNS result order is rejected', () => {
  assert.throws(
    () => normalizeDnsResultOrder('ipv4'),
    (error) => {
      assert.ok(error instanceof HozamoConfigError);
      assert.match(error.message, /ipv4first, ipv6first, verbatim/);
      return true;
    },
  );
});

test('proxy URL is optional and supports authenticated HTTP(S) proxies', () => {
  assert.equal(normalizeProxyUrl(undefined), null);
  assert.equal(normalizeProxyUrl('  '), null);
  assert.equal(
    normalizeProxyUrl(' https://user:p%40ss@proxy.example.com:8443 '),
    'https://user:p%40ss@proxy.example.com:8443/',
  );
});

test('proxy URL rejects unsupported protocols and URL paths', () => {
  assert.throws(
    () => normalizeProxyUrl('socks5://proxy.example.com:1080'),
    HozamoConfigError,
  );
  assert.throws(
    () => normalizeProxyUrl('https://proxy.example.com:8443/path'),
    HozamoConfigError,
  );
});

test('proxy fetch returns the direct implementation when proxy is unset', () => {
  const directFetch = async () => new Response('ok');
  const result = createProxyFetch('', {
    fetchImpl: directFetch,
    proxyAgentFactory: () => {
      throw new Error('proxy agent must not be created');
    },
  });

  assert.equal(result, directFetch);
});

test('proxy fetch adds one shared dispatcher to every request', async () => {
  const calls = [];
  const dispatcher = { dispatch() {} };
  const proxyUrls = [];
  const proxyFetch = createProxyFetch(
    'https://user:secret@proxy.example.com:8443',
    {
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response('ok');
      },
      proxyAgentFactory: (url) => {
        proxyUrls.push(url);
        return dispatcher;
      },
    },
  );

  await proxyFetch('https://safe.trade/api/v2/test', { method: 'GET' });
  await proxyFetch('https://api.coinex.com/v2/test', { method: 'POST' });

  assert.deepEqual(proxyUrls, [
    'https://user:secret@proxy.example.com:8443/',
  ]);
  assert.equal(calls[0].init.dispatcher, dispatcher);
  assert.equal(calls[1].init.dispatcher, dispatcher);
});
