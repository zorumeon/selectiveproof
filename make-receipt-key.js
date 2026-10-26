'use strict';

/*
 * Creates the Ed25519 key that signs receipts. Run it once and keep the key private.
 *
 *   node make-receipt-key.js
 *
 * It writes receipt-key.pem next to this script (or into DATA_DIR) and refuses to
 * overwrite an existing key, because replacing the key makes every older receipt invalid.
 * It prints the fingerprint (put it in the README) and the one-line value to paste
 * into the RECEIPT_KEY_PEM variable of your host.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.env.DATA_DIR || __dirname);
const file = path.join(dir, 'receipt-key.pem');
if (fs.existsSync(file)) {
  console.error(`${file} already exists. Not overwriting it: a new key would invalidate every receipt issued so far.`);
  process.exit(1);
}

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, pem, { mode: 0o600 });

// Same calculation as sp-server.js: first 16 hex characters of SHA-256 over the public key (SPKI DER).
const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const fingerprint = crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);

console.log(`Wrote ${file} (private, never commit it).`);
console.log(`Fingerprint: ${fingerprint}`);
console.log('');
console.log('For a host whose disk is wiped on restart, set this variable (one line, no quotes):');
console.log('RECEIPT_KEY_PEM=' + pem.trim().replace(/\n/g, '\\n'));
