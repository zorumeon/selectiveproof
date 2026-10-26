'use strict';

/*
 * SelectiveProof scanner (Zcash Testnet and Mainnet, chosen by the `network` argument and a matching lightwalletd URL).
 * Reads every INCOMING shielded note for a viewing key and returns only what a
 * proof needs: txid, block height, time, amount (ZEC), memo, pool and the note
 * commitment (cmx). It never returns the nullifier, rseed, rho, recipient or
 * spent status.
 *
 *   scan({ ufvk, birthday, cutoff, lightwalletd, network, signal }) => rows
 *   network: 'testnet' (default) or 'mainnet'. Needs @ledgerhq/zcash-utils 2.x (older
 *   0.x versions cannot read Ironwood notes and silently return nothing).
 *   rows: [{ txid, h, t, v, memo, pool, cmx }]
 */

const zcash = require('@ledgerhq/zcash-utils');

const TXID_RE = /^[0-9a-fA-F]{64}$/;
const UNREACHABLE = 'Cannot reach the Zcash server. Check your internet connection and try again.';
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UNAVAILABLE', 14]);

function publicError(message, cause) {
  const e = new Error(message);
  e.publicMessage = message;
  if (cause) e.cause = cause;
  return e;
}

function withTimeout(promise, ms, message) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(publicError(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function zatsToZec(zats) {
  // Amounts from the library should be integral zatoshi. Reject malformed values
  // instead of silently turning NaN/negative values into payment rows.
  const n = typeof zats === 'bigint' ? Number(zats) : Number(zats);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 21000000 * 1e8) return null;
  return n / 1e8;
}

function toMemoText(memo) {
  if (memo == null) return '';
  const s = (memo instanceof Uint8Array) ? Buffer.from(memo).toString('utf8') : String(memo);
  return s.replace(/\0/g, '').trim();
}

function toHex(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.toLowerCase();
  if (v instanceof Uint8Array || Array.isArray(v)) return Buffer.from(v).toString('hex');
  return '';
}

function toUnixSeconds(v) {
  if (v instanceof Date) v = v.getTime();
  else if (typeof v === 'string' && v.trim() !== '' && !/^\d+$/.test(v.trim())) v = Date.parse(v);
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const sec = n > 1e11 ? Math.round(n / 1000) : Math.round(n);
  return sec > 1.5e9 && sec < 4e9 ? sec : undefined;
}

// stream.next() can hang forever on a flaky lightwalletd. Racing it against the abort
// signal lets the server's timeout actually end the scan and free the "scanning" lock.
function nextOrAbort(stream, signal) {
  if (!signal) return Promise.resolve(stream.next());
  if (signal.aborted) return Promise.reject(new Error('Scan aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Scan aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(stream.next()).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

module.exports.scan = async ({ ufvk, birthday, cutoff, lightwalletd, network, signal }) => {
  let stream = null;
  try {
    const net = network === undefined || network === null ? 'testnet' : String(network);
    if (net !== 'testnet' && net !== 'mainnet') throw publicError('network must be testnet or mainnet.');
    const tip = await withTimeout(zcash.getChainTip(lightwalletd), 20000, UNREACHABLE);
    const currentBlock = typeof tip === 'object' ? tip.height : tip;
    const start = Number(birthday);
    const end = cutoff ? Number(cutoff) : currentBlock;
    if (Number.isFinite(currentBlock) && start > currentBlock) {
      throw publicError(`Birthday height ${start} is above the current chain height (${currentBlock}). Check the number.`);
    }

    stream = await withTimeout(
      zcash.startSync({ viewingKey: ufvk, grpcUrl: lightwalletd, startHeight: start, endHeight: end, network: net }),
      20000,
      UNREACHABLE
    );

    const rows = [];
    while (true) {
      if (signal && signal.aborted) {
        if (typeof stream.cancel === 'function') stream.cancel();
        throw new Error('Scan aborted');
      }
      const tx = await nextOrAbort(stream, signal);
      if (!tx || tx.done) break;

      const actual = tx.value !== undefined ? tx.value : tx;
      let txid;
      let details = actual;
      if (Array.isArray(actual) && actual.length === 2 && typeof actual[0] === 'string') {
        txid = actual[0];
        details = actual[1];
      } else {
        txid = actual.txid || actual.hash || actual.id;
      }

      const safeTxid = String(txid || '').trim().toLowerCase();
      if (!TXID_RE.test(safeTxid)) continue;

      const blockHeight = Number(details.blockHeight);
      if (!Number.isSafeInteger(blockHeight) || blockHeight < 1) continue;
      const notes = [].concat(details.saplingNotes || [], details.orchardNotes || [], details.ironwoodNotes || []);
      for (const note of notes) {
        if (!note || note.transferType !== 'incoming') continue;
        const amount = zatsToZec(note.amount);
        if (amount === null) continue;
        rows.push({
          txid: safeTxid,
          h: blockHeight,
          t: toUnixSeconds(details.blockTime),
          v: amount,
          memo: toMemoText(note.memo),
          pool: String(note.pool || ''),
          cmx: toHex(note.cmx),
        });
      }
    }
    rows.sort((a, b) => b.h - a.h);
    return rows;
  } catch (error) {
    const code = error && (error.code !== undefined ? error.code : error.errno);
    if (!error.publicMessage && NETWORK_CODES.has(code)) throw publicError(UNREACHABLE, error);
    throw error;
  } finally {
    if (stream && typeof stream.cancel === 'function') { try { stream.cancel(); } catch { /* already closed */ } }
  }
};
