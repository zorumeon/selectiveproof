'use strict';

/*
 * SelectiveProof server (Zcash Testnet and Mainnet).
 *
 * Two ways to run it:
 *
 *   LOCAL (default)   node sp-server.js        -> http://127.0.0.1:8788
 *     Same as before: only your own machine can reach it, no sign-in needed.
 *
 *   PUBLIC DEMO       PUBLIC_ORIGIN=https://demo.example.com ADMIN_TOKEN=... node sp-server.js
 *     Visitors can open /, /pay and /receipt only. Everything that belongs to the
 *     merchant (invoice list, creating invoices, the viewing-key session, scanning)
 *     needs the ADMIN_TOKEN sign-in. See README.md.
 *
 * Privacy: the viewing key is kept in memory only, is never logged and never returned.
 * Memos are never logged. The public pages load nothing from third parties.
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { toZats, memoHasInvoiceCode, evaluateInvoicePayment } = require('./sp-payment');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 8788;
const HOST = process.env.HOST || '127.0.0.1';
const LIGHTWALLETD = process.env.LIGHTWALLETD || 'https://testnet.zec.rocks:443';
const EXPLORER = process.env.EXPLORER || 'https://testnet.zcashexplorer.app/transactions/';
// Mainnet (real ZEC) covers the owner tools (/tools) AND invoices, /pay and signed receipts.
// A viewing key must never travel to a server you do not control, so on a public host it stays
// off unless you set ALLOW_PUBLIC_MAINNET=1 on a server that only you run.
const NETS = {
  testnet: { lightwalletd: LIGHTWALLETD, explorer: EXPLORER, ufvk: /^uviewtest1[0-9a-z]{20,}$/, other: /^uview1/, label: 'Testnet', unit: 'TAZ', addr: /^utest1[0-9a-z]{20,}$/, addrPrefix: 'utest1' },
  mainnet: {
    lightwalletd: process.env.LIGHTWALLETD_MAINNET || 'https://zec.rocks:443',
    explorer: process.env.EXPLORER_MAINNET || 'https://mainnet.zcashexplorer.app/transactions/',
    ufvk: /^uview1[0-9a-z]{20,}$/, other: /^uviewtest1/, label: 'Mainnet', unit: 'ZEC', addr: /^u1[0-9a-z]{20,}$/, addrPrefix: 'u1',
  },
};
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SESSION_MS = 12 * 60 * 60 * 1000;

let publicUrl = null;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || '';
if (PUBLIC_ORIGIN) {
  try { publicUrl = new URL(PUBLIC_ORIGIN.trim()); } catch { publicUrl = null; }
  if (!publicUrl || !/^https?:$/.test(publicUrl.protocol)) {
    console.error('PUBLIC_ORIGIN must look like https://demo.example.com');
    process.exit(1);
  }
}
const PUBLIC_MODE = Boolean(publicUrl);
// Never allow unauthenticated local mode to bind to a public interface.
if (!PUBLIC_MODE && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.error('Local mode must bind to loopback only. Remove HOST or set HOST=127.0.0.1. Use PUBLIC_ORIGIN + ADMIN_TOKEN for a hosted demo.');
  process.exit(1);
}
const MAINNET_ALLOWED = !PUBLIC_MODE || process.env.ALLOW_PUBLIC_MAINNET === '1';
const SECURE_COOKIE = Boolean(publicUrl && publicUrl.protocol === 'https:');
if (PUBLIC_MODE && ADMIN_TOKEN.length < 16) {
  console.error('Public mode needs ADMIN_TOKEN, at least 16 characters. Example: ADMIN_TOKEN=$(openssl rand -hex 24)');
  process.exit(1);
}

const HTML_FILE = path.join(__dirname, 'selectiveproof.html');
const SCANNER_FILE = path.join(__dirname, 'sp-scanner.js');
const CHECKOUT_FILE = path.join(__dirname, 'checkout.html');
const PAY_FILE = path.join(__dirname, 'pay.html');
const RECEIPT_PAGE = path.join(__dirname, 'receipt.html');
const DEMO_PAGE = path.join(__dirname, 'demo.html');
const CSS_FILE = path.join(__dirname, 'app.css');
const SEED_FILE = path.join(__dirname, 'demo-invoices.json');
const INVOICE_FILE = path.join(DATA_DIR, 'invoices.json');
const KEY_FILE = path.join(DATA_DIR, 'receipt-key.pem');
const MAX_BODY_BYTES = 8 * 1024;
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
if (publicUrl) {
  ALLOWED_HOSTS.add(publicUrl.host.toLowerCase());
  ALLOWED_ORIGINS.add(publicUrl.origin);
}

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
if (SECURE_COOKIE) BASE_HEADERS['Strict-Transport-Security'] = 'max-age=31536000';

const httpError = (status, message) => Object.assign(new Error(message), { status });

let scanFn = null;
try {
  if (fs.existsSync(SCANNER_FILE)) scanFn = require(SCANNER_FILE).scan;
} catch (err) {
  console.error('sp-scanner.js failed to load:', err.message);
}

// @ledgerhq/zcash-utils 0.x cannot read Ironwood notes: it finds nothing and reports no error.
// Warn loudly at startup instead of letting every payment stay "pending" for no visible reason.
try {
  const libPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'node_modules', '@ledgerhq', 'zcash-utils', 'package.json'), 'utf8'));
  if (Number.parseInt(String(libPkg.version).split('.')[0], 10) < 2) {
    console.error(`WARNING: @ledgerhq/zcash-utils ${libPkg.version} is too old and cannot see Ironwood payments. Run: npm install @ledgerhq/zcash-utils@^2.8.0`);
  }
} catch { /* not installed here: the "Scanner: not installed" line below says so */ }

