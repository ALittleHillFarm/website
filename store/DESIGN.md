# Store design

Small store bolted onto the existing farm site. Four moving parts, no server to patch.

```
store/config.json     operational settings (pickup spots, tax rate, terms text)
store/products.json   the catalog
store/schema.sql      the sales ledger (Cloudflare D1)
worker.js             the whole application
```

## Who owns what

| Concern | Owner |
|---|---|
| Card payment state — authorize, capture, cancel | **Stripe.** `PaymentIntent.status` is authoritative. We build no order state machine. |
| The books — every sale, every channel | **The ledger.** Cash milk sales never touch Stripe, so Stripe cannot be our books. |
| Catalog | **git.** `products.json`. Edit, commit, deploy. |
| HTTPS, apex redirect, rate limiting | **Cloudflare.** Free, at the edge. Replaces the Azure App Service. |

No dependencies. The Worker calls Stripe's REST API with `fetch()`. Nothing to keep patched.

## Order flow

```
browse  →  cart (localStorage)  →  checkout page  →  Stripe Checkout  →  done
                                        │
                                        ├─ pick up where?
                                        ├─ accept pre-order terms  ← recorded
                                        └─ server re-prices everything
```

The server **never** trusts a price from the browser. It re-reads `products.json`,
recomputes the subtotal, applies tax, and builds the Stripe line items itself.

### Capture decision

Whether the charge happens now or after review is decided per customer:

```
customer.trusted  AND  total <= limits.max_order_cents   →  capture_method: automatic
otherwise                                                →  capture_method: manual
```

Manual means the card is authorized but **no money moves**. Cancel costs $0;
a refund after capture costs 2.9% + 30¢ forever. That asymmetry is the whole point.

Capture happens a day or two after review, to fund the bulk supplier order —
comfortably inside the 7-day authorization window. The hold is a fraud gate,
not a fulfillment gate.

### Pre-order terms

`config.json` holds the terms text and a `version`. The checkout page shows the
text and requires a checkbox. On submit we store `terms_ack_version` and
`terms_ack_at` on the sale.

Bump `version` whenever the wording changes. Old sales keep the version they
actually agreed to — that is the point, and it is the evidence if a delayed
delivery is ever disputed.

## Payment methods and pricing

Posted prices in `products.json` are the **posted price**, already absorbing card
processing cost. ACH and cash take 2% off.

| Method | Customer pays | Our cost | Net |
|---|---|---|---|
| Card | posted | 2.9% + 30c | ~0% |
| ACH | posted - 2% | 0.8%, capped $5 | ~+1% |
| Cash at pickup | posted - 2% | 0 | ~+2% |

### Why a discount and not a surcharge

The owner asked for a credit-card upcharge. Economically identical, but a
**surcharge** is a regulated program and a **cash discount** is not:

- Debit and prepaid cards **cannot be surcharged**, under any routing. At
  checkout, before the card is entered, we cannot know whether a card is debit.
  There is no clean way to implement this correctly.
- Surcharging requires 30 days' written notice to the acquirer (Stripe) before
  it is switched on.
- It must appear as its own line item on the receipt, capped at 3% (Visa) or
  actual cost, whichever is lower.
- Visa has designated 2026 a high-enforcement year for surcharging.

Cash discounts are legal in all fifty states, need no registration, and have no
debit-card problem. The requirement is simply that the posted price is the card
price and the discount comes off at payment. Same money, none of the exposure.

Idaho itself places no restriction on either approach.

### How it works at checkout

Payment method is chosen on our page, **before** the Stripe session is created,
so the server can build line items at the correct price tier:

```
choose method  →  server prices the cart  →  Stripe Checkout (that method only)
```

Cash at pickup creates no Stripe object at all - it lands in the ledger as
`payment_method='cash'`, `status='recorded'`, with no PaymentIntent.

That also means **no payment guarantee**, which matters on a 2-4 week pre-order
where we buy stock before seeing money. `cash_on_pickup.trusted_only` defaults
to true for that reason.

### ACH notes

ACH does not support authorize-then-capture.

**Decided:** ACH debits as soon as the customer completes checkout. There is no
hold and no review step, unlike the card path. The owner has run ACH this way
without problems and accepts the exposure, which is reasonable — ACH cannot be
card-tested, and card testing is what drove the move off Shopify.

