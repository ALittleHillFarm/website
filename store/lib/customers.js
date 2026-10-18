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
