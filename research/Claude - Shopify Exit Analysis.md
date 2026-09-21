# Claude — Shopify Exit Analysis for A Little Hill Farm

**Date:** 2026-09-19
**Author:** Claude (Sonnet 5), research session
**Scope:** Migrating alittlehillfarm.com off Shopify to a self-hosted store, with emphasis on payment fraud, manual approval of charges, geographic limits, and hosting cost.

---

## Executive summary

A Little Hill Farm sells bulk organic livestock feed, minerals and soil amendments — roughly 134 SKUs today, mostly 50 lb bags priced $17–$127 — plus ADGA-registered Nigerian Dwarf goats. The operator wants to cut a $45/month Shopify bill, reduce fraud exposure, and gain the ability to approve transactions manually before money moves.

The single most important finding is that **the farm does not ship anything**. Its published shipping policy offers only pickup at the farm in Potlatch, ID, plus meetups in Moscow and Coeur d'Alene, and occasionally Lewiston, ID or Pullman, WA. A 15% cancellation fee covers no-shows.

This fact reframes the entire problem and invalidates the standard e-commerce fraud model. It also makes most of the "geographic restriction" engineering unnecessary, because the pickup location already is the geographic restriction.

Recommended shape: a small custom application with the catalog in a flat file under version control, Stripe Checkout in manual-capture mode, order records in a durable store, and deployment into compute the farm already pays for. Estimated savings ≈ $500/year. The stronger argument for migrating is control, not cost.

---

## 1. Reframing the fraud problem

### 1.1 The farm is structurally immune to the dominant fraud pattern

The dominant card-not-present fraud pattern is: obtain stolen card → purchase goods → have goods shipped to a drop address → resell. Every step depends on the merchant shipping.

A pickup-only merchant defeats this at step three. No fraudster drives to Potlatch, Idaho to collect a 50 lb bag of alfalfa pellets. The goods are heavy, low-value-per-pound, hard to resell, and require a physical appearance at a known place and time.

The practical consequence: **the farm's residual fraud risk is far lower than a typical online store's, before any controls are added.**

### 1.2 The actual attack is almost certainly card testing

Card testing is a volume attack in which bots submit stolen card numbers through a public checkout to discover which ones still authorize. Reported characteristics:

- A single attack can generate 5,000+ checkout attempts in under an hour.
- Test transactions are small, typically $0.50–$2.00.
- Merchants report patterns such as `firstname.lastname###@gmail.com` with plausible US billing addresses.
- Shopify states its platform-level ML blocks approximately 90% of card testing on guest credit card checkouts — which also confirms the remaining 10% reaches merchants.

The damage is not stolen inventory. It is junk orders, abandoned-checkout noise, failed authorization attempts, and a degraded authorization reputation with issuing banks that can depress approval rates on legitimate sales.

**Implication:** the farm's problem is a bot volume problem, not a stolen-goods problem. Leaving a platform that bots scan by default, and adding basic rate limiting, addresses most of it.

