import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequest, centsIn, landedCosts, replayAverage, reportTotals, salesCategory, splitByCategory } from '../lib/costing.js';

// New Country Organics SO343263 / PO60, 7/29/2026: $2,052.57 including $368.59 shipping.
const NCO = [
  { sku: 'F40-LAYER-PASTURE', qty: 6, unit_cost_cents: 2495, weight_lbs: 40 },
  { sku: 'F40-GOAT', qty: 9, unit_cost_cents: 3337, weight_lbs: 40 },
  { sku: 'F40-GOAT-P', qty: 9, unit_cost_cents: 3406, weight_lbs: 40 },
  { sku: 'F40-SHEEP', qty: 1, unit_cost_cents: 3151, weight_lbs: 40 },
  { sku: 'F1K-LAYER-PWR', qty: 1, unit_cost_cents: 70000, weight_lbs: 1000 },
  { sku: 'F50-KELP-THRVN', qty: 2, unit_cost_cents: 9795, weight_lbs: 50 },
];
const NCO_SHIPPING = 36859;

test('NCO order adds up to the supplier total', () => {
  const items = NCO.reduce((n, l) => n + l.qty * l.unit_cost_cents, 0);
  assert.equal(items + NCO_SHIPPING, 205257);
});

test('landed cost splits shipping by weight: 2,100 lb is about 17.55 cents a lb', () => {
  const r = landedCosts(NCO, NCO_SHIPPING);
  assert.equal(r.by, 'weight');
  assert.equal(r.total_lbs, 2100);
  assert.ok(Math.abs(r.cents_per_lb - 17.552) < 0.001);
  // A 40 lb bag carries 40 x 17.552 = about $7.02 of freight.
  assert.equal(r.landed[0], 2495 + 702);
  assert.equal(r.landed[1], 3337 + 702);
  // The 1000 lb tote carries 1000 lb of it.
  assert.equal(r.landed[4], 70000 + 17552);
  // Nothing is lost beyond rounding: the landed lines add back to the order.
  const total = r.landed.reduce((n, c, i) => n + c * NCO[i].qty, 0);
  assert.ok(Math.abs(total - 205257) <= NCO.length, 'landed total ' + total);
});

test('landed cost falls back to dollars when any line has no weight', () => {
  const lines = [
    { qty: 1, unit_cost_cents: 1000, weight_lbs: 10 },
    { qty: 1, unit_cost_cents: 3000, weight_lbs: null },
  ];
  const r = landedCosts(lines, 400);
  assert.equal(r.by, 'dollars');
  assert.equal(r.cents_per_lb, null);
  assert.deepEqual(r.landed, [1100, 3300]);
});

test('landed cost with no shipping is the price', () => {
  assert.deepEqual(landedCosts(NCO, 0).landed, NCO.map((l) => l.unit_cost_cents));
});

test('moving weighted average replays purchases in order', () => {
  // 10 on hand at $40 (the opening cost), then 10 more arrive at $50: $45.
  const r = replayAverage(4000, [
    { kind: 'count', qty: 10, unit_cost_cents: null },
    { kind: 'purchase', qty: 10, unit_cost_cents: 5000 },
  ]);
  assert.equal(r.cost_cents, 4500);
  assert.equal(r.on_hand, 20);
  // Sell 15, then buy 5 at $60: (5 x 45 + 5 x 60) / 10 = $52.50.
  const r2 = replayAverage(4000, [
    { kind: 'count', qty: 10 }, { kind: 'purchase', qty: 10, unit_cost_cents: 5000 },
    { kind: 'sale', qty: -15 }, { kind: 'purchase', qty: 5, unit_cost_cents: 6000 },
  ]);
  assert.equal(r2.cost_cents, 5250);
});

test('average restarts at the landed cost when nothing was on hand', () => {
  const r = replayAverage(4000, [{ kind: 'purchase', qty: 3, unit_cost_cents: 5000 }]);
  assert.equal(r.cost_cents, 5000);
  const none = replayAverage(4000, [{ kind: 'count', qty: 3 }]);
  assert.equal(none.cost_cents, 4000);
  assert.equal(none.purchased, false);
});

