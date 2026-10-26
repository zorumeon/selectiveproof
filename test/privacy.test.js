const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "selectiveproof.html"),
  "utf8"
);

test("invoice has a selective-disclosure checkbox", () => {
  assert.match(
    html,
    /data-rv="invoice"/,
    "Invoice must have its own selective-disclosure control"
  );
});

test("invoice receipt row obeys reveal.invoice", () => {
  assert.match(
    html,
    /row\('Invoice',[^\n]*,'invoice'\)/,
    "Invoice receipt row must be controlled by the invoice reveal flag"
  );
});

test("clipboard includes invoice only when reveal.invoice is enabled", () => {
  assert.match(
    html,
    /if\(reveal\.invoice&&i\.id\)L\.push\("Invoice: "\+i\.id\)/,
    "Clipboard must gate Invoice ID behind reveal.invoice"
  );

  assert.doesNotMatch(
    html,
    /const L=\[[^\n]*"Invoice: "\+\(i\.id\|\|""\)/,
    "Invoice ID must not be unconditionally included in clipboard text"
  );
});