Source: [Shopify — blocking card testing attacks](https://www.shopify.com/enterprise/blog/block-card-testing-attacks)

---

## 2. Payment architecture

### 2.1 Manual capture is economically correct

Stripe **retains** the processing fee on refunds. Refunding a $100 order returns $100 to the customer while Stripe keeps the $3.20. This has been policy since 2020.

By contrast, **cancelling an uncaptured authorization costs nothing.** No funds move, no fee is assessed.

Therefore the correct flow for a merchant who wants to vet orders is:

```
checkout → authorize (no charge) → human review → capture  (fee assessed)
                                              └→ cancel   (no fee)
```

This is exactly the behaviour the operator intuited, and it is directly supported.

Sources: [Stripe — understanding fees for refunded payments](https://support.stripe.com/questions/understanding-fees-for-refunded-payments), [Stripe — place a hold on a payment method](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)

### 2.2 Implementation is one parameter

Stripe Checkout supports manual capture directly, while continuing to host the card form. The merchant never touches card data and remains in PCI SAQ-A scope:

```bash
curl https://api.stripe.com/v1/checkout/sessions -u "$STRIPE_SECRET_KEY:" \
  -d mode=payment \
  -d "payment_intent_data[capture_method]=manual" \
  -d "line_items[0][price]=price_xxx" \
  -d "line_items[0][quantity]=2"
```

On authorization the PaymentIntent moves to `requires_capture` and fires
`payment_intent.amount_capturable_updated`. Capture with:

```bash
curl https://api.stripe.com/v1/payment_intents/pi_xxx/capture -u "$STRIPE_SECRET_KEY:" \
  -d amount_to_capture=8000
```

**Partial capture is supported.** Authorize $95, capture $80 if a bag is short, and the remainder is released automatically. Note that only one capture is permitted per authorization — a partial capture forfeits the balance.

### 2.3 The seven-day authorization cliff is the binding constraint

Stripe's published validity windows for card-not-present transactions:

| Card brand | Customer-initiated | Merchant-initiated |
|---|---|---|
| Visa | 7 days | 4 days 18 hours |
| Mastercard | 7 days | 7 days |
| American Express | 7 days | 7 days |
| Discover | 7 days | 7 days |

If capture does not occur within the window, the hold is released and the PaymentIntent is cancelled permanently. It cannot be revived.

**This collides with the farm's operating model.** Pickup happens at scheduled meetups in Moscow and Coeur d'Alene. If a customer orders three weeks before the next Coeur d'Alene run, the authorization dies long before pickup.

Mitigations, best first:

1. **Tie ordering windows to pickup dates.** Open ordering for a given meetup only within seven days of it. This requires no special Stripe features and matches how the farm already operates. *This is the recommended approach.*
2. **Request extended authorizations from Stripe.** Up to 30 days on eligible Visa/Mastercard accounts. Eligibility is category-dependent and not guaranteed for retail — worth asking, not worth planning around.
3. **Capture at order time for known repeat customers**, reserving the hold-and-review path for new ones.

### 2.4 Rates and the ACH opportunity

Stripe US standard pricing, no monthly fee, no minimums:

| Method | Rate | Notes |
|---|---|---|
| Online card | 2.9% + 30¢ | Standard |
| In-person (Terminal) | 2.7% + 5¢ | Card-present; far stronger dispute position |
| ACH direct debit | 0.8%, **capped at $5** | No manual capture support |
| Dispute fee | $15, +$15 if contested | Counter fee refunded on a win |

**ACH deserves attention.** On a $400 feed order, ACH costs $3.20 against $11.90 on card. Bulk feed orders are exactly the order size where the cap pays off, and ACH cannot be card-tested. The tradeoff is that ACH does not support authorize-then-capture, so it suits established repeat customers rather than the manual-review path.

Because customers appear in person anyway, **Stripe Terminal is also worth considering**: 2.7% + 5¢ and card-present chargeback protection. A hybrid — authorize online to secure the 15% cancellation fee, then capture at pickup — captures most of the benefit of both.

Sources: [Stripe pricing](https://stripe.com/pricing), [Stripe — place a hold](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)

---

## 3. Geographic restriction — a correction

The operator asked to limit sales to states immediately around Idaho. Two observations argue for a softer implementation than a hard block.

**First, pickup already enforces geography, and does so more strongly than a state list.** A customer must physically appear in Potlatch, Moscow, Coeur d'Alene, Lewiston or Pullman. No billing-address rule improves on that.

**Second, a hard billing-state block would produce false declines in exactly this market.** Moscow, ID is the University of Idaho and Pullman, WA is Washington State University. A substantial share of legitimate customers in those two towns are students and staff carrying cards billed to other states — often a parent's card. Blocking non-regional billing addresses would reject real, physically-present customers.

**Recommendation:** treat out-of-region billing as a *review* signal, not a *block*. Stripe Radar is included at no charge and supports this directly; custom rules cost an additional $0.02 per screened transaction on standard pricing.

Rules worth running, in review mode first:

```
Review if :card_country: != 'US'
Review if :amount_in_usd: > 300
Block  if Postal code verification fails based on risk score
```

Velocity limiting belongs at the application layer, where it is free, rather than at Radar.

Sources: [Stripe Radar — fraud prevention rules](https://docs.stripe.com/radar/rules), [Radar pricing](https://stripe.com/radar/pricing)

---

## 4. Platform options

### 4.1 Full self-hosted platforms — not recommended

WooCommerce, Medusa, Vendure, PrestaShop and OpenCart all work and all support authorize-then-capture. Every one of them also means owning a database, a security patch treadmill, and an upgrade path — for a catalog of 20–40 items that changes a couple of times a year.

WordPress in particular is among the most-targeted software on the public internet. Adopting it while trying to *reduce* security exposure is working against the stated goal.

### 4.2 Recommended: a small custom application

- **Catalog in a flat file** (JSON or YAML) committed to git alongside the existing goat pages. Edit, commit, deploy. No admin UI, no catalog database, and full product history in version control.
- **Cart in `localStorage`**, with the server re-pricing every line from the catalog file at checkout. Client-submitted prices are never trusted.
- **Pickup location and date as required checkout fields** — this is the geographic control.
- **Orders in a durable store**, not an ephemeral one (see §5.2).
- **One password-protected admin page** listing uncaptured authorizations with Capture / Partial / Cancel actions.
- **Rate limiting on the checkout endpoint**, which defeats card testing.

Realistic size: 600–900 lines. Less than the configuration a platform like Medusa requires.

### 4.3 Alternatives worth knowing

- **Reserve online, pay at pickup.** No online card payment at all. Zero fraud, zero chargebacks, lowest rates, deployable in a weekend. Loses no-show protection.
- **Square Online free plan.** Free, unlimited products, local pickup built in, no monthly fee — but **3.3% + 30¢** on the free tier (2.9% + 30¢ requires a paid plan), and much less control over the approval flow.

Sources: [Square pricing](https://squareup.com/us/en/pricing), [Shopify pricing](https://www.stylefactoryproductions.com/blog/shopify-fees)

---

## 5. Hosting

### 5.1 Reusing the existing App Service Plan

Azure bills the **App Service Plan**, not the individual apps inside it. A plan can host multiple web apps, each with its own hostname and certificate, at no additional charge, provided aggregate resource use fits.

The farm already pays for an App Service that exists only to redirect HTTP to HTTPS. Deploying the store as a second web app into that same plan makes the marginal hosting cost **$0**, and makes the plan earn its keep.

To check the current tier:

```bash
az appservice plan list --output table
```

### 5.2 Azure Container Apps, and a warning about SQLite

Container Apps offers 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests free per month, plus free managed TLS certificates for custom domains. Scale-to-zero costs nothing at this traffic level but introduces cold starts; always-on at 0.25 vCPU runs roughly $14/month.

**Important caveat on SQLite.** SQLite requires POSIX file locking. Azure Files uses SMB, which does not provide the locking SQLite needs, and produces `database is locked` failures. The common workaround — run SQLite on the container's local disk and periodically snapshot it to Blob storage — is acceptable for a read-mostly catalog but **unacceptable for order records**. A container recycle between snapshots loses orders, and an order lost after its card was authorized is real money and a real customer problem.

**Recommendation:** keep the catalog in git (already durable) and put orders in a managed store — Azure Table Storage, Azure SQL Serverless, or any managed Postgres/MySQL. Order volume here is trivial; durability matters far more than performance.

Sources: [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/), [Azure App Service plans](https://learn.microsoft.com/en-us/azure/app-service/overview-hosting-plans)

---

## 6. Sales tax

Idaho offers a [production exemption](https://tax.idaho.gov/taxes/sales-use/exemptions/producers/farming-ranching/businesses-that-qualify/) for farming and ranching, claimed on Form ST-101. It does **not** blanket-cover feed: feed for genuine production animals can qualify, while feed for hobby and pet animals is taxable. The farm sells to both.

This is nonetheless *simpler* than ordinary e-commerce tax. Pickup-only means effectively one jurisdiction, so the requirement is a flat Idaho rate plus a per-customer exemption flag with an ST-101 on file. No Avalara, no Stripe Tax. Pullman meetups are a minor sourcing wrinkle, but volume is far below Washington's economic nexus threshold.

Confirm specifics with a CPA; do not over-engineer this in software.

---

## 7. Cost comparison

Modelled at $1,000/month revenue across roughly 15 orders:

| Option | Fixed | Variable | Monthly total |
|---|---|---|---|
| Shopify Basic (current) | $39 | 2.9% + 30¢ | ~$72 |
| Shopify Starter | $5 | **5%** | ~$55 |
| Square Online free | $0 | 3.3% + 30¢ | ~$38 |
| Self-hosted + Stripe | $0 | 2.9% + 30¢ | ~$33 |
| Self-hosted + Stripe ACH | $0 | 0.8% capped $5 | ~$12 |

**Savings versus today: roughly $40/month, ~$500/year.** Real for a small farm, but not transformative. The stronger arguments for migrating are fraud control and the manual-approval workflow, which Shopify does not offer cheaply.

---

## 8. Recommended sequence

1. Open a Stripe account; enable Radar rules in **review** mode.
2. Cut the catalog to 20–40 SKUs; put it in a JSON file in this repository.
3. Build the store into the existing static site — same container, same domain, one deploy.
4. Use manual capture with **ordering windows tied to pickup dates**, which solves the seven-day expiry structurally.
5. Offer ACH to established repeat customers.
6. Keep orders in a managed store, never on ephemeral container disk.

---

# Revision — 2026-09-20

New operating details from the owner materially change §2 and §4 above.

## What changed

1. **They shipped until 2026-09-19**, stopping only because of fraud. Shipping is a P2 requirement to restore, so the design must not hard-code pickup-only.
2. **No university customers in three years.** My §3 objection to a billing-state allowlist does not apply to this business. A state allowlist is acceptable.
3. **Fulfillment is a ~2-week group-buy cycle.** Orders are accumulated until they justify a bulk order to a supplier (e.g. New Country Organics), which is then placed and delivered before pickup. The owner wants to capture payment *after review but before the supplier order*, to fund the purchase.
4. **Accounting is a first-class requirement**: quarterly Idaho sales tax filing, annual federal and state returns, plus recording milk, cheese and goat sales — many of them **cash, never touching Stripe**.

## Consequence 1 — retract "ordering windows tied to pickup dates"

§2.3 proposed constraining ordering to within 7 days of a pickup date, to beat the authorization cliff. **This is no longer needed and was based on a wrong model of the business.**

Capture happens days after the order, to fund the supplier purchase — comfortably inside the 7-day window. The authorization window is a *fraud review* gate (1–2 days), not a *fulfillment* gate. The cliff is not a binding constraint.

## Consequence 2 — this is a pre-order business, with the risk profile of one

Capturing ~2 weeks before delivery carries materially higher dispute exposure than capture-at-fulfillment:

- Many card issuers have policies against charging before shipment.
- For delayed-delivery disputes, **the chargeback clock starts at expected delivery, not the transaction date**, and can extend far beyond the usual 120-day window.
- The FTC Mail, Internet or Telephone Order Merchandise Rule requires shipment within the time stated, or within 30 days absent a stated time, otherwise the buyer is entitled to a refund.

Required mitigations, none of them optional:

- State the lead time prominently at checkout ("consolidated into a bulk supplier order; expect pickup in ~2–3 weeks").
- Require an explicit acknowledgement checkbox of the pre-order terms. This is dispute evidence.
- Email at each stage: order received, supplier order placed, arrived, picked up.
- Record pickup date, time and location. This doubles as the delivery-location evidence Idaho expects.

This also strengthens the case for **ACH** (0.8%, capped at $5) for repeat customers: it avoids card-network pre-order rules entirely, and on a $200 order costs $1.60 against $6.10.

## Consequence 3 — Stripe alone cannot be the system of record

The earlier "Stripe as the order database" proposal fails on the accounting requirement: **cash milk and cheese sales never touch Stripe.**

Corrected split:

- **Stripe** — payment authority for card transactions only (authorize, capture, cancel). Still no separate order-state machine needed; `PaymentIntent.status` is authoritative.
- **A single-table sales ledger** — the books. Every sale regardless of channel or payment method: online feed orders, cash milk and cheese, goat sales. Powers quarterly Idaho filing and annual returns.

One flat table, no joins, integer cents, frozen line-item snapshots per sale.

## Consequence 4 — skip review for repeat customers in the application, not in Radar

Radar allow rules require contacting Stripe to enable, and Radar's review queue is Stripe's, not the farm's. The farm's review gate is its own capture decision.

Simplest correct answer: keep a trusted-customer list in the application. Known-good customer → create the PaymentIntent with automatic capture. New or flagged → manual capture and review. Free, no Radar tier, fully under their control.