// ---------------------------------------------------------------------------
// Small helpers: responses, rate limiting, admin sign-in
// ---------------------------------------------------------------------------
function sendJson(res, status, body, extraHeaders) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, ...(extraHeaders || {}), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

// Strict Content-Security-Policy for pages that must not talk to anyone but this server.
// Inline scripts and styles are allowed only if their exact content is hashed here, so
// nothing injected later can run, and nothing can be loaded from another site.
function strictCsp(html) {
  const hash = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => hash(m[1]));
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => hash(m[1]));
  return [
    "default-src 'none'",
    `script-src ${scripts.join(' ') || "'none'"}`,
    `style-src 'self' ${styles.join(' ')}`.trim(),
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function sendHtml(req, res, html, strict) {
  const buf = Buffer.from(html, 'utf8');
  const headers = { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length };
  if (strict) headers['Content-Security-Policy'] = strictCsp(html);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

// strict=true for the pages visitors open (pay, receipt, demo, sign-in).
function serveHtml(req, res, file = HTML_FILE, strict = false) {
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return sendJson(res, 500, { error: `${path.basename(file)} was not found next to sp-server.js.` });
    sendHtml(req, res, html, strict);
  });
}

function serveCss(req, res) {
  fs.readFile(CSS_FILE, (err, data) => {
    if (err) return sendJson(res, 500, { error: 'app.css was not found next to sp-server.js.' });
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/css; charset=utf-8', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const hits = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || e.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
  e.n += 1;
  return e.n <= limit;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of hits) if (e.reset < now) hits.delete(k); }, 60000).unref();

// Behind a hosting proxy set TRUST_PROXY=1 so the visitor's address (the last
// X-Forwarded-For entry, which the proxy appended) is used instead of the proxy's.
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xf.length) return xf[xf.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function limit(req, name, max, windowMs) {
  if (!rateLimit(`${name}:${clientIp(req)}`, max, windowMs)) throw httpError(429, 'Too many requests. Wait a moment and try again.');
}

const adminSessions = new Map(); // session id -> expiry time (memory only)
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
// Local mode: the app only listens on your own machine, so no sign-in is needed.
function isAdmin(req) {
  if (!PUBLIC_MODE) return true;
  const sid = parseCookies(req).sp_admin;
  const exp = sid ? adminSessions.get(sid) : null;
  if (!exp) return false;
  if (exp < Date.now()) { adminSessions.delete(sid); return false; }
  return true;
}
function requireAdmin(req) {
  if (!isAdmin(req)) throw httpError(401, 'Merchant sign-in required.');
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

async function handleAdminLogin(req, res) {
  checkJsonRequest(req);
  if (!PUBLIC_MODE) throw httpError(404, 'Not found.');
  limit(req, 'login', 5, 10 * 60 * 1000);
  const body = await readJsonBody(req);
  if (!crypto.timingSafeEqual(sha(body && body.token || ''), sha(ADMIN_TOKEN))) throw httpError(401, 'That token is not correct.');
  const sid = crypto.randomBytes(24).toString('base64url');
  adminSessions.set(sid, Date.now() + SESSION_MS);
  const cookie = `sp_admin=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${SECURE_COOKIE ? '; Secure' : ''}`;
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
}

function handleAdminLogout(req, res) {
  checkJsonRequest(req);
  const sid = parseCookies(req).sp_admin;
  if (sid) adminSessions.delete(sid);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': `sp_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}` });
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Merchant sign-in</title>
<link rel="stylesheet" href="/app.css" />
</head>
<body class="bg-black text-white">
<div class="min-h-screen flex items-center justify-center p-4">
  <form id="f" class="w-full max-w-md bg-zinc-950 border border-zinc-800 rounded-2xl p-6">
    <h1 class="text-2xl font-semibold text-center">Merchant sign-in</h1>
    <p class="text-sm text-zinc-400 mt-1 text-center">This area is for the merchant. Buyers only need the pay link.</p>
    <label class="block text-xs text-zinc-400 mt-5 mb-1" for="t">Admin token</label>
    <input id="t" type="password" autocomplete="current-password" class="mono w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm outline-none" />
    <button class="w-full mt-4 py-3 rounded-xl bg-green-500 hover:bg-green-400 text-black font-semibold" type="submit">Sign in</button>
    <p id="e" class="text-xs text-red-400 mt-2 min-h-[1rem]" role="status"></p>
    <p class="text-xs text-zinc-500 mt-3 text-center"><a class="underline" href="/">Back to the demo</a></p>
  </form>
</div>
<script>
document.getElementById('f').addEventListener('submit', function (ev) {
  ev.preventDefault();
  var e = document.getElementById('e'); e.textContent = '';
  fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: document.getElementById('t').value }) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) { if (!res.ok) throw new Error(res.j && res.j.error || 'Could not sign in.'); location.reload(); })
    .catch(function (x) { e.textContent = x.message; });
});
</script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) tooBig = true; else chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return reject(httpError(413, 'Request is too large.'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(httpError(400, 'Request body must be valid JSON.')); }
    });
    req.on('error', () => reject(httpError(400, 'Could not read the request.')));
  });
}

