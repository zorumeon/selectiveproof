'use strict';

function base64url(text) {
  return Buffer.from(String(text), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function formatAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid payment amount.');

  const s = n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new Error('Invalid ZIP-321 amount.');
  return s;
}

function paymentUri(invoice) {
  if (!invoice || typeof invoice.address !== 'string' || !invoice.address.trim()) {
    throw new Error('Missing payment address.');
  }
  if (typeof invoice.code !== 'string' || !invoice.code.trim()) {
    throw new Error('Missing invoice memo code.');
  }

  const address = invoice.address.trim();
  const amount = formatAmount(invoice.amount);
  const memo = base64url(invoice.code.trim());

  return `zcash:${address}?amount=${amount}&memo=${memo}`;
}

module.exports = { base64url, formatAmount, paymentUri };
