import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import {
  isEstablishedCustomer, importPurchaseHistory, CustomerError, listCustomers, addCustomer, updateCustomer, deleteCustomer,
  parseCsv, tidyPhone, shopifyCustomers, importShopifyCustomers, rememberOrderCustomer, customerProfile,
  isNoEmail, shownEmail, attachEmail, rememberNoEmailCustomer,
} from '../lib/customers.js';

// Wrangler accepts JSON imports without attributes; Node requires attributes.
// Load the actual request handler, with only those two imports adapted.
const hook = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url === new URL('../worker.js', import.meta.url).href) {
      return { ...loaded, source: String(loaded.source).replace(
        /from '(\.\/[^']+\.json)'/g, "from '$1' with { type: 'json' }"
      ) };
    }
    return loaded;
  },
});
const { default: worker } = await import('../worker.js');
hook.deregister();

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { return { meta: statement.run(...args) }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  sqlite.prepare('INSERT INTO customers (email, name, created_at) VALUES (?, ?, ?)')
    .run('returning@example.com', 'Returning Customer', '2026-01-01');
  sqlite.prepare('INSERT INTO products (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('kelp', JSON.stringify({ name: 'Natures Kelp', price_cents: 5000, active: true, taxable: true }), '2026-01-01', '2026-01-01');
  return { db, sqlite };
}

function history(sqlite, email = 'returning@example.com', { qty = 1, price = 5000 } = {}) {
  sqlite.prepare('INSERT INTO purchase_history (email, sold_at, name, qty, price_cents, source) VALUES (?,?,?,?,?,?)')
    .run(email, '2025-01-01', 'Old purchase without a matching product', qty, price, 'shopify');
}

function sale(sqlite, status, { email = 'returning@example.com', refunded = 0, total = 5000 } = {}) {
  sqlite.prepare(
    'INSERT INTO sales (id, sold_at, channel, category, customer_email, items_json, subtotal_cents, tax_cents, total_cents, payment_method, status, refunded_cents)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(crypto.randomUUID(), '2026-01-01', 'direct', 'feed', email, '[]', total, 0, total, 'cash', status, refunded);
}

async function session(email, secret) {
  const payload = Buffer.from(JSON.stringify({ e: email, x: Date.now() + 60000 })).toString('base64url');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))).toString('base64url');
  return 'alhf_session=' + payload + '.' + signature;
}

async function request(db, { signedIn = true, email = 'returning@example.com', method = 'cash', path = '/api/checkout', cookie } = {}) {
  const env = { DB: db, SESSION_SECRET: 'test-only-secret' };
  const headers = { 'content-type': 'application/json' };
  if (signedIn) headers.cookie = cookie || await session('returning@example.com', env.SESSION_SECRET);
  const options = path === '/api/me' ? { headers } : {
    method: 'POST', headers,
    body: JSON.stringify({ items: [{ id: 'kelp', qty: 1 }], payment_method: method,
      email, name: 'Returning Customer', phone: '555-0100', pickup: 'farm', terms_ack: true }),
  };
  const work = [];
  const response = await worker.fetch(new Request('https://store.example.com' + path, options), env, {
    waitUntil(promise) { work.push(promise); },
  });
  await Promise.all(work);
  return { response, body: await response.json() };
}

test('a manually trusted customer is established without purchase history', async (t) => {
  const { db } = database(t);
  assert.equal(await isEstablishedCustomer(db, 'returning@example.com', { trusted: 1 }), true);
});

test('Shopify purchases count, including old products no longer in the catalog', async (t) => {
  const { db, sqlite } = database(t);
  history(sqlite, 'Returning@Example.com');
  assert.equal(await isEstablishedCustomer(db, ' RETURNING@example.com ', { trusted: 0 }), true);
});

for (const status of ['captured', 'recorded']) {
  test('a paid ' + status + ' sale qualifies for cash', async (t) => {
    const { db, sqlite } = database(t);
    sale(sqlite, status, { refunded: 100 });
    assert.equal(await isEstablishedCustomer(db, 'returning@example.com', {}), true);
  });
}

for (const status of ['pending', 'abandoned', 'invoiced', 'failed', 'processing', 'authorized', 'awaiting_cash', 'canceled', 'refunded']) {
  test('an unpaid or unsuccessful ' + status + ' sale does not qualify', async (t) => {
    const { db, sqlite } = database(t);
    sale(sqlite, status);
    assert.equal(await isEstablishedCustomer(db, 'returning@example.com', {}), false);
  });
}

test('a full refund, free order, empty history line and another email do not qualify', async (t) => {
  const { db, sqlite } = database(t);
  sale(sqlite, 'captured', { refunded: 5000 });
  sale(sqlite, 'recorded', { total: 0 });
  sale(sqlite, 'captured', { email: 'someone-else@example.com' });
  history(sqlite, 'someone-else@example.com');
  history(sqlite, 'returning@example.com', { qty: 0 });
  history(sqlite, 'returning@example.com', { price: 0 });
  assert.equal(await isEstablishedCustomer(db, 'returning@example.com', {}), false);
  assert.equal(await isEstablishedCustomer(db, '', {}), false);
});

test('a signed-in Shopify customer can order cash at farm pickup without a trusted flag', async (t) => {
  const { db, sqlite } = database(t);
  history(sqlite);
  const { response, body } = await request(db);
  assert.equal(response.status, 200);
  assert.equal(body.redirect_url, null);
  const order = sqlite.prepare('SELECT * FROM sales WHERE id = ?').get(body.sale_id);
  assert.equal(order.status, 'awaiting_cash');
  assert.equal(order.fulfillment, 'pickup:farm');
  assert.equal(order.payment_method, 'cash');
  assert.equal(order.total_cents, 5194); // 2% discount, then 6% tax.
  assert.equal(order.tax_exempt, 0);
  assert.equal(order.stripe_payment_intent, null);
  assert.equal(sqlite.prepare('SELECT trusted FROM customers').get().trusted, 0);
});