function checkJsonRequest(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) throw httpError(415, 'Content-Type must be application/json.');
  if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) throw httpError(403, 'Cross-origin requests are blocked.');
}

function parseNet(body) {
  const net = body && body.net !== undefined ? String(body.net) : 'testnet';
  if (!Object.prototype.hasOwnProperty.call(NETS, net)) throw httpError(400, 'net must be testnet or mainnet.');
  if (net === 'mainnet' && !MAINNET_ALLOWED) throw httpError(403, 'Mainnet is turned off on this public demo. Run the app on your own computer to use real ZEC.');
  return net;
}

function parseScanRequest(body, net = 'testnet') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Invalid request.');
  const ufvk = typeof body.ufvk === 'string' ? body.ufvk.trim() : '';
  const cfg = NETS[net];
  if (!cfg.ufvk.test(ufvk)) {
    if (cfg.other.test(ufvk)) throw httpError(400, `That key is for the other network. Switch to ${net === 'mainnet' ? 'Testnet' : 'Mainnet'}.`);
    throw httpError(400, net === 'mainnet'
      ? 'Enter a Zcash Mainnet unified full viewing key (it starts with uview1).'
      : 'Enter a Zcash Testnet unified full viewing key (it starts with uviewtest1).');
  }
  const birthday = Number(body.birthday);
  if (!Number.isInteger(birthday) || birthday < 1 || birthday > 100000000) throw httpError(400, 'Birthday height must be a positive whole number.');
  let cutoff = null;
  if (body.cutoff !== undefined && body.cutoff !== null && String(body.cutoff).trim() !== '') {
    cutoff = Number(body.cutoff);
    if (!Number.isInteger(cutoff) || cutoff < birthday) throw httpError(400, 'Cutoff height must be at or after the birthday height.');
  }
  return { ufvk, birthday, cutoff };
}

// ---------------------------------------------------------------------------
// Owner tools: scan with a viewing key, public explorer check (merchant sign-in only)
// ---------------------------------------------------------------------------
let scanning = false;

async function handleTransactions(req, res) {
  requireAdmin(req);
  checkJsonRequest(req);
  const body = await readJsonBody(req);
  const net = parseNet(body);
  const params = parseScanRequest(body, net);
  if (!scanFn) return sendJson(res, 501, { error: 'Scanner could not be loaded by Node.js. Check the server startup log and the device security policy.' });
  if (scanning) return sendJson(res, 429, { error: 'A scan is already running. Wait for it to finish.' });

  scanning = true;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SCAN_TIMEOUT_MS);
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  try {
    const rows = await scanFn({ ...params, lightwalletd: NETS[net].lightwalletd, network: net, signal: abort.signal });
    sendJson(res, 200, { network: net, rows });
  } catch (err) {
    const detail = errorDetail(err, params.ufvk);
    console.error(`scan failed (${net}):`, detail);
    const msg = abort.signal.aborted
      ? 'The scan timed out or was cancelled.'
      : (err && err.publicMessage) || 'The scan failed. Check the viewing key, the birthday height and your connection.';
    sendJson(res, 502, { error: msg, detail });
  } finally {
    clearTimeout(timer);
    scanning = false;
  }
}

