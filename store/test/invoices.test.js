import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// Same loader trick as customers.test.js: wrangler accepts bare JSON imports, Node does not.
const hook = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url === new URL('../worker.js', import.meta.url).href) {
      return { ...loaded, source: String(loaded.source).replace(/from '(\.\/[^']+\.json)'/g, "from '$1' with { type: 'json' }") };
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
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return { db, sqlite };
}

const env = (db) => ({ DB: db, ADMIN_PASSWORD: 'test-only', DEV_EMAIL_LOG: '1' });
const auth = 'Basic ' + Buffer.from('admin:test-only').toString('base64');

async function call(db, path, { body, method } = {}) {
  const headers = { authorization: auth, 'content-type': 'application/json' };
  const work = [];
  const res = await worker.fetch(new Request('https://store.example.com' + path, {
    method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined,
  }), env(db), { waitUntil(p) { work.push(p); } });
  await Promise.all(work);
  return { status: res.status, body: await res.json() };
}

const invoice = (email, send) => ({
  action: 'create', send,
  customer: { email, name: 'Test Customer', phone: '' }, pickup: 'farm', note: 'Thanks!',
  lines: [{ name: 'Freight', qty: 2, price_cents: 2500, taxable: false }],
});

function captureLog(t) {
  const lines = [];
  const original = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  t.after(() => { console.log = original; });
  return lines;
}

test('saving without sending leaves a clear unsent invoice', async (t) => {
  const { db, sqlite } = database(t);
  const made = await call(db, '/api/admin/invoice', { body: invoice('a@example.com', false) });
  assert.equal(made.body.emailed, false);
  assert.equal(made.body.email_requested, false);
  const row = sqlite.prepare('SELECT * FROM sales').get();
  assert.equal(row.invoice_sent_at, null);
  assert.equal(row.invoice_send_count, 0);
  // Younger than an hour: not flagged yet.
  let att = await call(db, '/api/admin/attention');
  assert.equal(att.body.items.some((i) => i.filter === 'invoice_unsent'), false);
  sqlite.prepare('UPDATE sales SET sold_at = ?').run(new Date(Date.now() - 3 * 3600 * 1000).toISOString());
  att = await call(db, '/api/admin/attention');
  const item = att.body.items.find((i) => i.filter === 'invoice_unsent');
  assert.ok(item, 'unsent invoice shows in Needs attention');
  assert.match(item.details[0].text, /Test Customer · \$50\.00 · invoice /);
  const list = await call(db, '/api/admin/sales?status=invoice_unsent');
  assert.equal(list.body.sales.length, 1);
});

test('a failed email is recorded, then a corrected address sends and clears it', async (t) => {
  const { db, sqlite } = database(t);
  const log = captureLog(t);
  const made = await call(db, '/api/admin/invoice', { body: invoice('typo+fail@example.com', true) });
  assert.equal(made.body.emailed, false);
  assert.match(made.body.email_error, /simulated failure/);
  let row = sqlite.prepare('SELECT * FROM sales').get();
  assert.match(row.invoice_last_error, /simulated failure/);
  assert.equal(row.invoice_send_count, 0);
  assert.ok(row.invoice_last_attempt_at);

  // The double-send guard: an attempt a moment ago blocks another.
  const tooSoon = await call(db, '/api/admin/invoice', { body: { action: 'send', sale_id: row.id } });
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.body.error, /moment ago/);

  sqlite.prepare('UPDATE sales SET invoice_last_attempt_at = ?').run(new Date(Date.now() - 60000).toISOString());
  const bad = await call(db, '/api/admin/invoice', { body: { action: 'send', sale_id: row.id, email: 'not-an-email' } });
  assert.equal(bad.status, 400);
  const fixed = await call(db, '/api/admin/invoice', { body: { action: 'send', sale_id: row.id, email: 'right@example.com' } });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.sent_to, 'right@example.com');
  row = sqlite.prepare('SELECT * FROM sales').get();
  assert.equal(row.customer_email, 'right@example.com');
  assert.equal(row.invoice_last_error, null);
  assert.equal(row.invoice_send_count, 1);
  assert.ok(row.invoice_sent_at);
  assert.ok(log.some((l) => l.includes('to right@example.com') && l.includes('| Invoice ')));

  // The next send is a reminder.
  sqlite.prepare('UPDATE sales SET invoice_last_attempt_at = ?').run(new Date(Date.now() - 60000).toISOString());
  await call(db, '/api/admin/invoice', { body: { action: 'send', sale_id: row.id } });
  assert.equal(sqlite.prepare('SELECT invoice_send_count n FROM sales').get().n, 2);
  assert.ok(log.some((l) => l.includes('| Reminder: Invoice ')));
});

