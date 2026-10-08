/**
 * The money arithmetic behind purchases and location reports, kept apart from
 * the Worker so it can be unit tested (`node --test`, see store/test/).
 * Pure functions only: no database, no network. All money is integer cents.
 *
 * public/assets/admin-purchases.js and admin-location-sales.js repeat the
 * landed-cost and report sums for the live preview while typing; the copies
 * here are the ones that are saved. Keep them in step.
 */

/** A mistake in what was sent. The Worker turns it into a plain 400 message. */
export class BadRequest extends Error {}

/** A whole number of cents, zero or more. Blank counts as zero. */
export function centsIn(v, what) {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000000) {
    throw new BadRequest(what + ' must be an amount of zero or more (whole cents)');
  }
  return n;
}

/**
 * Landed cost per unit for each line of a supplier order: the supplier's price
 * plus the line's share of shipping and fees. The share is split by weight
 * (shipping / total lbs x the line's lbs) when every line has a weight, and by
 * dollars otherwise. Example, New Country Organics SO343263: $368.59 over
 * 2,100 lb is about 17.6 cents a lb, so a 40 lb bag costs about $7.02 more.
 * lines: [{ qty, unit_cost_cents, weight_lbs }]
 */
export function landedCosts(lines, extraCents) {
  const lbs = lines.map((l) => (Number(l.weight_lbs) > 0 ? Number(l.weight_lbs) * l.qty : 0));
  const byWeight = lines.length > 0 && lbs.every((w) => w > 0);
  const basis = lines.map((l, i) => (byWeight ? lbs[i] : l.unit_cost_cents * l.qty));
  const total = basis.reduce((a, b) => a + b, 0);
  const totalLbs = lbs.reduce((a, b) => a + b, 0);
  return {
    by: byWeight ? 'weight' : 'dollars',
    total_lbs: totalLbs,
    cents_per_lb: byWeight && totalLbs > 0 ? extraCents / totalLbs : null,
    landed: lines.map((l, i) => Math.round(l.unit_cost_cents + (total > 0 ? (extraCents * basis[i]) / total : 0) / l.qty)),
  };
}

/**
 * Replay one product's stock moves (oldest first) and return its moving
 * weighted average cost:
 *   new_avg = (on_hand_before x old_avg + qty x landed) / (on_hand_before + qty)
 * (the landed cost alone when nothing was on hand). Only 'purchase' moves with
 * a cost change the average; every move changes the quantity on hand.
 * moves: [{ kind, qty, unit_cost_cents }]
 * Returns { cost_cents, on_hand, purchased } where purchased is false when no
 * purchase is among the moves (the cost is then just the opening cost).
 */
export function replayAverage(openingCostCents, moves) {
  let onHand = 0;
  let avg = openingCostCents;
  let purchased = false;
  for (const m of moves) {
    if (m.kind === 'purchase') {
      purchased = true;
      if (m.unit_cost_cents != null) {
        avg = onHand <= 0 ? m.unit_cost_cents : Math.round((onHand * avg + m.qty * m.unit_cost_cents) / (onHand + m.qty));
      }
    }
    onHand += m.qty;
  }
  return { cost_cents: purchased ? avg : openingCostCents, on_hand: onHand, purchased };
}

/**
 * Totals for a shop's statement. Line net and total calculate (gross less
 * discount; net plus tax) unless a figure was typed over them. The payout
 * defaults to net less the shop's cut, and can be typed over too: Johnson's
 * Sep 2026 sheet pays $156 gross - $6 actual discount + $12 milk = $162.
 * rawLines: [{ gross_cents, discount_cents, net_cents?, tax_cents, total_cents? }]
 * location: { commission_bps }; b: { extra_tax_cents, commission_cents, payout_cents }
 */
export function reportTotals(rawLines, location, b) {
  const lines = rawLines.map((l, i) => {
    const where = 'line ' + (i + 1);
    const gross = centsIn(l.gross_cents, where + ' gross');
    const discount = centsIn(l.discount_cents, where + ' discount');
    const tax = centsIn(l.tax_cents, where + ' tax');
    const net = l.net_cents === '' || l.net_cents == null ? Math.max(0, gross - discount) : centsIn(l.net_cents, where + ' net');
    const total = l.total_cents === '' || l.total_cents == null ? net + tax : centsIn(l.total_cents, where + ' total');
    return { gross_cents: gross, discount_cents: discount, net_cents: net, tax_cents: tax, total_cents: total };
  });
  const sum = (k) => lines.reduce((n, l) => n + l[k], 0);
  const extraTax = centsIn(b.extra_tax_cents, 'the extra tax');
  const net = sum('net_cents');
  const commission = b.commission_cents === '' || b.commission_cents == null
    ? Math.round((net * (location.commission_bps || 0)) / 10000) : centsIn(b.commission_cents, 'the shop’s cut');
  const payout = b.payout_cents === '' || b.payout_cents == null ? net - commission : centsIn(b.payout_cents, 'the payout');
  return {
    lines,
    gross_cents: sum('gross_cents'),
    discount_cents: sum('discount_cents'),
    net_cents: net,
    tax_cents: sum('tax_cents') + extraTax,
    total_cents: sum('total_cents') + extraTax,
    commission_cents: commission,
    payout_cents: payout,
  };
}

/** Which books category a reported item belongs in: feed, milk, cheese, goat
 *  or other. The name wins for milk and cheese (a product's own category can
 *  be loose), then the product's category. Everything else counts as feed,
 *  as it does for online sales. */
export function salesCategory(name, productCategory) {
  if (/milk/i.test(name)) return 'milk';
  if (/cheese/i.test(name)) return 'cheese';
  const c = String(productCategory || '').toLowerCase();
  if (c === 'milk' || c === 'cheese' || c === 'goat') return c;
  if (c === 'other') return 'other';
  return 'feed';
}

/** Spread `total` over `weights` in whole cents, the odd cent going to the
 *  biggest share, so the parts always add back up to the total. */
function spread(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const parts = weights.map((w) => Math.round((total * w) / sum));
  const diff = total - parts.reduce((a, b) => a + b, 0);
  parts[weights.indexOf(Math.max(...weights))] += diff;
  return parts;
}

/**
 * One books entry per category for a location report, so reports by category
 * are right (feed vs milk). Revenue is what the shop pays us (the payout),
 * shared across categories in proportion to net sales; cost of goods is each
 * category's own. Tax is left out when the shop collects it itself.
 * items: [{ category, net_cents, tax_cents, qty, cost_cents }]
 * Returns [{ category, revenue_cents, tax_cents, cogs_cents, items: [index...] }]
 */
export function splitByCategory(items, payoutCents, taxExempt, extraTaxCents = 0) {
  const cats = [];
  const members = new Map();
  items.forEach((it, i) => {
    if (!members.has(it.category)) { members.set(it.category, []); cats.push(it.category); }
    members.get(it.category).push(i);
  });
  const net = cats.map((c) => members.get(c).reduce((n, i) => n + items[i].net_cents, 0));
  const revenue = spread(payoutCents, net);
  const lineTax = cats.map((c) => members.get(c).reduce((n, i) => n + items[i].tax_cents, 0));
  const tax = taxExempt ? cats.map(() => 0) : spread(lineTax.reduce((a, b) => a + b, 0) + extraTaxCents, net);
  return cats.map((c, k) => ({
    category: c,
    revenue_cents: revenue[k],
    tax_cents: tax[k],
    cogs_cents: members.get(c).reduce((n, i) => n + items[i].cost_cents * items[i].qty, 0),
    items: members.get(c),
  }));
}