function fetchText(url, ms) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'SelectiveProof/0.1', Accept: 'text/html,application/json' } }, (r) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      r.on('data', (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) {
          settled = true;
          r.destroy(new Error('Explorer response exceeded 2 MB.'));
          reject(new Error('Explorer response exceeded 2 MB.'));
          return;
        }
        chunks.push(c);
      });
      r.on('end', () => {
        if (settled) return;
        resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
      r.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    });
    req.setTimeout(ms, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Optional check, no key. Asks a public explorer whether a txid exists on testnet.
// This is the one place a txid leaves this server, so it needs the merchant sign-in.
async function handleVerify(req, res) {
  requireAdmin(req);
  checkJsonRequest(req);
  const body = await readJsonBody(req);
  const net = parseNet(body);
  const explorer = NETS[net].explorer;
  const txid = String(body && body.txid || '').toLowerCase();
  const h = Number(body && body.h);
  if (!/^[0-9a-f]{64}$/.test(txid)) throw httpError(400, 'txid must be 64 hex characters.');
  // Try the txid as given and byte-reversed: some libraries return the raw byte order,
  // explorers use the reversed display order.
  const reversed = txid.match(/../g).reverse().join('');
  try {
    let found = false;
    let heightSeen = false;
    let usedReversed = false;
    const statuses = [];
    for (const [id, isRev] of [[txid, false], [reversed, true]]) {
      const r = await fetchText(explorer + id, 15000);
      statuses.push(r.status);
      if (r.status === 200 && r.body.toLowerCase().includes(id)) {
        found = true;
        usedReversed = isRev;
        // A block height appearing somewhere in HTML/text is not evidence that it
        // belongs to this transaction. Only compare a structured JSON height field.
        try {
          const data = JSON.parse(r.body);
          const candidates = [data && data.height, data && data.blockHeight, data && data.block_height,
            data && data.block && data.block.height, data && data.data && data.data.height,
            data && data.data && data.data.blockHeight];
          heightSeen = Number.isInteger(h) && candidates.some((v) => Number(v) === h);
        } catch { heightSeen = false; }
        break;
      }
    }
    const notIndexed = !found && statuses.every((s) => s === 404);
    sendJson(res, 200, { network: net, source: new URL(explorer).host, found, heightSeen, usedReversed, notIndexed, statuses });
  } catch {
    sendJson(res, 502, { error: 'Could not reach the explorer. Check your connection and try again.' });
  }
}

// ---------------------------------------------------------------------------
// Shielded checkout: invoices matched to incoming payments by a code in the memo.
//
// The merchant's viewing key is kept in memory only (never written to disk, never
// returned). Invoices (without any key) are saved to invoices.json so they survive
// a restart; after a restart the merchant starts a new session with the key again.
// For a public demo you can leave the key out entirely: paid invoices that were
// seeded from demo-invoices.json still work, and new payments are simply not scanned.
// ---------------------------------------------------------------------------
const POLL_MS = 20000;
const MIN_CONFIRMATIONS = Math.max(1, Number.parseInt(process.env.MIN_CONFIRMATIONS || '3', 10) || 3);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let zcashLib = null;
try { zcashLib = require('@ledgerhq/zcash-utils'); } catch { /* optional: only used for the chain tip */ }

// One merchant session per network, memory only: { ufvk, birthday, address }.
const merchants = { testnet: null, mainnet: null };
let invoices = [];
let lastCheck = null;
try {
  const saved = JSON.parse(fs.readFileSync(INVOICE_FILE, 'utf8'));
  if (Array.isArray(saved)) invoices = saved;
} catch { invoices = []; }
for (const i of invoices) if (!i.net) i.net = 'testnet'; // older records were testnet only
// Showcase invoices (already paid on testnet) shipped with the demo. Added if missing.
try {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  if (Array.isArray(seed)) {
    for (const s of seed) {
      if (!s || typeof s.id !== 'string') continue;
      const existing = invoices.find((i) => i.id === s.id);
      if (existing) existing.demo = true; // already in invoices.json: just mark it as a showcase invoice
      else invoices.push({ net: 'testnet', ...s, demo: true });
    }
  }
} catch { /* no seed file */ }

function saveInvoices() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(INVOICE_FILE, JSON.stringify(invoices, null, 2)); }
  catch (err) { console.error('could not save invoices:', err.message); }
}

// Optional pre-filled merchant session for a hosted demo. Use a throwaway testnet key.
if (process.env.DEMO_UFVK) {
  try {
    const { ufvk, birthday } = parseScanRequest({ ufvk: process.env.DEMO_UFVK, birthday: process.env.DEMO_BIRTHDAY });
    const address = String(process.env.DEMO_ADDRESS || '').trim();
    if (!/^utest1[0-9a-z]{20,}$/.test(address)) throw new Error('DEMO_ADDRESS must be a Zcash Testnet address (utest1...).');
    merchants.testnet = { ufvk, birthday, address };
  } catch (err) {
    console.error('DEMO_UFVK / DEMO_BIRTHDAY / DEMO_ADDRESS are not valid:', err.message);
    process.exit(1);
  }
}