The residual risk is an unauthorized-debit return, which a consumer can raise
for up to 60 days. That is a longer tail than a seven-day card hold, but the
frequency is far lower.

Use Stripe's instant bank verification rather than micro-deposits. ACH cannot be
card-tested, which removes the attack that drove the Shopify problems, but
unauthorized consumer returns have a 60-day window - longer than a card hold,
though far rarer.


## Cost basis and COGS

`products.json` carries `cost_cents` (what we pay the supplier per unit) and
`freight_cents` (freight allocated per unit). Neither is ever exposed publicly —
`/api/catalog` whitelists its fields, and `/api/quote` runs every response
through `publicQuote()` which strips the cost basis. Customers must not be able
to see supplier costs.

COGS is **snapshotted onto each sale** as `cogs_cents`, for the same reason
prices are: supplier costs change, and a closed quarter must not drift when we
update the catalog.

It is denormalised onto the sale rather than recomputed from `items_json`, so
quarterly reporting stays a single `SUM()`.

The tax report separates the three numbers Schedule F wants:

- `revenue_cents` — sales excluding sales tax, which is collected for the state
  and is not income
- `cogs_cents` — cost of goods sold
- `gross_margin_cents` — the difference

`freight_cents` is normally **0**. New Country Organics and Azure Standard
quote a delivered price, so freight is already inside `cost_cents` and adding
it again would double-count. The field exists for a future supplier who bills
freight separately.


## Editing inventory without a deploy

`products.json` owns what a product **is** — name, unit, description, photo,
supplier. Those change rarely and belong in git.

`product_settings` (D1) owns whether it is **for sale** and what it **costs** —
active, price, cost, freight, plus a short note. Those change often and are
edited from `/admin` with no deploy and no git.

A NULL column falls back to `products.json`, so clearing a field restores the
committed default rather than zeroing it. `loadCatalog()` merges the two on
every request, and falls back to the committed catalog if the settings table is
ever unreachable — a database problem degrades prices to last-known-good rather
than taking the store down.

The split is deliberate: the web form cannot damage product copy or image URLs,
only the numbers it is meant to change.

## The two Stripe calls

Create the session — one parameter switches on manual capture:

```
POST /v1/checkout/sessions
  mode                                = payment
  payment_intent_data[capture_method] = manual        # or omit for trusted
  line_items[n][price_data][...]                      # built server-side
  customer_email                      = ...
  metadata[sale_id]                   = ...
  metadata[pickup]                    = moscow
  metadata[terms_version]             = 2026-09-20
```

Capture after review:

```
POST /v1/payment_intents/{id}/capture
  amount_to_capture = 8000            # optional; partial capture releases the rest
```

Cancel instead, and nothing was ever charged.

Both calls take an `Idempotency-Key` derived from the sale id, so a retry can
never create a second authorization.

## Tax

Flat Idaho rate from `config.json`. Two levels:

1. `product.taxable` — the default for that item.
2. `customer.tax_exempt` — a business with an ST-101 on file. Overrides to zero.

Both the exemption flag and its reference are **snapshotted onto the sale**, so
updating a customer record never rewrites a past quarter.

We compute tax ourselves and pass final amounts to Stripe. No Stripe Tax, no
Avalara — pickup-only means effectively one jurisdiction.

## Recording sales that never touch Stripe

Direct feed sales, milk, cheese and goats are entered by hand on a small admin
form and land in the same `sales` table with `channel='direct'` and
`payment_method='cash'|'check'`. Quarterly filing reads one table, not two.

## Email

Sent by hand today, and that stays. The Worker automates only "order received".

The admin view surfaces a per-sale checklist (`notified_json`) showing which
stage emails have gone out — received, supplier ordered, arrived, picked up —
so nothing gets missed. Marking one done is a click; writing it stays human.

## Shipping (P2)

Off today. `config.shipping.enabled` turns it on. The `fulfillment` field already
carries `ship:WA` alongside `pickup:moscow`, and `allowed_states` is validated
server-side at checkout.

The fraud that stopped shipping was the ship-to-a-drop-address pattern, so when
shipping returns, shipped orders should force `capture_method: manual`
regardless of customer trust.

## Open questions

- Which ~20–40 of the 134 products go live. Everything imports as `active: false`.
- Whether goat sales are taxable — Idaho's livestock exemption may only cover
  sales through a chartered livestock market. One for the CPA.