test('changing the address does not rename or alter the other customer', async (t) => {
  const { db, sqlite } = database(t);
  sqlite.prepare('INSERT INTO customers (email, name, created_at) VALUES (?,?,?)').run('other@example.com', 'Other Person', '2026-01-01');
  const made = await call(db, '/api/admin/invoice', { body: invoice('first@example.com', false) });
  await call(db, '/api/admin/invoice', { body: { action: 'send', sale_id: made.body.sale_id, email: 'other@example.com' } });
  assert.equal(sqlite.prepare("SELECT name FROM customers WHERE email = 'other@example.com'").get().name, 'Other Person');
  assert.equal(sqlite.prepare("SELECT customer_email e FROM sales").get().e, 'other@example.com');
});

test('the pay page says plainly when an invoice was cancelled', async (t) => {
  const { db } = database(t);
  const made = await call(db, '/api/admin/invoice', { body: invoice('c@example.com', false) });
  const token = new URL(made.body.link).searchParams.get('inv');
  const open = await call(db, '/api/invoice?t=' + token);
  assert.equal(open.body.state, 'unpaid');
  assert.ok(open.body.contact.phone);
  await call(db, '/api/admin/invoice', { body: { action: 'cancel', sale_id: made.body.sale_id } });
  const gone = await call(db, '/api/invoice?t=' + token);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.canceled, true);
  assert.match(gone.body.error, /cancelled/);
  const unknown = await call(db, '/api/invoice?t=' + 'x'.repeat(40));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.canceled, undefined);
});

test('cash or check is recorded once, with a receipt that shows the amounts', async (t) => {
  const { db, sqlite } = database(t);
  const log = captureLog(t);
  const made = await call(db, '/api/admin/invoice', { body: invoice('d@example.com', false) });
  const paid = await call(db, '/api/admin/invoice', { body: { action: 'record_payment', sale_id: made.body.sale_id, method: 'check' } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.receipt_emailed, true);
  assert.equal(sqlite.prepare('SELECT status FROM sales').get().status, 'recorded');
  assert.ok(log.some((l) => l.includes('Receipt: Invoice') && l.includes('$50.00')));
  const again = await call(db, '/api/admin/invoice', { body: { action: 'record_payment', sale_id: made.body.sale_id, method: 'cash' } });
  assert.equal(again.status, 400);
  const page = await call(db, '/api/invoice?t=' + new URL(made.body.link).searchParams.get('inv'));
  assert.equal(page.body.state, 'paid');
});

async function webhook(db, event) {
  const secret = 'webhook-test-only';
  const raw = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts + '.' + raw))).toString('hex');
  const work = [];
  const res = await worker.fetch(new Request('https://store.example.com/api/webhook', {
    method: 'POST', headers: { 'stripe-signature': 't=' + ts + ',v1=' + mac }, body: raw,
  }), { ...env(db), STRIPE_WEBHOOK_SECRET: secret }, { waitUntil(p) { work.push(p); } });
  await Promise.all(work);
  return res.status;
}

test('an online payment sends an invoice receipt with real amounts, not $0.00', async (t) => {
  const { db, sqlite } = database(t);
  const log = captureLog(t);
  const made = await call(db, '/api/admin/invoice', { body: invoice('e@example.com', false) });
  const id = made.body.sale_id;
  const status = await webhook(db, { id: 'evt_1', type: 'checkout.session.completed', data: { object: {
    client_reference_id: id, payment_status: 'paid', payment_intent: 'pi_1', payment_method_types: ['card'] } } });
  assert.equal(status, 200);
  assert.equal(sqlite.prepare('SELECT status FROM sales').get().status, 'captured');
  const receipt = log.find((l) => l.includes('Receipt: Invoice'));
  assert.ok(receipt && receipt.includes('to e@example.com'));
  assert.ok(receipt.includes('$50.00'), 'receipt shows the real amount');
  assert.ok(log.some((l) => l.includes('Invoice paid ')), 'the farm is told too');
});

test('a bounced bank payment puts the invoice back to unpaid and tells the customer', async (t) => {
  const { db, sqlite } = database(t);
  const log = captureLog(t);
  const made = await call(db, '/api/admin/invoice', { body: invoice('f@example.com', false) });
  const id = made.body.sale_id;
  await webhook(db, { id: 'evt_2', type: 'checkout.session.completed', data: { object: {
    client_reference_id: id, payment_status: 'unpaid', payment_intent: 'pi_2', payment_method_types: ['us_bank_account'] } } });
  assert.equal(sqlite.prepare('SELECT status FROM sales').get().status, 'processing');
  const page = await call(db, '/api/invoice?t=' + new URL(made.body.link).searchParams.get('inv'));
  assert.equal(page.body.state, 'processing');
  await webhook(db, { id: 'evt_3', type: 'payment_intent.payment_failed', data: { object: { id: 'pi_2', amount: 5000 } } });
  const row = sqlite.prepare('SELECT status, notes FROM sales').get();
  assert.equal(row.status, 'invoiced');
  assert.match(row.notes, /BANK PAYMENT FAILED/);
  assert.ok(log.some((l) => l.includes('to f@example.com') && l.includes('did not go through')));
  const again = await call(db, '/api/invoice?t=' + new URL(made.body.link).searchParams.get('inv'));
  assert.equal(again.body.state, 'unpaid');
});