function newCode() {
  // Retry on the (very unlikely) event that a code already exists in saved invoices.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = crypto.randomBytes(6);
    let s = '';
    for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
    const code = 'ZP-' + s;
    if (!invoices.some((i) => i.code === code)) return code;
  }
  throw new Error('Could not generate a unique invoice code. Try again.');
}

// The real reason a scan failed, safe to show to the signed-in merchant: the viewing key is
// removed and the text is cut short. Without this every failure looked the same.
function errorDetail(err, secret) {
  let t = String(err && err.message ? err.message : err);
  if (err && err.code !== undefined) t = `[${err.code}] ${t}`;
  if (secret) t = t.split(secret).join('[key]');
  return t.slice(0, 300);
}

function publicInvoice(i) {
  return {
    id: i.id, net: i.net || 'testnet', unit: NETS[i.net || 'testnet'].unit, code: i.code, amount: i.amount, description: i.description, address: i.address,
    status: i.status, received: i.received, confirmedReceived: i.confirmedReceived || 0, confirmations: i.confirmations || 0, requiredConfirmations: MIN_CONFIRMATIONS, txid: i.txid || null, paidHeight: i.paidHeight || null,
    paidTime: i.paidTime || null, createdAt: i.createdAt,
  };
}

async function getTipHeight(net = 'testnet') {
  if (!zcashLib || typeof zcashLib.getChainTip !== 'function') return null;
  try {
    const tip = await Promise.race([
      zcashLib.getChainTip(NETS[net].lightwalletd),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000)),
    ]);
    const h = Number(typeof tip === 'object' && tip ? tip.height : tip);
    return Number.isInteger(h) && h > 0 ? h : null;
  } catch { return null; }
}

let checking = false;

// Scans for incoming payments and matches them to open invoices by memo code, once per
// network that has a merchant session and open invoices.
// full=true rescans from the merchant's birthday (slow, but the safe fallback).
async function scanNet(net, m, open, full) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SCAN_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const earliest = Math.min(...open.map((i) => (Number.isInteger(i.createdHeight) ? i.createdHeight : m.birthday)));
    const from = full ? m.birthday : Math.max(m.birthday, earliest - 5);
    const rows = await scanFn({ ufvk: m.ufvk, birthday: from, cutoff: null, lightwalletd: NETS[net].lightwalletd, network: net, signal: abort.signal });
    const tip = await getTipHeight(net);

    for (const inv of open) {
      // Pure evaluator is covered by automated adversarial tests. If the chain tip
      // cannot be obtained, confirmations are zero and evaluation fails closed.
      const result = evaluateInvoicePayment({ rows, code: inv.code, amount: inv.amount, tip, minConfirmations: MIN_CONFIRMATIONS });
      Object.assign(inv, result);
    }
    saveInvoices();
    return { from, tip, requiredConfirmations: MIN_CONFIRMATIONS, rows: rows.length, ms: Date.now() - startedAt, error: null };
  } catch (err) {
    const detail = errorDetail(err, m.ufvk);
    console.error(`invoice check failed (${net}):`, detail);
    return { error: abort.signal.aborted ? 'The scan timed out.' : ((err && err.publicMessage) || 'The scan failed.'), detail };
  } finally { clearTimeout(timer); }
}
async function checkInvoices(full) {
  if (!scanFn) return { skipped: 'no-scanner' };
  if (!merchants.testnet && !merchants.mainnet) return { skipped: 'no-session' };
  const work = Object.keys(NETS)
    .map((net) => ({ net, m: merchants[net], open: invoices.filter((i) => (i.net || 'testnet') === net && !i.demo) }))
    .filter((w) => w.m && w.open.length);
  if (!work.length) return { skipped: 'nothing-pending' };
  if (checking || scanning) return { skipped: 'busy' };

  checking = true;
  scanning = true;
  const results = {};
  try {
    for (const w of work) results[w.net] = await scanNet(w.net, w.m, w.open, full);
  } finally {
    scanning = false;
    checking = false;
  }
  lastCheck = { at: Date.now(), mode: full ? 'full' : 'recent', results };
  return lastCheck;
}

const poller = setInterval(() => { checkInvoices(false).catch(() => {}); }, POLL_MS);
poller.unref();

function sessionInfo() {
  const sessions = {};
  for (const n of Object.keys(NETS)) {
    const m = merchants[n];
    sessions[n] = m ? { active: true, address: m.address, birthday: m.birthday } : { active: false };
  }
  return { active: Boolean(merchants.testnet || merchants.mainnet), sessions };
}

async function handleMerchantSession(req, res) {
  requireAdmin(req);
  checkJsonRequest(req);
  const body = await readJsonBody(req);
  const net = parseNet(body);
  if (body && body.logout) { merchants[net] = null; return sendJson(res, 200, sessionInfo()); }
  const { ufvk, birthday } = parseScanRequest({ ufvk: body && body.ufvk, birthday: body && body.birthday }, net);
  const address = String(body && body.address || '').trim();
  if (!NETS[net].addr.test(address)) throw httpError(400, `Enter your Zcash ${NETS[net].label} receiving address (it starts with ${NETS[net].addrPrefix}).`);
  merchants[net] = { ufvk, birthday, address };
  sendJson(res, 200, sessionInfo());
}

