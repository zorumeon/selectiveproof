'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { base64url, formatAmount, paymentUri } = require('../sp-zip321');

test('ZIP-321 memo uses unpadded base64url', () => {
  assert.equal(base64url('ZP-XJDCWX'), 'WlAtWEpEQ1dY');
  assert.ok(!base64url('ZP-XJDCWX').includes('='));
});

test('ZIP-321 amount is canonical with at most 8 decimals', () => {
  assert.equal(formatAmount(0.01), '0.01');
  assert.equal(formatAmount(1), '1');
  assert.equal(formatAmount(1.23000000), '1.23');
  assert.equal(formatAmount(0.00000001), '0.00000001');
});

test('ZIP-321 payment URI contains address, amount and memo', () => {
  assert.equal(
    paymentUri({
      address: 'utest1example',
      amount: 0.01,
      code: 'ZP-XJDCWX',
    }),
    'zcash:utest1example?amount=0.01&memo=WlAtWEpEQ1dY'
  );
});

test('ZIP-321 payment URI fails closed on missing data', () => {
  assert.throws(
    () => paymentUri({ amount: 0.01, code: 'ZP-XJDCWX' }),
    /Missing payment address/
  );

  assert.throws(
    () => paymentUri({ address: 'utest1example', amount: 0.01 }),
    /Missing invoice memo code/
  );

  assert.throws(
    () => paymentUri({
      address: 'utest1example',
      amount: 0,
      code: 'ZP-XJDCWX',
    }),
    /Invalid payment amount/
  );
});
