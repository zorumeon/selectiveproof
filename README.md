# SelectiveProof

**Show one payment. Hide the rest.**
Prove that a shielded Zcash payment exists, without exposing your wallet history.

The public demo runs on **Zcash testnet** (TAZ). No real funds are involved.
Invoices, receipts and the selective proof tool also support **Zcash mainnet** (ZEC), but only when you run the app on your own computer (see "Mainnet" below).

- Live demo: TODO_PUBLIC_URL
- Demo video (2 minutes): TODO_VIDEO_LINK


## Requirements

- Node.js 18 or newer.
- `@ledgerhq/zcash-utils` **2.8.0 or newer** (installed by `npm install`). Releases 0.x cannot decrypt Ironwood notes: the scan finishes without an error but finds nothing, so no invoice is ever marked paid. The server prints a warning at start-up if an old version is installed.
- The scanner passes `network` (`testnet` or `mainnet`) to the library; mainnet needs a `uview1...` key and the mainnet lightwalletd.

## What it does

1. **Invoice.** A merchant creates an invoice (amount and description). The buyer sends TAZ to the merchant's address with a code like `ZP-XXXXXX` in the memo.
2. **Detection.** The server scans the chain through lightwalletd using the merchant's viewing key (kept in memory only) and matches the memo code.
3. **Signed receipt.** Once the invoice is paid, the buyer chooses which fields to reveal (description, transaction, time). The server signs **only** those fields with Ed25519.
4. **Verification.** Anyone can paste a receipt at `/receipt`. The server checks the signature **and** that its own record agrees, so amounts cannot be invented. The page can also check the signature entirely in the browser, with no request to the server.
5. **Selective proof (local and merchant tool).** A wallet owner can create a proof of a single transaction at `/tools#app` without revealing the balance, other transactions, or the viewing key. On the public demo this part is only available after merchant sign-in.

## What it proves, and what it does not

- **Proves:** the merchant who holds the key with the fingerprint below issued this receipt, and its records confirm the invoice was paid on the network named on the receipt (testnet or mainnet).
- **Does not prove:** anything the buyer chose not to reveal. The receipt is not an on-chain proof, because the merchant signs it. In the selective proof tool, the amount and purpose are claims made by whoever creates the proof.
- **Stays hidden:** the viewing key, the balance, and all other transactions.
- **Invoice link vs receipt link.** The invoice link (`/pay?i=...`) shows every payment detail, including the txid and block, and is meant for the buyer and the merchant only. What you share with third parties is the receipt link (`/receipt#r=...`), which contains only the fields you chose. The showcase invoices in this demo are public on purpose.
- **Proof link checksum** only detects accidental damage. It is not a signature. Signatures exist on receipts only.

## Start clean

To remove every invoice and begin again (stop the server first):

```bash
npm run reset
```

This deletes `invoices.json` and `demo-invoices.json`. It never deletes `receipt-key.pem`, because that would invalidate every receipt.

## Run locally

```bash
npm install
npm start      # node sp-server.js -> http://127.0.0.1:8788
```

Local mode needs no sign-in, because only your own computer can reach it.

## Mainnet

The selective proof tool (`/tools#app`, or `/#app` locally) has a Testnet / Mainnet switch. Mainnet scans use `https://zec.rocks:443` and checks use `https://mainnet.zcashexplorer.app/transactions/`.

- Mainnet is **on in local mode** and **off on a public host**. On a public host the server answers `403` to any `net: mainnet` request, so a real viewing key is never sent to a server you do not control. Set `ALLOW_PUBLIC_MAINNET=1` only on a server that only you operate.
- Invoices, `/pay` and signed receipts work on **both networks**. Every invoice stores its network, and the network is part of the signed receipt, so a testnet receipt cannot be passed off as a mainnet one.
- Mainnet invoices need a mainnet viewing key (`uview1...`) and a mainnet unified address (`u1...`). Open `/checkout`, pick **Mainnet**, start a session, then create invoices. Testnet and mainnet sessions can be active at the same time.
- The viewing key stays in memory and is never logged, on both networks.

## Hosting (public mode)

1. Create the signing key once:
   ```bash
   node make-receipt-key.js
   ```
   It prints the fingerprint and a one-line `RECEIPT_KEY_PEM` value. Never commit `receipt-key.pem` (it is listed in `.gitignore`).