async function handleCreateInvoice(req, res) {
  requireAdmin(req);
  checkJsonRequest(req);
  const body = await readJsonBody(req);
  const net = parseNet(body);
  const merchant = merchants[net];
  if (!merchant) throw httpError(409, `Start a ${NETS[net].label} merchant session first.`);
  const amount = Number(body && body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 || toZats(amount) < 1) throw httpError(400, `Amount must be a positive number of ${NETS[net].unit}.`);
  if (Math.abs(toZats(amount) / 1e8 - amount) > 1e-11) throw httpError(400, 'Amount can have at most 8 decimals.');
  const description = String(body && body.description || '').trim().slice(0, 80);
  const tip = await getTipHeight(net);
  const inv = {
    // 96 random bits: the link is the capability, so it must not be guessable.
    id: crypto.randomBytes(12).toString('hex'),
    net,
    code: newCode(),
    amount,
    description,
    address: merchant.address,
    status: 'pending',
    received: 0,
    confirmedReceived: 0,
    confirmations: 0,
    createdAt: Date.now(),
    createdHeight: tip,
  };
  invoices.unshift(inv);
  saveInvoices();
  sendJson(res, 201, publicInvoice(inv));
}

async function handleCheckNow(req, res) {
  requireAdmin(req);
  checkJsonRequest(req);
  const body = await readJsonBody(req);
  const result = await checkInvoices(Boolean(body && body.full));
  sendJson(res, 200, { result, invoices: invoices.map(publicInvoice) });
}

// ---------------------------------------------------------------------------
// Signed receipts. The merchant's server signs (Ed25519) exactly the fields the buyer
// chose to reveal. Anyone can later paste the receipt on /receipt; the server checks
// the signature AND that its own invoice record agrees. Amounts cannot be invented.
//
// The signing key is read from RECEIPT_KEY_PEM (for hosts whose disk is wiped on
// restart) or from receipt-key.pem. If neither exists a new key is created.
// Keep it private. Deleting it or changing it makes every older receipt invalid.
// ---------------------------------------------------------------------------
let signKey = null;
const envPem = String(process.env.RECEIPT_KEY_PEM || '').replace(/\\n/g, '\n').trim();
if (envPem) {
  try { signKey = crypto.createPrivateKey(envPem); }
  catch { console.error('RECEIPT_KEY_PEM is not a valid private key.'); process.exit(1); }
  if (signKey.asymmetricKeyType !== 'ed25519') { console.error('RECEIPT_KEY_PEM must be an Ed25519 key.'); process.exit(1); }
} else {
  try { if (fs.existsSync(KEY_FILE)) signKey = crypto.createPrivateKey(fs.readFileSync(KEY_FILE, 'utf8')); }
  catch (err) { console.error('receipt-key.pem could not be read, creating a new key:', err.message); }
  if (!signKey) {
    signKey = crypto.generateKeyPairSync('ed25519').privateKey;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(KEY_FILE, signKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    } catch (err) {
      console.error('Could not persist receipt-key.pem. Refusing to start with an ephemeral signing key:', err.message);
      process.exit(1);
    }
  }
}
const pubKey = crypto.createPublicKey(signKey);
const pubKeyDer = pubKey.export({ type: 'spki', format: 'der' });
const fingerprint = crypto.createHash('sha256').update(pubKeyDer).digest('hex').slice(0, 16);
// Public half of the signing key, safe to publish. Anyone holding it can check a receipt's
// signature without asking this server. Raw Ed25519 key = the last 32 bytes of the SPKI DER.
const publicKeyInfo = {
  alg: 'Ed25519',
  fingerprint,
  raw: pubKeyDer.subarray(pubKeyDer.length - 32).toString('base64url'),
  spki: pubKeyDer.toString('base64'),
  pem: pubKey.export({ type: 'spki', format: 'pem' }),
};

// Fixed key order so the same data always produces the same signed text.
function canonicalReceipt(p) {
  const o = { v: 1, net: p.net, inv: p.inv, code: p.code, amount: p.amount };
  if (p.desc !== undefined) o.desc = p.desc;
  if (p.txid !== undefined) { o.txid = p.txid; o.h = p.h; }
  if (p.t !== undefined) o.t = p.t;
  return JSON.stringify(o);
}

