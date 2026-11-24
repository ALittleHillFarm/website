import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import {
  isEstablishedCustomer, importPurchaseHistory, CustomerError, listCustomers, addCustomer, updateCustomer, deleteCustomer,
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
