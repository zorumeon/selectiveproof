# SelectiveProof — ZECATHON demo & evidence runbook

## What the demo must prove
1. A merchant creates an invoice with a random `ZP-XXXXXX` reference.
2. The payer sends shielded testnet ZEC and includes that reference as a memo token.
3. SelectiveProof observes the incoming note through the merchant UFVK.
4. Enough value with fewer than the required confirmations is `CONFIRMING`, not `PAID`.
5. At the threshold (default 3 confirmations), the invoice becomes `PAID`.
6. Only then can the payer create a signed selective receipt.
7. Altering the receipt makes verification fail.

## Before the live demo
- Use Node.js 18+ and run `npm ci`, then `npm test`.
- Copy `.env.example` values into your shell; never commit a UFVK, seed phrase, spending key, admin token, or receipt private key.
- Set a testnet UFVK, birthday height, and receiving unified address.
- Keep `MIN_CONFIRMATIONS=3` unless the demo environment requires a documented alternative.
- Start with `npm start` and check `/api/health`.
- Record the testnet txid(s), invoice code, block height, observed status transitions, and final receipt verification result in the evidence table below.

## Runtime evidence table
| Test | Evidence to record | Expected |
|---|---|---|
| No payment | invoice screenshot/API result | PENDING |
| Underpay | txid + amount + status | PARTIAL |
| Full amount, <3 conf | txid + tip/height + status | CONFIRMING; receipt rejected |
| Full amount, >=3 conf | txid + tip/height + status | PAID; receipt allowed |
| Tampered receipt | changed token + verifier result | INVALID |
| Wrong memo | txid + memo/reference mismatch | invoice unchanged |
| Multi-payment | all txids + totals | PAID; no misleading single txid |
| Leak check | grep/API/browser inspection | no UFVK/raw memo/private key leak |

## Privacy inspection commands
From the project directory, after a test run:

    grep -Rni --exclude-dir=node_modules --exclude='receipt-key.pem' 'uviewtest1' .
    grep -Rni --exclude-dir=node_modules 'your-raw-memo-text' .

Expected: the real UFVK/raw memo must not appear in persisted app data, HTML, logs, or receipt output. A placeholder in documentation is not a leak.

## Claims for judges
Safe: “SelectiveProof observes merchant-visible incoming shielded payments, waits for confirmation finality, then signs only the receipt fields the payer elects to disclose.”

Do not say: “This is a standalone zero-knowledge proof of Zcash consensus,” “the recipient address is cryptographically proven by the receipt,” or “reorg handling is proven” unless the corresponding runtime evidence has actually been produced.
