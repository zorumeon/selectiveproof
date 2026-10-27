# SelectiveProof — Blue Dashboard + Backend

This package combines the blue Overview dashboard with the SelectiveProof v4 backend and supporting pages.

## Main files
- `selectiveproof.html` — blue dashboard and main page
- `sp-server.js` — local HTTP server and API
- `sp-scanner.js` — incoming-note scanner using lightwalletd
- `checkout.html`, `pay.html`, `receipt.html` — supporting pages
- `make-receipt-key.js`, `reset-data.js`, `package.json`, `package-lock.json` — utilities and project setup
- `QA-TESTNET-v3.2.md` — initial Testnet QA checklist
- `selectiveproof-v4-original.html` — preserved copy of the previous page

## Current integration status
The blue dashboard began as a UI demo. It is now placed as the server's main page, but its menus and buttons are not yet all connected to backend endpoints. This package is prepared for continued integration; it is **not** evidence that every workflow is operational.

Do not mark a payment as successful based on UI state alone. Test the API, receipt signature, shielded Testnet scanning, memo and amount matching, and confirmation depth independently before a demo. Never enter a seed phrase or spending key. Viewing keys are also sensitive and should only be used in a trusted local environment.

## Run locally
Requirements: Node.js 18 or newer.

1. Extract this archive into a new project folder. Keep your existing project as a backup.
2. Open a terminal in the extracted `SelectiveProof-Biru` folder.
3. Run `npm install`.
4. Run `npm ls @ledgerhq/zcash-utils` and confirm version 2.8.0 or newer.
5. Run `npm start`.
6. Open `http://127.0.0.1:8788/` in your browser.
7. Follow `QA-TESTNET-v3.2.md` and record which checks pass. Use Testnet only during initial testing.

## Important limitations
- Wallet connection and transaction submission are not confirmed by this package alone.
- Shielded payment detection must be verified with a real, controlled Testnet transaction before claiming it works.
- A valid receipt signature proves who signed the receipt; it does not by itself prove that an on-chain payment occurred.
- Do not use Mainnet funds until the complete flow has been reviewed and tested.


Before starting for the first time, run `npm install` from this folder to install the required dependencies. Payment QR codes are generated locally by the server with no third-party QR service. For real invoices, the QR uses a ZIP-321 payment URI containing the receiving address, amount, and invoice memo. Confirm the details in a ZIP-321 compatible Zcash wallet before sending.
