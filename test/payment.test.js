'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateInvoicePayment, memoHasInvoiceCode } = require('../sp-payment');

const code = 'ZP-ABC234';
const tx = (c) => c.repeat(64);
const row = (v, h, memo = code, id = 'a') => ({ txid: tx(id), h, t: 1700000000, v, memo });
const evalAt = (rows, tip = 100, amount = 1) => evaluateInvoicePayment({ rows, code, amount, tip, minConfirmations: 3 });

test('no payment -> pending', () => assert.equal(evalAt([]).status, 'pending'));
test('underpayment -> partial', () => assert.equal(evalAt([row(0.5, 98)]).status, 'partial'));
test('exact payment at 1 confirmation -> confirming', () => {
  const r = evalAt([row(1, 100)]); assert.equal(r.status, 'confirming'); assert.equal(r.confirmations, 1); assert.equal(r.confirmedReceived, 0);
});
test('exact payment below threshold -> confirming', () => assert.equal(evalAt([row(1, 99)]).status, 'confirming'));
test('exact payment at threshold -> paid', () => {
  const r = evalAt([row(1, 98)]); assert.equal(r.status, 'paid'); assert.equal(r.confirmedReceived, 1); assert.equal(r.txid, tx('a'));
});
test('multiple confirmed payments can satisfy invoice but do not claim one txid', () => {
  const r = evalAt([row(0.4, 97, code, 'a'), row(0.6, 98, code, 'b')]);
  assert.equal(r.status, 'paid'); assert.equal(r.txid, null); assert.equal(r.paidHeight, null);
});
test('previous payment disappearing evaluates back to pending', () => assert.equal(evalAt([]).status, 'pending'));
test('matching code embedded in a longer alphanumeric token is rejected', () => {
  assert.equal(memoHasInvoiceCode('PAY-XZP-ABC234Y-END', code), false);
  assert.equal(evalAt([row(1, 98, 'PAY-XZP-ABC234Y-END')]).status, 'pending');
});
test('code with punctuation boundaries is accepted', () => assert.equal(memoHasInvoiceCode(`invoice:${code};thanks`, code), true));
test('unknown chain tip fails closed', () => {
  const r = evalAt([row(1, 98)], null); assert.equal(r.status, 'confirming'); assert.equal(r.confirmedReceived, 0);
});
test('malformed txid/height/amount cannot count as payment', () => {
  const bad = [
    { txid: 'bad', h: 98, v: 1, memo: code },
    { txid: tx('a'), h: 0, v: 1, memo: code },
    { txid: tx('b'), h: 98, v: -1, memo: code },
  ];
  assert.equal(evalAt(bad).status, 'pending');
});
