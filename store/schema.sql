-- A Little Hill Farm — sales ledger (Cloudflare D1 / SQLite)
--
-- Two tables. No joins required for any routine operation.
-- All money is INTEGER CENTS. Never floats.
--
-- Stripe owns CARD PAYMENT STATE (authorize / capture / cancel).
-- This ledger owns THE BOOKS: every sale, every channel, every payment method.

-- ---------------------------------------------------------------------------
-- customers — only exists to answer two questions:
--   1. do we charge this customer sales tax?
--   2. do we skip manual review and capture automatically?
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  email          TEXT PRIMARY KEY,
  name           TEXT,
  phone          TEXT,

  -- Business customers with an ST-101 on file. Overrides product-level taxable.
  tax_exempt     INTEGER NOT NULL DEFAULT 0,
  exemption_ref  TEXT,              -- ST-101 reference / date received

  -- Known-good. Their orders capture immediately instead of waiting for review.
  trusted        INTEGER NOT NULL DEFAULT 0,

  notes          TEXT,
  created_at     TEXT NOT NULL      -- ISO 8601
);

-- ---------------------------------------------------------------------------
-- sales — the ledger. One row per sale, regardless of how it was sold or paid.
--   channel 'online' -> came through the web store, paid via Stripe
--   channel 'direct' -> entered by hand: cash feed, milk, cheese, goats
-- ---------------------------------------------------------------------------
CREATE TABLE sales (
  id                    TEXT PRIMARY KEY,
  sold_at               TEXT NOT NULL,     -- ISO 8601
  channel               TEXT NOT NULL,     -- online | direct
  category              TEXT NOT NULL,     -- feed | milk | cheese | goat | other

  customer_email        TEXT,              -- soft link to customers.email
  customer_name         TEXT,
  customer_phone        TEXT,     -- pickup is in person; we need to reach people

  -- Frozen snapshot of what was actually sold at the price actually charged.
  -- NEVER re-price this from products.json. Editing the catalog must not
  -- rewrite history.
  items_json            TEXT NOT NULL,

  subtotal_cents        INTEGER NOT NULL,
  tax_cents             INTEGER NOT NULL,
  total_cents           INTEGER NOT NULL,

  -- Cost of goods sold, snapshotted at time of sale. Supplier costs change;
  -- a past sale must keep the cost it was actually sold at. Denormalised so
  -- quarterly COGS is SUM(cogs_cents) rather than parsing every line.
  cogs_cents            INTEGER NOT NULL DEFAULT 0,

  -- Snapshotted at time of sale, so a later change to the customer record
  -- does not alter a past return.
  tax_exempt            INTEGER NOT NULL DEFAULT 0,
  exemption_ref         TEXT,

  payment_method        TEXT NOT NULL,     -- card | ach | cash | check
  stripe_session_id     TEXT,              -- set at checkout; the only link to
                                           -- Stripe before the session completes
  stripe_payment_intent TEXT,              -- NULL for cash/check, and until paid
  status                TEXT NOT NULL,     -- authorized | captured | canceled | recorded

  -- Which bulk supplier order this went into. Answers "what's on the truck".
  supplier_order_ref    TEXT,

  fulfillment           TEXT,              -- pickup:moscow | pickup:farm | ship:WA
  fulfilled_at          TEXT,

  -- Pre-order terms the customer accepted. Dispute evidence.
  terms_ack_version     TEXT,
  terms_ack_at          TEXT,

  -- Which stage emails have been sent. Emails are sent by hand; this is the
  -- checklist, e.g. {"received":"2026-09-20","supplier_ordered":null,...}
  notified_json         TEXT,

  notes                 TEXT
);

CREATE INDEX idx_sales_sold_at   ON sales (sold_at);
CREATE INDEX idx_sales_status    ON sales (status);
CREATE INDEX idx_sales_customer  ON sales (customer_email);
CREATE INDEX idx_sales_supplier  ON sales (supplier_order_ref);

-- ---------------------------------------------------------------------------
-- Quarterly Idaho sales tax filing is one query:
--
--   SELECT SUM(total_cents)                              AS gross,
--          SUM(CASE WHEN tax_exempt=1 THEN total_cents
--                   ELSE 0 END)                          AS exempt_sales,
--          SUM(subtotal_cents)                           AS taxable_subtotal,
--          SUM(tax_cents)                                AS tax_collected
--     FROM sales
--    WHERE status IN ('captured','recorded')
--      AND sold_at >= '2026-07-01' AND sold_at < '2026-10-01';
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- webhook_events — Stripe redelivers events. The primary key makes
-- reprocessing a harmless no-op instead of a double state transition.
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id          TEXT PRIMARY KEY,   -- Stripe's event id (evt_...)
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- product_settings — the fields that change often, editable from /admin
-- without a deploy.
--
-- products.json stays the source of truth for WHAT we sell (names, units,
-- descriptions, photos). This table holds WHETHER it is for sale and WHAT IT
-- COSTS. A NULL column means "fall back to products.json".
--
-- That split is deliberate: the web form cannot damage product copy or image
-- URLs, only the numbers it is meant to change.
-- ---------------------------------------------------------------------------
CREATE TABLE product_settings (
  product_id    TEXT PRIMARY KEY,
  active        INTEGER,        -- NULL = use products.json
  price_cents   INTEGER,
  cost_cents    INTEGER,
  freight_cents INTEGER,
  image         TEXT,           -- uploaded photo path, overrides products.json
  note          TEXT,           -- e.g. "out until spring"
  updated_at    TEXT NOT NULL
);