function validReceiptPayload(p) {
  return Boolean(p) && typeof p === 'object' && p.v === 1 && (p.net === 'testnet' || p.net === 'mainnet') &&
    typeof p.inv === 'string' && /^[0-9a-f]{8,32}$/.test(p.inv) &&
    typeof p.code === 'string' && /^ZP-[A-Z2-9]{6}$/.test(p.code) &&
    typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0 &&
    (p.desc === undefined || (typeof p.desc === 'string' && p.desc.length <= 80)) &&
    (p.txid === undefined || (typeof p.txid === 'string' && /^[0-9a-f]{64}$/.test(p.txid) && Number.isInteger(p.h) && p.h > 0)) &&
    (p.t === undefined || (Number.isInteger(p.t) && p.t > 0));
}

// Public on purpose: the buyer has no account. The invoice link is the credential,
// and only a paid invoice can produce a receipt.
async function handleCreateReceipt(req, res, id) {
  limit(req, 'receipt', 20, 60 * 1000);
  checkJsonRequest(req);
  const inv = invoices.find((i) => i.id === id);
  if (!inv) throw httpError(404, 'Invoice not found.');
  if (inv.status !== 'paid') throw httpError(409, `This invoice is not final yet. ${MIN_CONFIRMATIONS} confirmations are required.`);
  const body = await readJsonBody(req);
  const reveal = (body && body.reveal) || {};
  const p = { net: inv.net || 'testnet', inv: inv.id, code: inv.code, amount: inv.amount };
  if (reveal.description && inv.description) p.desc = inv.description;
  if (reveal.transaction && inv.txid && Number.isInteger(inv.paidHeight)) { p.txid = inv.txid; p.h = inv.paidHeight; }
  if (reveal.time && Number.isInteger(inv.paidTime)) p.t = inv.paidTime;
  const canon = canonicalReceipt(p);
  const sig = crypto.sign(null, Buffer.from(canon), signKey).toString('base64url');
  const token = Buffer.from(JSON.stringify({ p: JSON.parse(canon), s: sig })).toString('base64url');
  sendJson(res, 201, { token, path: '/receipt#r=' + token, fingerprint });
}