test('current-store paid customers can also order cash', async (t) => {
  const { db, sqlite } = database(t);
  sale(sqlite, 'recorded');
  assert.equal((await request(db)).response.status, 200);
});

test('account reports established separately from card trust', async (t) => {
  const { db, sqlite } = database(t);
  history(sqlite);
  const { body } = await request(db, { path: '/api/me' });
  assert.equal(body.established, true);
  assert.equal(body.trusted, false);
});

test('a guest cannot claim another customer history by typing their email', async (t) => {
  const { db, sqlite } = database(t);
  history(sqlite);
  const { response, body } = await request(db, { signedIn: false });
  assert.equal(response.status, 401);
  assert.match(body.error, /log in/i);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
});

test('a signed-in customer cannot use another customer email', async (t) => {
  const { db, sqlite } = database(t);
  history(sqlite, 'someone-else@example.com');
  assert.equal((await request(db, { email: 'someone-else@example.com' })).response.status, 401);
});

test('a tampered session cannot claim repeat-customer privileges', async (t) => {
  const { db, sqlite } = database(t);
  history(sqlite);
  const cookie = await session('returning@example.com', 'wrong-secret');
  assert.equal((await request(db, { cookie })).response.status, 401);
});

test('a new account receives guidance and cannot create a cash order', async (t) => {
  const { db, sqlite } = database(t);
  const { response, body } = await request(db);
  assert.equal(response.status, 400);
  assert.match(body.error, /contact the farm/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
});

function importedLine(email = 'returning@example.com') {
  return { email, sold_at: '2025-01-01 12:00:00', name: 'Old Kelp', unit: '40 lbs', qty: 1, price_cents: 5000 };
}

test('history import replaces the old snapshot, is repeatable, and preserves customers and sales', async (t) => {
  const { db, sqlite } = database(t);
  history(sqlite, 'removed@example.com');
  sale(sqlite, 'recorded');
  const purchases = Array.from({ length: 85 }, (_, i) => importedLine('customer' + i + '@example.com'));
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await importPurchaseHistory(db, purchases), { imported_lines: 85, customers: 85 });
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_history').get().n, 85);
  }
  assert.equal(await isEstablishedCustomer(db, 'removed@example.com', {}), false);
  assert.equal(await isEstablishedCustomer(db, 'customer84@example.com', {}), true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
  assert.equal(sqlite.prepare('SELECT trusted FROM customers').get().trusted, 0);
});

test('invalid imports leave the existing snapshot untouched', async (t) => {
  const { db, sqlite } = database(t);
  history(sqlite);
  for (const purchases of [[], null, [{ ...importedLine(), qty: 0 }], [{ ...importedLine(), email: 'bad' }]]) {
    await assert.rejects(importPurchaseHistory(db, purchases));
  }
  assert.equal(await isEstablishedCustomer(db, 'returning@example.com', {}), true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_history').get().n, 1);
});

test('an interrupted import cannot grant cash eligibility or erase the previous snapshot', async (t) => {
  const { db, sqlite } = database(t);
  history(sqlite);
  let batches = 0;
  const failing = { ...db, async batch(statements) {
    if (++batches === 2) {
      assert.equal(await isEstablishedCustomer(db, 'new@example.com', {}), false);
      throw new Error('interrupted upload');
    }
    return db.batch(statements);
  } };
  await assert.rejects(importPurchaseHistory(failing, Array.from({ length: 41 }, () => importedLine('new@example.com'))), /interrupted upload/);
  assert.equal(await isEstablishedCustomer(db, 'returning@example.com', {}), true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_history').get().n, 1);
});

test('history import requires admin authentication and rejects cross-site changes', async (t) => {
  const { db } = database(t);
  const env = { DB: db, ADMIN_PASSWORD: 'test-admin-password' };
  const makeRequest = (headers = {}) => new Request('https://store.example.com/api/admin/customer-history/import', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ source: 'shopify', purchases: [importedLine()] }),
  });
  assert.equal((await worker.fetch(makeRequest(), env, {})).status, 401);
  const authorization = 'Basic ' + Buffer.from('admin:test-admin-password').toString('base64');
  assert.equal((await worker.fetch(makeRequest({ authorization, origin: 'https://other.example.com' }), env, {})).status, 403);
  const response = await worker.fetch(makeRequest({ authorization }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported_lines: 1, customers: 1 });
});

// ---- the admin's customer list ------------------------------------------------

const rejectsWith = (promise, status, message) =>
  assert.rejects(promise, (e) => e instanceof CustomerError && e.status === status && (!message || message.test(e.message)));

test('the list shows everyone by name, nameless customers by email', async (t) => {
  const { db, sqlite } = database(t);
  sqlite.prepare('INSERT INTO customers (email, name, created_at) VALUES (?,?,?)').run('zed@example.com', null, '2026-02-01');
  sqlite.prepare('INSERT INTO customers (email, name, created_at) VALUES (?,?,?)').run('amy@example.com', 'amy Adams', '2026-02-01');
  const { customers } = await listCustomers(db);
  assert.deepEqual(customers.map((c) => c.email), ['amy@example.com', 'returning@example.com', 'zed@example.com']);
  // The invoice picker reads these.
  for (const key of ['email', 'name', 'phone', 'tax_exempt', 'trusted']) assert.ok(key in customers[0]);
});

