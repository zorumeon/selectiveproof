# SelectiveProof security & privacy audit checklist

## Claims that are safe to make
- The merchant scans incoming shielded notes with a UFVK kept in server memory.
- Invoice matching uses a random invoice reference carried in the encrypted Zcash memo.
- An observed payment is not final immediately: the server requires `MIN_CONFIRMATIONS` (default 3).
- Signed receipts use Ed25519 and reveal only the fields selected by the buyer.
- Receipt verification checks both the signature and the merchant's current invoice record.

## Claims NOT to make
- Do not call the receipt a standalone Zcash consensus proof.
- Do not claim recipient-address cryptographic binding until it is explicitly implemented and tested.
- Do not claim reorg resistance beyond the actual rescan behavior and test evidence.
- Testnet claims must be limited to behavior actually observed during QA; do not generalize Testnet results into production or Mainnet guarantees.

## Leak review
- UFVK: memory only; never include in JSON responses, logs, HTML, URLs, receipts, or invoices.json.
- Memo text: scanner input only; never persist or return raw memo text from invoice APIs.
- Spending keys / seed phrases: never accepted.
- Public invoice capability URL exposes amount, description, receiving address, invoice code, status and optional txid/time after final payment. Treat the URL as a secret capability.
- `invoices.json` contains merchant invoice metadata and must not be web-served.
- `receipt-key.pem` is secret and must never be web-served or committed.

## Required adversarial tests
1. Exact payment, 0 confirmations -> CONFIRMING, receipt rejected.
2. Exact payment, below threshold -> CONFIRMING, receipt rejected.
3. Exact payment, threshold reached -> PAID, receipt allowed.
4. Underpayment -> PARTIAL.
5. Multiple payments whose confirmed total reaches target -> PAID; do not show one txid as representing all payments.
6. Payment disappears on a later rescan -> state must fall back from PAID.
7. Memo containing the code only as part of a longer alphanumeric token -> must not match.
8. Modified receipt payload/signature -> INVALID.
9. Search logs, API responses and invoices.json for UFVK and raw memo contents -> no leak.

## Verified regression and Testnet status
Run `npm test`. Final QA recorded **14 passed, 0 failed**.

Automated coverage includes pending, partial, confirming, paid, multi-payment handling, disappearing-payment fallback, memo-token boundaries, unknown-tip fail-closed behavior, malformed scan rows, and selective-disclosure regression checks for the Invoice field and copied receipt text.

Live Zcash Testnet QA also verified:
- An exact **0.01 TAZ** payment with the correct invoice memo reached **PAID** after confirmation.
- A **0.005 TAZ** payment against a **0.01 TAZ** invoice produced **PARTIAL**.
- A **0.001 TAZ** payment sent to the merchant address with the wrong memo did not match the target invoice, which remained **PENDING** with **0 TAZ** received.
- With Invoice, Description, Code, Address, and TXID hidden, copied receipt text omitted those fields.
- The merchant UFVK input is masked by default and cleared from the browser field after a successful session request.
- A source-tree scan found no persisted real Testnet UFVK pattern outside dependencies/placeholders.

These results are evidence for the specific application behavior exercised during QA. They do not establish production security, Mainnet safety, recipient-address cryptographic binding, or a standalone Zcash consensus proof.
