'use strict';

const TXID_RE = /^[0-9a-f]{64}$/i;

function toZats(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 21000000 || Math.abs(Math.round(n * 1e8) / 1e8 - n) > 1e-8) return null;
  const z = Math.round(n * 1e8);
  return Number.isSafeInteger(z) ? z : null;
}

function memoHasInvoiceCode(memo, code) {
  const text = String(memo || '').toUpperCase();
  const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Z0-9])${escaped}(?:$|[^A-Z0-9])`).test(text);
}

function evaluateInvoicePayment({ rows, code, amount, tip, minConfirmations }) {
  const mine = rows.filter((r) => memoHasInvoiceCode(r.memo, code));
  const validMine = mine.filter((r) => {
    const z = toZats(r.v);
    return typeof r.txid === 'string' && TXID_RE.test(r.txid) && Number.isInteger(r.h) && r.h > 0 && z !== null && z > 0;
  });
  const sumZats = validMine.reduce((a, r) => a + toZats(r.v), 0);
  const targetZats = toZats(amount);
  if (targetZats === null || targetZats <= 0 || !Number.isSafeInteger(sumZats)) throw new Error('Invalid invoice/payment amount data.');

  const withConf = validMine.map((r) => ({ ...r, conf: Number.isInteger(tip) && tip >= r.h ? tip - r.h + 1 : 0 }));
  const confirmed = withConf.filter((r) => r.conf >= minConfirmations);
  const confirmedZats = confirmed.reduce((a, r) => a + toZats(r.v), 0);
  const finalRows = confirmedZats >= targetZats ? confirmed : [];
  const txids = [...new Set(finalRows.map((r) => r.txid.toLowerCase()))];

  let txid = null, paidHeight = null, paidTime = null;
  if (txids.length === 1) {
    const txRows = finalRows.filter((r) => r.txid.toLowerCase() === txids[0]);
    const first = txRows.slice().sort((a, b) => a.h - b.h)[0];
    txid = txids[0]; paidHeight = first.h; paidTime = first.t || null;
  }

  let status = 'pending';
  if (confirmedZats >= targetZats) status = 'paid';
  else if (sumZats >= targetZats) status = 'confirming';
  else if (sumZats > 0) status = 'partial';

  // For UI, show confirmations of the least-confirmed observed matching note.
  // This is conservative and never overstates finality.
  const confirmations = withConf.length ? Math.min(...withConf.map((r) => r.conf)) : 0;
  return { status, received: sumZats / 1e8, confirmedReceived: confirmedZats / 1e8, confirmations, txid, paidHeight, paidTime };
}

module.exports = { toZats, memoHasInvoiceCode, evaluateInvoicePayment };