test('the detailed list counts paid orders and Shopify lines, and finds history with no customer row', async (t) => {
  const { db, sqlite } = database(t);
  sale(sqlite, 'captured');
  sale(sqlite, 'recorded', { email: 'RETURNING@example.com' });
  sale(sqlite, 'captured', { refunded: 5000 });   // fully refunded: not a paid order
  sale(sqlite, 'awaiting_cash');                  // not paid yet
  history(sqlite); history(sqlite);
  history(sqlite, 'kim@example.com'); history(sqlite, 'Kim@Example.com');
  history(sqlite, 'Returning@example.com');       // same person, other spelling: not "missing"
  const { customers, history_only } = await listCustomers(db, { detail: true });
  assert.equal(customers[0].paid_orders, 2);
  assert.equal(customers[0].history_lines, 3);
  assert.deepEqual(history_only.map((h) => [h.email, h.lines]), [['Kim@Example.com', 1], ['kim@example.com', 1]]);
  assert.equal(history_only[0].last_purchase, '2025-01-01');
});

test('adding a customer cleans what was typed and stores the flags', async (t) => {
  const { db } = database(t);
  const c = await addCustomer(db, { email: '  Kim@Example.COM ', name: '  Kim   Smith ', phone: ' 208 555 0101 ',
    tax_exempt: true, exemption_ref: 'ST-101 on file', trusted: true, notes: 'Pays at pickup', bogus: 'dropped' }, '2026-11-24T00:00:00Z');
  assert.deepEqual({ ...c }, { email: 'kim@example.com', name: 'Kim Smith', phone: '208 555 0101', tax_exempt: 1,
    exemption_ref: 'ST-101 on file', trusted: 1, notes: 'Pays at pickup', created_at: '2026-11-24T00:00:00Z' });
  const plain = await addCustomer(db, { email: 'bri@example.com', name: 'Bri' });
  assert.equal(plain.tax_exempt, 0);
  assert.equal(plain.trusted, 0);
  assert.equal(plain.phone, null);
});

test('adding needs a real email and a name, and never overwrites someone we have', async (t) => {
  const { db, sqlite } = database(t);
  await rejectsWith(addCustomer(db, { email: 'not an email', name: 'X' }), 400, /email/);
  await rejectsWith(addCustomer(db, { email: '', name: 'X' }), 400, /email/);
  await rejectsWith(addCustomer(db, { email: 'new@example.com', name: '   ' }), 400, /name/);
  sqlite.prepare("UPDATE customers SET trusted = 1 WHERE email = 'returning@example.com'").run();
  await rejectsWith(addCustomer(db, { email: 'Returning@Example.com', name: 'Someone Else' }), 409, /already/);
  const row = sqlite.prepare("SELECT name, trusted FROM customers WHERE email = 'returning@example.com'").get();
  assert.deepEqual({ ...row }, { name: 'Returning Customer', trusted: 1 });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
});