// Johnson's Heritage Farmstead, Sep 2026.
function johnson(layerDiscount) {
  return [
    { gross_cents: 2100 },                                   // Crocheted Chicken x3
    { gross_cents: 4200 },                                   // Thorvin Kelp 5 lb x2
    { gross_cents: 700 },                                    // Oyster shell 5 lb
    { gross_cents: 4200, discount_cents: layerDiscount },    // Layer feed, 1 gross
    { gross_cents: 2900 },                                   // Flock Armour
    { gross_cents: 1500 },                                   // Egg basket
    { gross_cents: 1200 },                                   // milk, 2 qt
  ];
}
const JOHNSONS = { commission_bps: 0 };

test('Johnson Sep 2026: correcting the discount to $6 gives a $162 payout with no override', () => {
  const t = reportTotals(johnson(600), JOHNSONS, { extra_tax_cents: 684 });
  assert.equal(t.gross_cents, 16800);       // 156 + 12 milk
  assert.equal(t.discount_cents, 600);
  assert.equal(t.net_cents, 16200);
  assert.equal(t.payout_cents, 16200);      // 156 - 6 + 12
  assert.equal(t.tax_cents, 684);
});

test('Johnson Sep 2026 as printed ($42 discount) would under-pay us, which is why it is corrected', () => {
  assert.equal(reportTotals(johnson(4200), JOHNSONS, {}).payout_cents, 12600);
});

test('shop cut comes off the payout, and a typed payout wins', () => {
  const lines = [{ gross_cents: 10000 }];
  assert.equal(reportTotals(lines, { commission_bps: 1500 }, {}).payout_cents, 8500);
  assert.equal(reportTotals(lines, { commission_bps: 1500 }, { commission_cents: 1000 }).payout_cents, 9000);
  assert.equal(reportTotals(lines, { commission_bps: 1500 }, { payout_cents: 7777 }).payout_cents, 7777);
});

test('amounts must be whole cents', () => {
  assert.throws(() => centsIn(1.5, 'x'), BadRequest);
  assert.throws(() => reportTotals([{ gross_cents: -1 }], JOHNSONS, {}), BadRequest);
  assert.equal(centsIn('', 'x'), 0);
});

test('a report is booked one row per category, and the rows add back to the payout', () => {
  const t = reportTotals(johnson(600), JOHNSONS, { extra_tax_cents: 684 });
  const names = ['Crocheted Chicken', 'Thorvin Kelp', 'Oyster Shell', 'Layer Feed', 'Flock Armour', 'Egg Basket', 'Goat Milk'];
  const cats = ['other', 'mineral', 'mineral', 'feed', 'supply', 'supply', 'other'];
  const items = names.map((n, i) => ({
    name: n, qty: 1, category: salesCategory(n, cats[i]), ...t.lines[i], cost_cents: 100,
  }));
  const parts = splitByCategory(items, t.payout_cents, true, 684);
  const by = Object.fromEntries(parts.map((p) => [p.category, p]));
  assert.equal(by.milk.revenue_cents, 1200);
  assert.equal(by.feed.revenue_cents, 16200 - 1200 - 2100);
  assert.equal(by.other.revenue_cents, 2100);
  assert.equal(parts.reduce((n, p) => n + p.revenue_cents, 0), 16200);
  assert.equal(parts.reduce((n, p) => n + p.tax_cents, 0), 0, 'the shop collects the tax');
  assert.equal(by.milk.cogs_cents, 100);
});

test('tax stays with us when the shop does not collect it', () => {
  const items = [
    { category: 'feed', net_cents: 3000, tax_cents: 300, qty: 1, cost_cents: 0 },
    { category: 'milk', net_cents: 1000, tax_cents: 100, qty: 1, cost_cents: 0 },
  ];
  const parts = splitByCategory(items, 4000, false);
  assert.equal(parts[0].tax_cents, 300);
  assert.equal(parts[1].tax_cents, 100);
});

test('categories: milk and cheese by name, else the product category', () => {
  assert.equal(salesCategory('Goat Milk 1 quart', 'other'), 'milk');
  assert.equal(salesCategory('Chevre cheese', 'feed'), 'cheese');
  assert.equal(salesCategory('Thorvin Kelp', 'mineral'), 'feed');
  assert.equal(salesCategory('Crocheted Chicken', 'other'), 'other');
});
