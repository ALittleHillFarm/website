/** Cash eligibility for a verified email. Call only after checking the session.
 * A paid purchase makes the next order a repeat purchase; merely creating an
 * account, starting checkout, or placing an unpaid cash order does not.
 * Keep this separate from `trusted`, which also skips card-payment review.
 */
export async function isEstablishedCustomer(db, email, customer) {
  if (customer && customer.trusted) return true;
  const who = String(email || '').trim().toLowerCase();
  if (!who) return false;
  const paid = await db.prepare(
    "SELECT 1 AS found FROM sales WHERE customer_email = ? COLLATE NOCASE" +
      " AND status IN ('captured','recorded') AND total_cents > COALESCE(refunded_cents, 0)" +
      ' UNION ALL SELECT 1 AS found FROM purchase_history WHERE email = ? COLLATE NOCASE' +
      " AND source = 'shopify' AND qty > 0 AND price_cents > 0 LIMIT 1"
  ).bind(who, who).first();
  return !!paid;
}

/** Replace imported history without exposing partially uploaded data. The
 * caller must be an authenticated admin. Validate the whole upload before
 * writing; stage small D1 batches, then publish with one atomic batch.
 */
export async function importPurchaseHistory(db, purchases) {
  if (!Array.isArray(purchases) || !purchases.length || purchases.length > 5000) {
    throw new Error('provide between 1 and 5000 paid purchase lines');
  }
  const rows = purchases.map((p) => {
    if (!p || typeof p !== 'object') throw new Error('invalid purchase line');
    const email = String(p.email || '').trim().toLowerCase();
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
        !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/.test(p.sold_at || '') ||
        typeof p.name !== 'string' || !p.name.trim() || p.name.length > 500 ||
        (p.unit != null && (typeof p.unit !== 'string' || p.unit.length > 200)) ||
        (p.product_id != null && (typeof p.product_id !== 'string' || p.product_id.length > 200)) ||
        !Number.isSafeInteger(p.qty) || p.qty <= 0 ||
        !Number.isSafeInteger(p.price_cents) || p.price_cents <= 0) {
      throw new Error('invalid purchase line');
    }
    return { ...p, email };
  });
  const stage = 'shopify-import:' + crypto.randomUUID();
  try {
    for (let i = 0; i < rows.length; i += 40) {
      await db.batch(rows.slice(i, i + 40).map((p) => db.prepare(
        'INSERT INTO purchase_history (email, sold_at, product_id, name, unit, qty, price_cents, source) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(p.email, p.sold_at, p.product_id || null, p.name, p.unit || '', p.qty, p.price_cents, stage)));
    }
    await db.batch([
      db.prepare("DELETE FROM purchase_history WHERE source = 'shopify'"),
      db.prepare("UPDATE purchase_history SET source = 'shopify' WHERE source = ?").bind(stage),
    ]);
  } catch (error) {
    await db.prepare('DELETE FROM purchase_history WHERE source = ?').bind(stage).run().catch(() => {});
    throw error;
  }
  return { imported_lines: rows.length, customers: new Set(rows.map((p) => p.email)).size };
}

// ---------------------------------------------------------------------------
// The admin's customer list: view everyone, add, edit, remove.
//
// A customers row holds contact details plus the two flags that change how
// an order is handled (tax_exempt, trusted). Orders and purchase history are
// keyed by email but never depend on the row existing: sales snapshot their
// own tax details and name, and history is matched by email alone. So adding,
// editing and removing here only ever changes this table.
// ---------------------------------------------------------------------------

/** A mistake in what was sent. `status` is the HTTP status to answer with. */
export class CustomerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const text = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** The one spelling of an email we store and match on, or '' if it is not one. */
export function normalEmail(v) {
  const e = String(v == null ? '' : v).trim().toLowerCase();
  return e.length <= 254 && EMAIL_SHAPE.test(e) ? e : '';
}

/** What the form sent, trimmed, capped and typed. Unknown fields are dropped. */
function customerFields(b, { needName }) {
  const email = normalEmail(b.email);
  if (!email) throw new CustomerError('that does not look like an email address');
  const name = text(b.name, 120);
  if (needName && !name) throw new CustomerError('enter the customer’s name');
  const notes = String(b.notes == null ? '' : b.notes).replace(/[ \t]+/g, ' ').trim().slice(0, 2000);
  return {
    email,
    name: name || null,
    phone: text(b.phone, 40) || null,
    tax_exempt: b.tax_exempt === true || b.tax_exempt === 1 ? 1 : 0,
    exemption_ref: text(b.exemption_ref, 200) || null,
    trusted: b.trusted === true || b.trusted === 1 ? 1 : 0,
    notes: notes || null,
  };
}

const CUSTOMER_COLUMNS = 'email, name, phone, tax_exempt, exemption_ref, trusted, notes, created_at';

/**
 * Everyone we know, by name. The invoice form's picker needs only the plain
 * rows. With `detail` (the Customers tab) each row also says how many paid
 * store orders and old Shopify lines are on file under their email, and the
 * result lists emails that appear in Shopify history but have no customer
 * row yet, so they can be added in one click.
 */
export async function listCustomers(db, { detail = false } = {}) {
  if (!detail) {
    const rows = (await db.prepare(
      'SELECT ' + CUSTOMER_COLUMNS + " FROM customers ORDER BY COALESCE(NULLIF(name, ''), email) COLLATE NOCASE, email"
    ).all()).results || [];
    return { customers: rows };
  }
  const customers = (await db.prepare(
    'SELECT c.email, c.name, c.phone, c.tax_exempt, c.exemption_ref, c.trusted, c.notes, c.created_at,' +
      " (SELECT COUNT(*) FROM sales s WHERE s.customer_email = c.email COLLATE NOCASE AND s.status IN ('captured','recorded')" +
      '    AND s.total_cents > COALESCE(s.refunded_cents, 0)) AS paid_orders,' +
      " (SELECT COUNT(*) FROM purchase_history h WHERE h.email = c.email COLLATE NOCASE AND h.source = 'shopify') AS history_lines" +
      " FROM customers c ORDER BY COALESCE(NULLIF(c.name, ''), c.email) COLLATE NOCASE, c.email"
  ).all()).results || [];
  const history_only = (await db.prepare(
    'SELECT h.email AS email, COUNT(*) AS lines, MAX(h.sold_at) AS last_purchase FROM purchase_history h' +
      " WHERE h.source = 'shopify' AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.email = h.email COLLATE NOCASE)" +
      ' GROUP BY h.email ORDER BY last_purchase DESC, h.email'
  ).all()).results || [];
  return { customers, history_only };
}

async function oneCustomer(db, email) {
  return db.prepare('SELECT ' + CUSTOMER_COLUMNS + ' FROM customers WHERE email = ? COLLATE NOCASE').bind(email).first();
}

/** A new customer. An email we already have is refused, never overwritten. */
export async function addCustomer(db, input, now = new Date().toISOString()) {
  const c = customerFields(input || {}, { needName: true });
  if (await oneCustomer(db, c.email)) throw new CustomerError('there is already a customer with that email — edit them instead', 409);
  await db.prepare(
    'INSERT INTO customers (email, name, phone, tax_exempt, exemption_ref, trusted, notes, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(c.email, c.name, c.phone, c.tax_exempt, c.exemption_ref, c.trusted, c.notes, now).run();
  return oneCustomer(db, c.email);
}

/**
 * Change an existing customer's details and flags. The email is who they are
 * (their orders, history and sign-in are all keyed by it), so it is never
 * changed here: a different email is a different customer.
 */
export async function updateCustomer(db, input) {
  const c = customerFields(input || {}, { needName: false });
  const found = await oneCustomer(db, c.email);
  if (!found) throw new CustomerError('no customer with that email', 404);
  await db.prepare(
    'UPDATE customers SET name = ?, phone = ?, tax_exempt = ?, exemption_ref = ?, trusted = ?, notes = ? WHERE email = ? COLLATE NOCASE'
  ).bind(c.name, c.phone, c.tax_exempt, c.exemption_ref, c.trusted, c.notes, found.email).run();
  return oneCustomer(db, found.email);
}

/**
 * Remove a customer record: their tax exemption, trusted flag, notes and
 * contact details. Their orders and Shopify history stay exactly as they are,
 * and they can still sign in and order (as a new customer, without the flags).
 */
export async function deleteCustomer(db, email) {
  const who = normalEmail(email);
  if (!who) throw new CustomerError('that does not look like an email address');
  const found = await oneCustomer(db, who);
  if (!found) throw new CustomerError('no customer with that email', 404);
  await db.prepare('DELETE FROM customers WHERE email = ? COLLATE NOCASE').bind(found.email).run();
  return { removed: found.email };
}

// ---------------------------------------------------------------------------
// Bringing customers over from Shopify's "Customers" CSV export.
//
// Safe to run again and again: people who are not here yet are added; people
// who are keep everything they have, and only a blank name or phone is filled
// in. The two flags that change how an order is handled (trusted, tax-exempt)
// are never carried over — Shopify's tax-exempt marks are listed for the farm
// to confirm against its ST-101s, not applied.
// ---------------------------------------------------------------------------

const MAX_CSV_CHARS = 2_000_000;
const MAX_CSV_ROWS = 5000;

/** Rows of fields from CSV text: quoted fields, doubled quotes, line breaks inside quotes, a BOM, CRLF. */
export function parseCsv(input) {
  const s = String(input == null ? '' : input).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (s[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Shopify guards ids and phone numbers from spreadsheets with a leading apostrophe. */
const unquoteCell = (v) => String(v == null ? '' : v).trim().replace(/^'/, '').trim();

/** US numbers read as 208-555-0100 (how the farm writes them); anything else is kept as typed. */
export function tidyPhone(v) {
  const raw = unquoteCell(v);
  const digits = raw.replace(/\D/g, '');
  const national = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  return national.length === 10
    ? national.slice(0, 3) + '-' + national.slice(3, 6) + '-' + national.slice(6)
    : raw.slice(0, 40);
}

/**
 * Read a Shopify customer export. Returns who can be imported and what was
 * left out, so the farm can see both before anything is written.
 */
export function shopifyCustomers(csv, { includeNeverOrdered = false } = {}) {
  if (typeof csv !== 'string' || !csv.trim()) throw new CustomerError('choose the customer export file first');
  if (csv.length > MAX_CSV_CHARS) throw new CustomerError('that file is too large to be a customer export');
  const table = parseCsv(csv);
  const header = (table[0] || []).map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name.toLowerCase());
  const at = { email: col('Email'), first: col('First Name'), last: col('Last Name'), phone: col('Phone'),
    addressPhone: col('Default Address Phone'), orders: col('Total Orders'), exempt: col('Tax Exempt') };
  if (at.email < 0 || at.first < 0 || at.orders < 0) {
    throw new CustomerError('that does not look like Shopify’s customer export (it needs Email, First Name and Total Orders columns)');
  }
  if (table.length - 1 > MAX_CSV_ROWS) throw new CustomerError('that file has too many rows to be a customer export');
  const cell = (r, i) => (i < 0 ? '' : unquoteCell(r[i]));

  const people = new Map();
  const result = { rows: table.length - 1, people: [], no_email: [], never_ordered: 0, tax_exempt: [], duplicates: 0 };
  for (const r of table.slice(1)) {
    const name = text([cell(r, at.first), cell(r, at.last)].filter(Boolean).join(' '), 120);
    const orders = Math.max(0, Math.floor(Number(cell(r, at.orders)) || 0));
    const email = normalEmail(cell(r, at.email));
    const exempt = cell(r, at.exempt).toLowerCase() === 'yes';
    if (!email) {
      // Their email is the only way the store tells people apart, so these cannot be added.
      if (orders > 0) result.no_email.push({ name: name || '(no name)', orders, phone: tidyPhone(cell(r, at.phone) || cell(r, at.addressPhone)) || null });
      continue;
    }
    if (exempt) result.tax_exempt.push({ name: name || email, email });
    if (!orders && !includeNeverOrdered) { result.never_ordered++; continue; }
    const person = { email, name: name || null, orders, phone: tidyPhone(cell(r, at.phone) || cell(r, at.addressPhone)) || null };
    const seen = people.get(email);
    if (seen) {
      result.duplicates++;
      if (person.orders > seen.orders) people.set(email, { ...person, name: person.name || seen.name, phone: person.phone || seen.phone });
    } else {
      people.set(email, person);
    }
  }
  result.people = [...people.values()];
  return result;
}

/**
 * Add the export's customers that are not here yet, and fill blank names and
 * phones on the ones that are. `dryRun` (the default) only reports what would
 * happen. Nothing existing is overwritten and no flag is changed.
 */
export async function importShopifyCustomers(db, csv, { includeNeverOrdered = false, dryRun = true, now = new Date().toISOString() } = {}) {
  const read = shopifyCustomers(csv, { includeNeverOrdered });
  const have = new Map(((await db.prepare('SELECT email, name, phone FROM customers').all()).results || [])
    .map((c) => [String(c.email).toLowerCase(), c]));
  const add = [], fill = [];
  let already = 0;
  for (const p of read.people) {
    const mine = have.get(p.email);
    if (!mine) { add.push(p); continue; }
    const name = !String(mine.name || '').trim() && p.name ? p.name : null;
    const phone = !String(mine.phone || '').trim() && p.phone ? p.phone : null;
    if (name || phone) fill.push({ email: mine.email, name, phone });
    else already++;
  }
  if (!dryRun) {
    const writes = [
      ...add.map((p) => db.prepare('INSERT OR IGNORE INTO customers (email, name, phone, created_at) VALUES (?,?,?,?)')
        .bind(p.email, p.name, p.phone, now)),
      ...fill.map((p) => db.prepare(
        "UPDATE customers SET name = COALESCE(NULLIF(name, ''), ?), phone = COALESCE(NULLIF(phone, ''), ?) WHERE email = ?"
      ).bind(p.name, p.phone, p.email)),
    ];
    for (let i = 0; i < writes.length; i += 40) await db.batch(writes.slice(i, i + 40));
  }
  return {
    dry_run: !!dryRun,
    file_rows: read.rows,
    add: add.map(({ email, name, orders }) => ({ email, name, orders })),
    filled: fill.length,
    already,
    no_email: read.no_email,
    never_ordered: read.never_ordered,
    tax_exempt: read.tax_exempt,
    duplicates: read.duplicates,
  };
}

// ---------------------------------------------------------------------------
// Whoever an order is entered for becomes a customer.
// ---------------------------------------------------------------------------

/**
 * Make sure the person an order was entered for is in the customer list.
 * Adds them if their email is new; never changes trusted or tax-exempt.
 *
 * `fillBlanks` says whether an existing record may have a missing name or
 * phone filled in. Staff entering an order may (they know who it is); a guest
 * typing an email at checkout may not, since that email might be somebody
 * else's and a stranger should not be able to edit their record.
 *
 * Returns true if the person was added, false if they were already here or
 * the email was not usable (the order itself is never blocked by this).
 */
export async function rememberOrderCustomer(db, { email, name, phone }, { fillBlanks = false, now = new Date().toISOString() } = {}) {
  const who = normalEmail(email);
  if (!who) return false;
  const person = [who, text(name, 120) || null, text(phone, 40) || null, now];
  if (!fillBlanks) {
    const r = await db.prepare('INSERT OR IGNORE INTO customers (email, name, phone, created_at) VALUES (?,?,?,?)').bind(...person).run();
    return !!(r && r.meta && r.meta.changes);
  }
  const was = await oneCustomer(db, who);
  await db.prepare(
    'INSERT INTO customers (email, name, phone, created_at) VALUES (?,?,?,?)' +
      " ON CONFLICT(email) DO UPDATE SET name = COALESCE(NULLIF(customers.name, ''), excluded.name)," +
      " phone = COALESCE(NULLIF(customers.phone, ''), excluded.phone)"
  ).bind(...person).run();
  return !was;
}

// ---------------------------------------------------------------------------
// One customer, everything we know: for the admin's customer page.
// ---------------------------------------------------------------------------

/** What an order contained, in a few words. */
function itemsSummary(json) {
  let items = [];
  try { items = JSON.parse(json || '[]'); } catch { /* shown as nothing */ }
  const names = (Array.isArray(items) ? items : []).map((l) => (l && l.name ? (l.qty > 1 ? l.qty + ' × ' : '') + l.name : '')).filter(Boolean);
  return names.length > 3 ? names.slice(0, 3).join(', ') + ' + ' + (names.length - 3) + ' more' : names.join(', ');
}

/**
 * The customer record (null if they are only in Shopify history), their
 * orders from this store, and what they bought on Shopify before it. Matched
 * by email, ignoring case. Works for an email that has no customer record,
 * so staff can open and invoice people who only ever bought on Shopify.
 */
export async function customerProfile(db, email) {
  const who = normalEmail(email);
  if (!who) throw new CustomerError('that does not look like an email address');
  const customer = await oneCustomer(db, who);
  const orders = ((await db.prepare(
    'SELECT id, sold_at, channel, status, payment_method, total_cents, refunded_cents, items_json, customer_name FROM sales' +
      " WHERE customer_email = ? COLLATE NOCASE AND channel != 'location' ORDER BY sold_at DESC LIMIT 100"
  ).bind(who).all()).results || []).map((s) => ({
    id: s.id, ref: String(s.id).slice(0, 8), sold_at: s.sold_at, channel: s.channel, status: s.status, payment_method: s.payment_method,
    total_cents: s.total_cents, refunded_cents: s.refunded_cents || 0, items: itemsSummary(s.items_json),
  }));
  const history = (await db.prepare(
    "SELECT sold_at, name, unit, qty, price_cents FROM purchase_history WHERE email = ? COLLATE NOCASE AND source = 'shopify'" +
      ' ORDER BY sold_at DESC LIMIT 200'
  ).bind(who).all()).results || [];
  if (!customer && !orders.length && !history.length) throw new CustomerError('no customer or purchase history for that email', 404);
  return { email: customer ? customer.email : who, customer: customer ? { ...customer } : null, orders, history: history.map((h) => ({ ...h })) };
}