async function handleVerifyReceipt(req, res) {
  limit(req, 'verify', 60, 60 * 1000);
  checkJsonRequest(req);
  const body = await readJsonBody(req);
  const bad = (reason, extra) => sendJson(res, 200, { valid: false, reason, ...(extra || {}) });
  let parsed;
  try { parsed = JSON.parse(Buffer.from(String(body && body.token || ''), 'base64url').toString('utf8')); }
  catch { return bad('This receipt link is damaged.'); }
  const p = parsed && parsed.p;
  const s = parsed && parsed.s;
  if (!validReceiptPayload(p) || typeof s !== 'string') return bad('This receipt link is damaged.');
  let signatureOk = false;
  try { signatureOk = crypto.verify(null, Buffer.from(canonicalReceipt(p)), pubKey, Buffer.from(s, 'base64url')); } catch { signatureOk = false; }
  if (!signatureOk) return bad('The signature does not match. This receipt was altered, or it was not issued by this merchant.');
  const inv = invoices.find((i) => i.id === p.inv);
  const matches = Boolean(inv) && inv.status === 'paid' && (inv.net || 'testnet') === p.net && inv.code === p.code && inv.amount === p.amount &&
    (p.desc === undefined || inv.description === p.desc) &&
    (p.txid === undefined || (inv.txid === p.txid && inv.paidHeight === p.h)) &&
    (p.t === undefined || inv.paidTime === p.t);
  if (!matches) return bad('The signature is genuine, but the merchant record does not confirm this payment.', { signatureOk: true });
  sendJson(res, 200, {
    valid: true, signatureOk: true, fingerprint, publicKey: publicKeyInfo,
    fields: { net: p.net, unit: NETS[p.net].unit, invoice: p.inv, code: p.code, amount: p.amount, description: p.desc, txid: p.txid, height: p.txid ? p.h : undefined, time: p.t },
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';
const ID_RE = '([0-9a-f]{8,32})';

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    // Hosting platforms probe /api/health with their own Host header; nothing sensitive is returned.
    const healthProbe = PUBLIC_MODE && pathname === '/api/health';
    if (!healthProbe && !ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
      return sendJson(res, 403, { error: PUBLIC_MODE ? `Open this app at ${publicUrl.origin}` : `Open this app at http://127.0.0.1:${PORT}` });
    }

    // Pages everyone may open. They load no third-party code (strict CSP).
    if (pathname === '/app.css' && isRead(req)) return serveCss(req, res);
    if (pathname === '/pay' && isRead(req)) return serveHtml(req, res, PAY_FILE, true);
    if (pathname === '/receipt' && isRead(req)) return serveHtml(req, res, RECEIPT_PAGE, true);
    // The old separate showcase page is gone: the start page now leads straight to a paid invoice.
    if (pathname === '/demo' && isRead(req)) { res.writeHead(302, { ...BASE_HEADERS, Location: '/' }); return res.end(); }
    // The start page (landing + simulated demo, all in one file) is public. Its owner view
    // (#app) redirects to /tools, and every merchant API call still needs the sign-in.
    if ((pathname === '/' || pathname === '/selectiveproof.html') && isRead(req)) return serveHtml(req, res, HTML_FILE);

    // Merchant pages. In public mode they need the sign-in.
    if (pathname === '/tools' && isRead(req)) {
      return isAdmin(req) ? serveHtml(req, res, HTML_FILE) : sendHtml(req, res, LOGIN_HTML, true);
    }
    if (pathname === '/checkout' && isRead(req)) {
      return isAdmin(req) ? serveHtml(req, res, CHECKOUT_FILE) : sendHtml(req, res, LOGIN_HTML, true);
    }

    if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, networks: MAINNET_ALLOWED ? ['testnet', 'mainnet'] : ['testnet'], mainnet: MAINNET_ALLOWED, scannerAvailable: Boolean(scanFn), requiredConfirmations: MIN_CONFIRMATIONS, mode: PUBLIC_MODE ? 'public' : 'local' });

    if (pathname === '/api/admin/status' && req.method === 'GET') return sendJson(res, 200, { required: PUBLIC_MODE, signedIn: isAdmin(req) });
    if (pathname === '/api/admin/login') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      return await handleAdminLogin(req, res);
    }
    if (pathname === '/api/admin/logout') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      return handleAdminLogout(req, res);
    }

    // Public data: the key, the showcase invoices, one invoice by its secret link, receipts.
    if (pathname === '/api/merchant-key' && req.method === 'GET') return sendJson(res, 200, publicKeyInfo);
    if (pathname === '/api/demo' && req.method === 'GET') {
      limit(req, 'demo', 60, 60 * 1000);
      return sendJson(res, 200, {
        network: 'testnet',
        mode: PUBLIC_MODE ? 'public' : 'local',
        fingerprint,
        invoices: invoices.filter((i) => i.demo && i.status === 'paid').map(publicInvoice),
      });
    }
    if (pathname === '/api/receipts/verify') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      return await handleVerifyReceipt(req, res);
    }
    const rcMatch = new RegExp(`^/api/invoices/${ID_RE}/receipt$`).exec(pathname);
    if (rcMatch) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      return await handleCreateReceipt(req, res, rcMatch[1]);
    }
    const invMatch = new RegExp(`^/api/invoices/${ID_RE}$`).exec(pathname);
    if (invMatch && req.method === 'GET') {
      limit(req, 'invoice', 240, 60 * 1000);
      const inv = invoices.find((i) => i.id === invMatch[1]);
      return inv ? sendJson(res, 200, publicInvoice(inv)) : sendJson(res, 404, { error: 'Invoice not found.' });
    }

    // Merchant API. Each handler calls requireAdmin first.
    if (pathname === '/api/transactions') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      return await handleTransactions(req, res);
    }
    if (pathname === '/api/verify') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      return await handleVerify(req, res);
    }
    if (pathname === '/api/merchant/session') {
      requireAdmin(req);
      if (req.method === 'GET') return sendJson(res, 200, sessionInfo());
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use GET or POST.' });
      return await handleMerchantSession(req, res);
    }
    if (pathname === '/api/invoices') {
      requireAdmin(req);
      if (req.method === 'GET') return sendJson(res, 200, { invoices: invoices.map(publicInvoice), lastCheck, session: sessionInfo().active, sessions: sessionInfo().sessions });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use GET or POST.' });
      return await handleCreateInvoice(req, res);
    }
    if (pathname === '/api/invoices/check') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
      return await handleCheckNow(req, res);
    }

    if (pathname === '/favicon.ico') { res.writeHead(204, BASE_HEADERS); return res.end(); }
    return sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    if (res.headersSent) return res.end();
    return sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error.' });
  }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Try: $env:PORT=8789; node sp-server.js` : err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`SelectiveProof (Zcash ${MAINNET_ALLOWED ? 'Testnet + Mainnet' : 'Testnet'}) is running at http://${HOST}:${PORT}`);
  console.log(PUBLIC_MODE ? `Mode: public demo at ${publicUrl.origin}. Merchant pages need the admin token.` : 'Mode: local. Only this computer can open it.');
  console.log(`Receipt key fingerprint: ${fingerprint}`);
  console.log(MAINNET_ALLOWED ? `Mainnet tools: on (lightwalletd ${NETS.mainnet.lightwalletd})` : 'Mainnet tools: off on this public host.');
  console.log(scanFn ? `Scanner: ready (lightwalletd ${LIGHTWALLETD})` : 'Scanner: not installed.');
  console.log(merchants.testnet ? 'Merchant session: pre-filled from DEMO_* settings (key stays in memory).' : 'Merchant session: none (paid showcase invoices still work).');
});
