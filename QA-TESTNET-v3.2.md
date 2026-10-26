# SelectiveProof v3.2 — testnet QA checklist

Use this before any mainnet use. Do not share a viewing key, seed phrase, private key, admin token, or `receipt-key.pem`.

## 1. Install and start

1. Install Node.js 18 or newer.
2. Open PowerShell in the project folder.
3. Run `npm install`.
4. Run `npm ls @ledgerhq/zcash-utils`; confirm a 2.x version is installed (package lock targets 2.8.0).
5. Run `npm start` and open `http://127.0.0.1:8788/checkout`.
6. Confirm the startup log does not say `Scanner: not installed`.

## 2. Safe, no-payment checks

- Open `/`, `/checkout`, `/pay`, and `/receipt`; check that each page loads.
- Create a testnet merchant session with a testnet viewing key and matching testnet receiving address.
- Try an invalid key, a mainnet key while Testnet is selected, an invalid starting block height, and an amount with more than 8 decimal places. Each should be rejected with a clear error.
- Create an invoice and confirm it starts as `pending` with a unique `ZP-XXXXXX` code.
- Restart the server and confirm the receipt-key fingerprint is unchanged. Do not delete `receipt-key.pem`.
- Confirm local mode refuses `HOST=0.0.0.0` unless public mode is configured.

## 3. Controlled testnet payment

Only use testnet funds. Send a small testnet payment to the displayed receiving address and include the exact invoice memo code. Wait for the scanner to run, then use “Check now” if available.

Acceptance criteria:
- Wrong memo code does not match the invoice.
- A code embedded inside a longer alphanumeric word does not match.
- Exact memo code and valid incoming note update `received` and status.
- Invalid scan rows cannot create a paid invoice.
- If the invoice is paid using multiple transactions, the UI must not present a single transaction as if it represented the whole payment.
- A receipt verifies only while its invoice record and signing key remain consistent.

## 4. Evidence to capture

Record Node version, installed `@ledgerhq/zcash-utils` version, startup log (remove private details), testnet invoice status, and the result of receipt verification. Never include keys or tokens.

## 5. Verified test results

The following checks were performed on Zcash Testnet during final QA:

- Automated test suite: **14 passed, 0 failed**.
- A real shielded Testnet payment of **0.01 TAZ** with the exact invoice memo was detected through the merchant viewing-key scanner and reached **paid** status after confirmation.
- A real **0.005 TAZ** payment against a **0.01 TAZ** invoice produced **partial** status and did not claim a single final TXID or paid height.
- A real **0.001 TAZ** payment sent to the merchant address with the wrong memo code did **not** match the target invoice; it remained **pending** with **0 TAZ** received.
- Selective receipt disclosure was manually checked with Invoice, Description, Code, Address, and TXID hidden. The copied receipt omitted those fields.
- Automated regression tests verify that Invoice has a selective-disclosure control, the rendered Invoice row obeys that control, and clipboard output only includes the Invoice ID when explicitly revealed.
- A source-tree scan found no persisted Testnet UFVK matching the real `uviewtest1...` key pattern outside dependencies/placeholders.
- `receipt-key.pem`, `invoices.json`, `.env`, PEM files, logs, and `node_modules` are excluded from version control and must also be excluded from the submission archive.

## Important limitations

These results demonstrate the tested SelectiveProof workflow on Zcash Testnet; they do not make the application production-ready or constitute a standalone Zcash consensus proof. The merchant scanner uses a UFVK and therefore can observe incoming shielded payment information available to that viewing key, although it cannot spend funds. Receipt evidence is merchant-observed and merchant-signed. Public block explorers can independently show transaction existence/confirmation but cannot reveal or independently prove the shielded amount, recipient, or memo. Mainnet use was not part of this final QA and should not be inferred from the Testnet results.