2. Set the environment variables (see `.env.example`): `PUBLIC_ORIGIN`, `ADMIN_TOKEN`, `HOST=0.0.0.0`, `TRUST_PROXY=1`, `RECEIPT_KEY_PEM`.
3. Start command: `npm start`. Health check: `/api/health`.
4. Build the showcase data from invoices that are already paid on testnet, then commit the result:
   ```bash
   node make-demo-seed.js
   ```
   `demo-invoices.json` contains the amount, description, memo code, receiving address and txid. It never contains a viewing key or a signing key.
5. After startup, the log prints `Receipt key fingerprint`. It must match the fingerprint published below.

In public mode, visitors can open only `/` (the start page, `selectiveproof.html`), `/pay` and `/receipt`. `/tools` (the selective proof tool), `/checkout`, invoice creation, the viewing-key session, scanning and `/api/verify` require the `ADMIN_TOKEN` sign-in.

**Scanner (`@ledgerhq/zcash-utils`)** is a native addon with per-platform binaries. Install it on a glibc-based Linux host (Debian or Ubuntu, not Alpine). It is listed under `optionalDependencies`: if it fails to install, the server still starts and the showcase pages still work. Only scanning for new payments is unavailable. The showcase pages do not need the scanner.

| Variable | Purpose |
|---|---|
| `PUBLIC_ORIGIN` | Public URL; turns on public mode |
| `ADMIN_TOKEN` | Merchant sign-in token, at least 16 characters |
| `HOST` | `0.0.0.0` when hosted (default `127.0.0.1`) |
| `PORT` | Default `8788` |
| `TRUST_PROXY` | `1` when behind a reverse proxy |
| `RECEIPT_KEY_PEM` | One-line Ed25519 key, for hosts whose disk is wiped on restart |
| `DATA_DIR` | Where `invoices.json` and `receipt-key.pem` are stored |
| `LIGHTWALLETD` | Default `https://testnet.zec.rocks:443` |
| `EXPLORER` | Default `https://testnet.zcashexplorer.app/transactions/` |
| `LIGHTWALLETD_MAINNET` | Default `https://zec.rocks:443` |
| `EXPLORER_MAINNET` | Default `https://mainnet.zcashexplorer.app/transactions/` |
| `ALLOW_PUBLIC_MAINNET` | `1` allows mainnet on a public host (default off) |
| `DEMO_UFVK`, `DEMO_BIRTHDAY`, `DEMO_ADDRESS` | Optional: a pre-filled merchant session for the demo (use a throwaway testnet key) |

## Receipt signing key

- Algorithm: Ed25519
- Fingerprint (first 16 hex characters of the SHA-256 of the public key): `TODO_FINGERPRINT`
- Public key: `GET /api/merchant-key`. Anyone can check a signature without contacting the server.

Replacing or deleting the key invalidates every receipt issued so far.

## What is real and what is not

**Real**
- Testnet payments, scanned through lightwalletd.
- The showcase invoices in `demo-invoices.json`: paid testnet transactions that can be checked in an explorer.
- Ed25519 signatures, and the cross-check against the server's own records.

**Simulated or simplified**
- TAZ has no value. There is no KYC.
- Nothing on the public pages is simulated. The sample receipt on the start page is labeled "sample".
- The showcase invoices are static data. New payments are not scanned unless `DEMO_UFVK` is set.

## Note on the public lightwalletd

Scanning uses `https://testnet.zec.rocks:443` (override with `LIGHTWALLETD`). A public service can be slow or unavailable at any time. A scan can take up to a minute.

## Project layout

- `sp-server.js`: the server (Node built-in modules only)
- `sp-scanner.js`: the lightwalletd scanner
- `selectiveproof.html`: merchant tool and selective proof
- `pay.html`, `receipt.html`: public pages. `checkout.html`: merchant page (network switch, session, invoices)
- `reset-data.js`: clears invoices (never the signing key)
- `app.css`: the stylesheet used in production; `css-src.css` is only the source for `build-css.js`
- `make-receipt-key.js`, `make-demo-seed.js`: setup scripts

## License

TODO

## Payment finality (current build)

An incoming note is **not** immediately treated as final. The server exposes four operational states:

- `pending`: no matching value observed.
- `partial`: matching value observed, but below the invoice amount.
- `confirming`: enough value is observed, but the configured confirmation threshold has not been reached.
- `paid`: confirmed matching value reaches the invoice amount.

`MIN_CONFIRMATIONS` defaults to `3`. Receipt creation is blocked until the invoice is `paid`. Non-demo invoices, including previously paid ones, are rescanned so a payment that disappears from the scanner result can fall back from `paid` rather than remaining permanently final.

This is merchant-observed evidence using a UFVK plus signed merchant records. It is not a standalone Zcash consensus proof.
