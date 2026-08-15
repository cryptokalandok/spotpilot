import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureDnsResultOrder,
  normalizeDnsResultOrder,
} from '../src/network.js';
import { SpotPilotConfigError } from '../src/errors.js';

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
      assert.ok(error instanceof SpotPilotConfigError);
      assert.match(error.message, /ipv4first, ipv6first, verbatim/);
      return true;
    },
  );
});
