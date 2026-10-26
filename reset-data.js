'use strict';

/*
 * Starts SelectiveProof with no invoices. Run it with the server stopped:
 *
 *   node reset-data.js
 *
 * It deletes invoices.json (every invoice you created) and demo-invoices.json (the showcase
 * data). It NEVER touches receipt-key.pem: deleting the key would invalidate every receipt.
 */

const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.env.DATA_DIR || __dirname);
const targets = [path.join(dir, 'invoices.json'), path.join(__dirname, 'demo-invoices.json')];
let removed = 0;
for (const file of new Set(targets)) {
  if (fs.existsSync(file)) { fs.unlinkSync(file); console.log('Deleted ' + file); removed += 1; }
}
console.log(removed ? 'Done. Start the server with: npm start' : 'Nothing to delete. The data is already empty.');