test('editing changes details and flags but never the email, orders or history', async (t) => {
  const { db, sqlite } = database(t);
  sale(sqlite, 'captured'); history(sqlite);
  const c = await updateCustomer(db, { email: 'RETURNING@example.com', name: 'Returning C.', phone: '208-555-0102',
    tax_exempt: true, exemption_ref: 'ST-101 2026-05', trusted: true, notes: 'Farm stand' });
  assert.deepEqual({ ...c, created_at: undefined }, { email: 'returning@example.com', name: 'Returning C.', phone: '208-555-0102',
    tax_exempt: 1, exemption_ref: 'ST-101 2026-05', trusted: 1, notes: 'Farm stand', created_at: undefined });
  // Turning flags off and blanking optional fields works too.
  const cleared = await updateCustomer(db, { email: 'returning@example.com', name: '', tax_exempt: false, trusted: false });
  assert.deepEqual([cleared.name, cleared.phone, cleared.tax_exempt, cleared.trusted, cleared.notes], [null, null, 0, 0, null]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_history').get().n, 1);
  await rejectsWith(updateCustomer(db, { email: 'nobody@example.com', name: 'N' }), 404);
  await rejectsWith(updateCustomer(db, { email: 'oops', name: 'N' }), 400, /email/);
});

test('a trusted flag set in the admin is what the checkout reads', async (t) => {
  const { db } = database(t);
  const c = await addCustomer(db, { email: 'friend@example.com', name: 'Friend', trusted: true });
  assert.equal(await isEstablishedCustomer(db, c.email, c), true);
  const off = await updateCustomer(db, { email: c.email, name: 'Friend', trusted: false });
  assert.equal(await isEstablishedCustomer(db, c.email, off), false);
});

test('removing a customer deletes only the record; orders and history stay', async (t) => {
  const { db, sqlite } = database(t);
  sale(sqlite, 'captured'); history(sqlite);
  assert.deepEqual(await deleteCustomer(db, ' Returning@Example.com '), { removed: 'returning@example.com' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_history').get().n, 1);
  // Their past purchases still make them a repeat customer.
  assert.equal(await isEstablishedCustomer(db, 'returning@example.com', null), true);
  await rejectsWith(deleteCustomer(db, 'returning@example.com'), 404);
  await rejectsWith(deleteCustomer(db, ''), 400);
});

async function adminCall(db, method, body, { path = '/api/admin/customers', headers = {} } = {}) {
  const env = { DB: db, ADMIN_PASSWORD: 'test-admin-password' };
  const authorization = 'Basic ' + Buffer.from('admin:test-admin-password').toString('base64');
  const response = await worker.fetch(new Request('https://store.example.com' + path, {
    method, headers: { 'content-type': 'application/json', authorization, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), env, {});
  return { response, body: await response.json() };
}

test('the customer endpoint is admin-only and rejects cross-site changes', async (t) => {
  const { db, sqlite } = database(t);
  const env = { DB: db, ADMIN_PASSWORD: 'test-admin-password' };
  const bare = (method, body) => worker.fetch(new Request('https://store.example.com/api/admin/customers', {
    method, headers: { 'content-type': 'application/json' }, body }), env, {});
  assert.equal((await bare('GET')).status, 401);
  assert.equal((await bare('POST', JSON.stringify({ action: 'delete', email: 'returning@example.com' }))).status, 401);
  const cross = await adminCall(db, 'POST', { action: 'delete', email: 'returning@example.com' }, { headers: { origin: 'https://other.example.com' } });
  assert.equal(cross.response.status, 403);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
});

test('add, edit and remove a customer through the admin endpoint', async (t) => {
  const { db, sqlite } = database(t);
  let r = await adminCall(db, 'POST', { action: 'add', email: 'bri@example.com', name: 'Bri Jones', phone: '208-555-0103' });
  assert.equal(r.response.status, 200);
  assert.equal(r.body.customer.email, 'bri@example.com');
  r = await adminCall(db, 'POST', { action: 'add', email: 'bri@example.com', name: 'Again' });
  assert.equal(r.response.status, 409);
  r = await adminCall(db, 'POST', { action: 'update', email: 'bri@example.com', name: 'Bri J.', trusted: true });
  assert.equal(r.response.status, 200);
  assert.equal(sqlite.prepare("SELECT name, trusted FROM customers WHERE email = 'bri@example.com'").get().trusted, 1);
  r = await adminCall(db, 'GET', undefined, { path: '/api/admin/customers?detail=1' });
  assert.deepEqual(r.body.customers.map((c) => c.email), ['bri@example.com', 'returning@example.com']);
  assert.ok('history_only' in r.body && 'paid_orders' in r.body.customers[0]);
  r = await adminCall(db, 'GET', undefined);
  assert.ok(!('history_only' in r.body) && !('paid_orders' in r.body.customers[0]));
  r = await adminCall(db, 'POST', { action: 'delete', email: 'bri@example.com' });
  assert.deepEqual(r.body, { ok: true, removed: 'bri@example.com' });
  r = await adminCall(db, 'POST', { action: 'delete', email: 'bri@example.com' });
  assert.equal(r.response.status, 404);
  assert.equal((await adminCall(db, 'POST', { action: 'explode' })).response.status, 400);
  assert.equal((await adminCall(db, 'POST', 'not json')).response.status, 400);
  assert.equal((await adminCall(db, 'PUT', {})).response.status, 405);
  assert.equal((await adminCall(db, 'POST', { action: 'add', email: 'bad', name: 'X' })).response.status, 400);
});

// ---- importing Shopify's customer export ---------------------------------------

// Shaped like the real export (BOM, apostrophe-guarded ids and phones, quoting), with invented people.
const SHOPIFY_CSV = '\uFEFF' + [
  'Customer ID,First Name,Last Name,Email,Default Address Phone,Phone,Total Spent,Total Orders,Note,Tax Exempt,Tags',
  "'1,Pat,Example,Pat@Example.com,,'+12085550101,310.58,4,,no,",
  `'2,Sam,"O'Neil, Jr.",sam@example.com,"'(208) 555-0102",,3068.10,1,,yes,newsletter`,
  "'3,Newsletter,Only,news@example.com,,,0.00,0,,no,newsletter",
  "'4,Pat,Example,second-pat@example.com,,,0.00,0,,no,Login with Shop",
  "'5,Lee,Nomail,,,'+12085550103,50.00,2,,no,",
  "'6,,,ghost@example.com,,,20.00,1,,no,",
  "'7,Returning,Customer,RETURNING@example.com,,'+12085550104,80.00,3,,no,",
  "'8,Pat,Dupe,pat@example.com,,,5.00,1,,no,",
  "'9,,,,,,15.00,1,,no,",
].join('\r\n') + '\r\n';

test('the CSV reader handles quotes, commas and line breaks inside quotes, a BOM and CRLF', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x, ""y""","line\nbreak"\r\n\r\nlast,'), [['a', 'b'], ['x, "y"', 'line\nbreak'], ['last', '']]);
  assert.deepEqual(parseCsv('5" pipe,ok'), [['5" pipe', 'ok']]);
  assert.deepEqual(parseCsv(''), []);
});

test('phone numbers read the way the farm writes them', () => {
  assert.equal(tidyPhone("'+12085550101"), '208-555-0101');
  assert.equal(tidyPhone('(208) 555-0102'), '208-555-0102');
  assert.equal(tidyPhone('2085550103'), '208-555-0103');
  assert.equal(tidyPhone(''), '');
  assert.equal(tidyPhone('+44 20 7946 0958'), '+44 20 7946 0958');
});

test('the export is read for people who have ordered and have an email', () => {
  const r = shopifyCustomers(SHOPIFY_CSV);
  assert.equal(r.rows, 9);
  assert.deepEqual(r.people.map((p) => [p.email, p.name, p.phone, p.orders]), [
    ['pat@example.com', 'Pat Example', '208-555-0101', 4],         // the account with orders wins the duplicate
    ['sam@example.com', "Sam O'Neil, Jr.", '208-555-0102', 1],
    ['shopify-5@no-email.invalid', 'Lee Nomail', '208-555-0103', 2], // no email: kept by name and phone, keyed by Shopify id
    ['ghost@example.com', null, null, 1],
    ['returning@example.com', 'Returning Customer', '208-555-0104', 3],
  ]);
  assert.equal(r.duplicates, 1);
  assert.equal(r.never_ordered, 2);                                 // newsletter signups and "Login with Shop" accounts
  assert.deepEqual(r.no_contact, [{ orders: 1 }]);                   // no email, name or phone: nobody to keep
  assert.deepEqual(r.tax_exempt, [{ name: "Sam O'Neil, Jr.", email: 'sam@example.com' }]);
  assert.equal(shopifyCustomers(SHOPIFY_CSV, { includeNeverOrdered: true }).people.length, 7);
});

test('something that is not a customer export is refused', () => {
  for (const bad of ['', '   ', 'name,total\nx,1', 'Name,Email\nx,y@example.com']) {
    assert.throws(() => shopifyCustomers(bad), CustomerError);
  }
  assert.throws(() => shopifyCustomers(null), CustomerError);
});

test('a dry run reports and writes nothing', async (t) => {
  const { db, sqlite } = database(t);
  const r = await importShopifyCustomers(db, SHOPIFY_CSV);
  assert.equal(r.dry_run, true);
  assert.deepEqual(r.add.map((a) => a.email), ['pat@example.com', 'sam@example.com', 'shopify-5@no-email.invalid', 'ghost@example.com']);
  assert.deepEqual(r.add.map((a) => a.has_email), [1, 1, 0, 1]);
  assert.equal(r.already, 0);
  assert.equal(r.filled, 1);           // returning@example.com exists with a name but no phone
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
});

test('importing adds missing people, fills blanks only, and never touches flags or other tables', async (t) => {
  const { db, sqlite } = database(t);
  sqlite.prepare("UPDATE customers SET trusted = 1, tax_exempt = 1, exemption_ref = 'ST-101', name = 'Kept Name', notes = 'mine' WHERE email = 'returning@example.com'").run();
  sale(sqlite, 'captured'); history(sqlite);
  const r = await importShopifyCustomers(db, SHOPIFY_CSV, { dryRun: false, now: '2026-11-24T00:00:00Z' });
  assert.equal(r.dry_run, false);
  const rows = Object.fromEntries(sqlite.prepare('SELECT * FROM customers').all().map((c) => [c.email, { ...c }]));
  assert.deepEqual(Object.keys(rows).sort(), ['ghost@example.com', 'pat@example.com', 'returning@example.com', 'sam@example.com', 'shopify-5@no-email.invalid']);
  // The existing customer keeps their name, flags and notes; only the blank phone is filled.
  assert.deepEqual([rows['returning@example.com'].name, rows['returning@example.com'].phone, rows['returning@example.com'].trusted,
    rows['returning@example.com'].tax_exempt, rows['returning@example.com'].exemption_ref, rows['returning@example.com'].notes],
  ['Kept Name', '208-555-0104', 1, 1, 'ST-101', 'mine']);
  // New people start with no special treatment — even Sam, whom Shopify had as tax-exempt.
  for (const e of ['pat@example.com', 'sam@example.com', 'ghost@example.com', 'shopify-5@no-email.invalid']) {
    assert.deepEqual([rows[e].trusted, rows[e].tax_exempt, rows[e].exemption_ref, rows[e].created_at], [0, 0, null, '2026-11-24T00:00:00Z']);
  }
  assert.equal(rows['sam@example.com'].name, "Sam O'Neil, Jr.");
  assert.deepEqual([rows['shopify-5@no-email.invalid'].name, rows['shopify-5@no-email.invalid'].phone], ['Lee Nomail', '208-555-0103']);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_history').get().n, 1);
});

test('running the same import again changes nothing', async (t) => {
  const { db, sqlite } = database(t);
  await importShopifyCustomers(db, SHOPIFY_CSV, { dryRun: false });
  const before = JSON.stringify(sqlite.prepare('SELECT * FROM customers ORDER BY email').all());
  const again = await importShopifyCustomers(db, SHOPIFY_CSV, { dryRun: false });
  assert.deepEqual([again.add.length, again.filled, again.already], [0, 0, 5]);
  assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM customers ORDER BY email').all()), before);
});

test('an existing customer whose email Shopify capitalizes differently is not added twice', async (t) => {
  const { db, sqlite } = database(t);
  sqlite.prepare('INSERT INTO customers (email, name, created_at) VALUES (?,?,?)').run('pat@example.com', 'Pat', '2026-01-01');
  const r = await importShopifyCustomers(db, SHOPIFY_CSV, { dryRun: false });
  assert.ok(!r.add.some((a) => a.email === 'pat@example.com'));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE email = 'pat@example.com'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT phone FROM customers WHERE email = 'pat@example.com'").get().phone, '208-555-0101');
});

test('the import endpoint is a dry run unless told otherwise', async (t) => {
  const { db, sqlite } = database(t);
  let r = await adminCall(db, 'POST', { action: 'import', csv: SHOPIFY_CSV });
  assert.equal(r.response.status, 200);
  assert.equal(r.body.dry_run, true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
  r = await adminCall(db, 'POST', { action: 'import', csv: SHOPIFY_CSV, dry_run: false, include_never_ordered: true });
  assert.equal(r.body.dry_run, false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 7);
  r = await adminCall(db, 'POST', { action: 'import', csv: 'not,a,customer,file\n1,2,3,4' });
  assert.equal(r.response.status, 400);
  assert.match(r.body.error, /Shopify/);
});

// ---- whoever an order is entered for joins the customer list ----------------------

/** A checkout from a visitor, with Stripe answered by a stand-in. */
async function checkoutAs(db, { email, name = 'New Person', phone = '208-555-0150', method = 'card', cookie, stripe = 'ok' } = {}) {
  const env = { DB: db, SESSION_SECRET: 'test-only-secret', STRIPE_SECRET_KEY: 'sk_test_stand_in' };
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => stripe === 'ok'
    ? new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://pay.example/session', payment_intent: 'pi_test_1' }))
    : new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
  const work = [];
  try {
    const response = await worker.fetch(new Request('https://store.example.com/api/checkout', {
      method: 'POST', headers,
      body: JSON.stringify({ items: [{ id: 'kelp', qty: 1 }], payment_method: method, email, name, phone, pickup: 'farm', terms_ack: true }),
    }), env, { waitUntil(p) { work.push(p); } });
    await Promise.all(work);
    return { response, body: await response.json() };
  } catch (error) {
    return { error };   // Stripe being down surfaces as an exception from the worker
  } finally { globalThis.fetch = realFetch; }
}
const customerRow = (sqlite, email) => { const r = sqlite.prepare('SELECT * FROM customers WHERE email = ?').get(email); return r ? { ...r } : null; };

test('a guest who orders for the first time is added to the customer list', async (t) => {
  const { db, sqlite } = database(t);
  const { response, body } = await checkoutAs(db, { email: 'newbie@example.com', name: 'Nora Newbie', phone: '208-555-0150' });
  assert.equal(response.status, 200);
  assert.ok(body.sale_id);
  const c = customerRow(sqlite, 'newbie@example.com');
  assert.deepEqual([c.name, c.phone, c.trusted, c.tax_exempt, c.exemption_ref], ['Nora Newbie', '208-555-0150', 0, 0, null]);
  assert.equal(sqlite.prepare('SELECT customer_email FROM sales WHERE id = ?').get(body.sale_id).customer_email, 'newbie@example.com');
});

test('a second order from the same guest does not add them twice or change them', async (t) => {
  const { db, sqlite } = database(t);
  await checkoutAs(db, { email: 'newbie@example.com', name: 'Nora Newbie' });
  await checkoutAs(db, { email: 'NEWBIE@example.com', name: 'A Different Name', phone: '999' });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE email LIKE 'newbie%'").get().n, 1);
  assert.equal(customerRow(sqlite, 'newbie@example.com').name, 'Nora Newbie');
});

test('a guest typing an existing customer’s email cannot edit that customer', async (t) => {
  const { db, sqlite } = database(t);
  sqlite.prepare("UPDATE customers SET phone = NULL, trusted = 1, tax_exempt = 1 WHERE email = 'returning@example.com'").run();
  await checkoutAs(db, { email: 'returning@example.com', name: 'Mallory', phone: '666-0000' });
  const c = customerRow(sqlite, 'returning@example.com');
  assert.deepEqual([c.name, c.phone, c.trusted, c.tax_exempt], ['Returning Customer', null, 1, 1]);
});

test('a signed-in customer keeps one record, updated with the details they just used', async (t) => {
  const { db, sqlite } = database(t);
  const cookie = await session('returning@example.com', 'test-only-secret');
  await checkoutAs(db, { email: 'returning@example.com', name: 'Returning C.', phone: '208-555-0188', cookie });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
  const c = customerRow(sqlite, 'returning@example.com');
  assert.deepEqual([c.name, c.phone], ['Returning C.', '208-555-0188']);
});

test('an order that is turned away adds nobody', async (t) => {
  const { db, sqlite } = database(t);
  // Cash at pickup needs an established, signed-in customer: this guest is refused.
  const r = await checkoutAs(db, { email: 'nope@example.com', method: 'cash' });
  assert.equal(r.response.status, 401);
  assert.equal(customerRow(sqlite, 'nope@example.com'), null);
  const bad = await checkoutAs(db, { email: 'not-an-email' });
  assert.equal(bad.response.status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
});

test('the customer is kept even if Stripe cannot start the payment, and a list problem never loses an order', async (t) => {
  const { db, sqlite } = database(t);
  const down = await checkoutAs(db, { email: 'later@example.com', stripe: 'down' });
  assert.match(down.error.message, /Stripe/);
  assert.ok(customerRow(sqlite, 'later@example.com'));          // they did enter an order
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sales WHERE customer_email = 'later@example.com'").get().n, 1);

  // If saving the customer itself fails, the order still goes through.
  const broken = { ...db, prepare(sql) { if (/INTO customers/.test(sql)) throw new Error('customers table locked'); return db.prepare(sql); } };
  const log = console.error; console.error = () => {};
  try {
    const ok = await checkoutAs(broken, { email: 'unlucky@example.com' });
    assert.equal(ok.response.status, 200);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sales WHERE customer_email = 'unlucky@example.com'").get().n, 1);
  } finally { console.error = log; }
});

test('a sale recorded by hand adds its buyer to the list when an email is given', async (t) => {
  const { db, sqlite } = database(t);
  const record = (extra) => adminCall(db, 'POST', { subtotal_cents: 1000, category: 'milk', payment_method: 'cash', ...extra }, { path: '/api/admin/record' });
  let r = await record({ customer_name: 'Milk Buyer', customer_email: ' Milk@Example.com ', customer_phone: '208-555-0160' });
  assert.equal(r.response.status, 200);
  const c = customerRow(sqlite, 'milk@example.com');
  assert.deepEqual([c.name, c.phone, c.trusted, c.tax_exempt], ['Milk Buyer', '208-555-0160', 0, 0]);
  // No email, or one that is not an email: the sale records, nobody is added.
  assert.equal((await record({ customer_name: 'Walk-up' })).response.status, 200);
  assert.equal((await record({ customer_name: 'Typo', customer_email: 'typo' })).response.status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sales WHERE channel = 'direct'").get().n, 3);
  // An existing customer with no phone gets the phone filled in; their flags and name stand.
  sqlite.prepare("UPDATE customers SET trusted = 1, phone = NULL WHERE email = 'returning@example.com'").run();
  await record({ customer_name: 'Someone Else', customer_email: 'returning@example.com', customer_phone: '208-555-0161' });
  const e = customerRow(sqlite, 'returning@example.com');
  assert.deepEqual([e.name, e.phone, e.trusted], ['Returning Customer', '208-555-0161', 1]);
});

test('an invoice written for a new email adds that customer', async (t) => {
  const { db, sqlite } = database(t);
  const r = await adminCall(db, 'POST', {
    action: 'create', send: false, customer: { email: 'Bulk@Example.com', name: 'Bulk Buyer', phone: '208-555-0170' }, pickup: 'farm',
    lines: [{ name: 'Freight', qty: 1, price_cents: 2500, taxable: false }],
  }, { path: '/api/admin/invoice' });
  assert.equal(r.response.status, 200);
  const c = customerRow(sqlite, 'bulk@example.com');
  assert.deepEqual([c.name, c.phone, c.trusted], ['Bulk Buyer', '208-555-0170', 0]);
});

test('remembering an order’s customer: adds once, fills blanks only when allowed, ignores bad emails', async (t) => {
  const { db, sqlite } = database(t);
  assert.equal(await rememberOrderCustomer(db, { email: 'x@example.com', name: 'X' }), true);
  assert.equal(await rememberOrderCustomer(db, { email: 'X@example.com', name: 'Y', phone: '1' }), false);
  assert.deepEqual([customerRow(sqlite, 'x@example.com').name, customerRow(sqlite, 'x@example.com').phone], ['X', null]);
  assert.equal(await rememberOrderCustomer(db, { email: 'x@example.com', name: 'Y', phone: '208-555-0101' }, { fillBlanks: true }), false);
  assert.deepEqual([customerRow(sqlite, 'x@example.com').name, customerRow(sqlite, 'x@example.com').phone], ['X', '208-555-0101']);
  assert.equal(await rememberOrderCustomer(db, { email: '', name: 'Nobody' }), false);
  assert.equal(await rememberOrderCustomer(db, { email: 'bad', name: 'Nobody' }, { fillBlanks: true }), false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 2);
});

// ---- one customer's page --------------------------------------------------------

function orderRow(sqlite, { id, email = 'returning@example.com', channel = 'online', status = 'captured', total = 5000, refunded = 0, items = '[{"name":"Kelp","qty":2}]', at = '2026-03-01T12:00:00Z' }) {
  sqlite.prepare(
    'INSERT INTO sales (id, sold_at, channel, category, customer_email, items_json, subtotal_cents, tax_cents, total_cents, payment_method, status, refunded_cents)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, at, channel, 'feed', email, items, total, 0, total, 'card', status, refunded);
}

test('a customer page shows the record, their orders here and their Shopify purchases', async (t) => {
  const { db, sqlite } = database(t);
  orderRow(sqlite, { id: 'aaaaaaaa-1', at: '2026-01-01T00:00:00Z' });
  orderRow(sqlite, { id: 'bbbbbbbb-2', email: 'RETURNING@example.com', channel: 'invoice', status: 'invoiced', total: 9000, at: '2026-02-01T00:00:00Z',
    items: '[{"name":"A"},{"name":"B"},{"name":"C"},{"name":"D"},{"name":"E"}]' });
  orderRow(sqlite, { id: 'cccccccc-3', email: 'someone-else@example.com' });
  orderRow(sqlite, { id: 'dddddddd-4', channel: 'location' });
  history(sqlite); history(sqlite, 'someone-else@example.com');
  const p = await customerProfile(db, ' Returning@Example.com ');
  assert.equal(p.email, 'returning@example.com');
  assert.equal(p.customer.name, 'Returning Customer');
  assert.deepEqual(p.orders.map((o) => [o.ref, o.status, o.total_cents, o.items]), [
    ['bbbbbbbb', 'invoiced', 9000, 'A, B, C + 2 more'],      // newest first; long orders are shortened
    ['aaaaaaaa', 'captured', 5000, '2 × Kelp'],
  ]);                                                         // no one else's orders, no consignment reports
  assert.equal(p.history.length, 1);
  assert.equal(p.history[0].name, 'Old purchase without a matching product');
});

test('a person who only ever bought on Shopify still has a page, and a stranger does not', async (t) => {
  const { db, sqlite } = database(t);
  history(sqlite, 'shopify-only@example.com');
  const p = await customerProfile(db, 'Shopify-Only@example.com');
  assert.equal(p.customer, null);
  assert.equal(p.history.length, 1);
  assert.deepEqual(p.orders, []);
  await rejectsWith(customerProfile(db, 'stranger@example.com'), 404);
  await rejectsWith(customerProfile(db, 'not an email'), 400, /email/);
});

test('the customer page is served to admins only, by email', async (t) => {
  const { db, sqlite } = database(t);
  orderRow(sqlite, { id: 'eeeeeeee-5' });
  const r = await adminCall(db, 'GET', undefined, { path: '/api/admin/customers?email=returning%40example.com' });
  assert.equal(r.response.status, 200);
  assert.equal(r.body.customer.email, 'returning@example.com');
  assert.equal(r.body.orders.length, 1);
  assert.equal((await adminCall(db, 'GET', undefined, { path: '/api/admin/customers?email=stranger%40example.com' })).response.status, 404);
  const bare = await worker.fetch(new Request('https://store.example.com/api/admin/customers?email=returning%40example.com'),
    { DB: db, ADMIN_PASSWORD: 'test-admin-password' }, {});
  assert.equal(bare.status, 401);
});

// ---- customers with no email ----------------------------------------------------

test('a customer with no email is kept by name and phone, under an address nothing can reach', async (t) => {
  const { db } = database(t);
  const c = await addCustomer(db, { email: '', name: 'Walt Phoneonly', phone: '(208) 555-0142', notes: 'Calls on Sundays' });
  assert.ok(isNoEmail(c.email));
  assert.equal(shownEmail(c.email), '');
  assert.deepEqual([c.name, c.phone, c.trusted, c.tax_exempt], ['Walt Phoneonly', '(208) 555-0142', 0, 0]);
  const list = await listCustomers(db);
  assert.deepEqual(list.customers.map((x) => [x.name, x.has_email]), [['Returning Customer', 1], ['Walt Phoneonly', 0]]);
  const p = await customerProfile(db, c.email);
  assert.equal(p.has_email, false);
  assert.equal(p.customer.name, 'Walt Phoneonly');
  assert.equal(shownEmail('kim@example.com'), 'kim@example.com');
});

test('without an email a name and phone are both needed, and the same person is not added twice', async (t) => {
  const { db, sqlite } = database(t);
  await rejectsWith(addCustomer(db, { email: '', name: 'No Phone' }), 400, /phone/);
  await rejectsWith(addCustomer(db, { email: '', name: 'Short Phone', phone: '555-0142' }), 400, /phone/);
  await rejectsWith(addCustomer(db, { email: '', name: '', phone: '208-555-0142' }), 400, /name/);
  await addCustomer(db, { email: '', name: 'Walt Phoneonly', phone: '208-555-0142' });
  await rejectsWith(addCustomer(db, { email: '', name: 'walt  PHONEONLY', phone: '1 (208) 555 0142' }), 409, /already/);
  // The made-up address cannot be typed in as if it were real.
  await rejectsWith(addCustomer(db, { email: 'x@no-email.invalid', name: 'Typed It' }), 400, /reserved/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 2);
});

test('giving a no-email customer their email moves their orders and history to it', async (t) => {
  const { db, sqlite } = database(t);
  const c = await addCustomer(db, { email: '', name: 'Walt Phoneonly', phone: '208-555-0142', trusted: true, notes: 'Sundays' });
  orderRow(sqlite, { id: 'ffffffff-6', email: c.email });
  history(sqlite, c.email);
  const updated = await updateCustomer(db, { email: c.email, new_email: ' Walt@Example.com ', name: 'Walt Phoneonly', phone: '208-555-0142', trusted: true, notes: 'Sundays' });
  assert.equal(updated.email, 'walt@example.com');
  assert.deepEqual([updated.name, updated.trusted, updated.notes], ['Walt Phoneonly', 1, 'Sundays']);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers WHERE email = ?').get(c.email).n, 0);
  assert.equal(sqlite.prepare("SELECT customer_email AS e FROM sales WHERE id = 'ffffffff-6'").get().e, 'walt@example.com');
  assert.equal(sqlite.prepare('SELECT email FROM purchase_history WHERE email = ?').get('walt@example.com').email, 'walt@example.com');
  // From then on they are an ordinary customer and cannot be renamed again.
  await rejectsWith(updateCustomer(db, { email: 'walt@example.com', new_email: 'other@example.com', name: 'W' }), 400, /already has an email/);
});

test('an email that already belongs to a customer means the same person: the records are merged', async (t) => {
  const { db, sqlite } = database(t);
  sqlite.prepare("UPDATE customers SET trusted = 1, phone = NULL WHERE email = 'returning@example.com'").run();
  const c = await addCustomer(db, { email: '', name: 'Returning Cust.', phone: '208-555-0177', notes: 'from the phone list', tax_exempt: true });
  orderRow(sqlite, { id: 'abcdabcd-7', email: c.email });
  const merged = await updateCustomer(db, { email: c.email, new_email: 'Returning@Example.com', name: 'Returning Cust.', phone: '208-555-0177', tax_exempt: true, notes: 'from the phone list' });
  assert.equal(merged.merged, true);
  // The existing customer keeps their name and settings; only blanks are filled. Nothing silently becomes tax-exempt.
  assert.deepEqual([merged.email, merged.name, merged.phone, merged.trusted, merged.tax_exempt, merged.notes],
    ['returning@example.com', 'Returning Customer', '208-555-0177', 1, 0, 'from the phone list']);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
  assert.equal(sqlite.prepare("SELECT customer_email AS e FROM sales WHERE id = 'abcdabcd-7'").get().e, 'returning@example.com');
  await rejectsWith(attachEmail(db, 'returning@example.com', 'x@example.com'), 400);
  await rejectsWith(attachEmail(db, 'nobody@no-email.invalid', 'x@example.com'), 404);
});

test('a sale recorded by hand with a name and phone but no email adds that customer once', async (t) => {
  const { db, sqlite } = database(t);
  const record = (extra) => adminCall(db, 'POST', { subtotal_cents: 1000, category: 'milk', payment_method: 'cash', ...extra }, { path: '/api/admin/record' });
  assert.equal((await record({ customer_name: 'Walt Phoneonly', customer_phone: '208-555-0142' })).response.status, 200);
  assert.equal((await record({ customer_name: 'Walt Phoneonly', customer_phone: '(208) 555-0142' })).response.status, 200);
  const walt = sqlite.prepare("SELECT * FROM customers WHERE name = 'Walt Phoneonly'").all();
  assert.equal(walt.length, 1);
  assert.ok(isNoEmail(walt[0].email));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sales WHERE customer_email = ?').get(walt[0].email).n, 2);
  // A name alone is not enough to say who someone is.
  await record({ customer_name: 'Just A Name' });
  await record({ customer_name: 'Short', customer_phone: '555-0100' });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE name IN ('Just A Name', 'Short')").get().n, 0);
  assert.equal(await rememberNoEmailCustomer(db, { name: 'X', phone: '' }), null);
});

test('the endpoint adds a customer with no email and later gives them theirs', async (t) => {
  const { db, sqlite } = database(t);
  let r = await adminCall(db, 'POST', { action: 'add', email: '', name: 'Walt Phoneonly', phone: '208-555-0142' });
  assert.equal(r.response.status, 200);
  const key = r.body.customer.email;
  assert.ok(isNoEmail(key));
  r = await adminCall(db, 'GET', undefined, { path: '/api/admin/customers?detail=1' });
  assert.equal(r.body.customers.find((c) => c.email === key).has_email, 0);
  r = await adminCall(db, 'POST', { action: 'update', email: key, new_email: 'walt@example.com', name: 'Walt Phoneonly', phone: '208-555-0142' });
  assert.equal(r.response.status, 200);
  assert.equal(r.body.customer.email, 'walt@example.com');
  r = await adminCall(db, 'POST', { action: 'update', email: 'walt@example.com', new_email: 'nope', name: 'W' });
  assert.equal(r.response.status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 2);
});

test('a Shopify customer with no email who is already here by name and phone is not added again', async (t) => {
  const { db, sqlite } = database(t);
  await addCustomer(db, { email: '', name: 'Lee Nomail', phone: '208-555-0103' });
  const r = await importShopifyCustomers(db, SHOPIFY_CSV, { dryRun: false });
  assert.ok(!r.add.some((a) => a.name === 'Lee Nomail'));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE name = 'Lee Nomail'").get().n, 1);
});
