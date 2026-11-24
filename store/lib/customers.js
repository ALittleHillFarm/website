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
