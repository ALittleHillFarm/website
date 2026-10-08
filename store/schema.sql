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

  notes                 TEXT,
  refunded_cents        INTEGER NOT NULL DEFAULT 0,  -- running total refunded
  refunded_at           TEXT,                        -- when the latest refund was given
  invoice_token         TEXT,       -- invoices only: the secret in the pay link
  invoice_sent_at       TEXT,
  invoice_note          TEXT        -- shown to the customer on the invoice
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

-- ---------------------------------------------------------------------------
-- goats — the herd, edited from /admin (Goats tab) and rendered live by the
-- farm site's worker (site/goats.js). Both workers bind this same database.
--
-- data holds everything the farm writes, as JSON: name, registered name,
-- birth date, photos, badge, pedigree names, parents, extra facts and notes.
-- registry holds what was harvested from genetics.adga.org (grandparents,
-- production evaluation), or NULL. site/goats.js normalize() documents both.
--
-- status 'hidden' takes a goat off every page without deleting her record —
-- the right move for a sold or retired animal.
-- ---------------------------------------------------------------------------
CREATE TABLE goats (
  id          TEXT PRIMARY KEY,                -- URL slug, fixed at creation
  sort        INTEGER NOT NULL DEFAULT 100,    -- roster order, low first
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  template    TEXT NOT NULL DEFAULT 'doe' CHECK (template IN ('doe', 'buck')),
  data        TEXT NOT NULL,
  registry    TEXT,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- alert_state — what the alert checks last saw, so an alert fires once when
-- something changes (a site goes down, comes back) instead of every run.
-- ---------------------------------------------------------------------------
CREATE TABLE alert_state (
  key         TEXT PRIMARY KEY,     -- e.g. 'site:https://store.alittlehillfarm.com/api/catalog'
  value       TEXT NOT NULL,        -- 'up' | 'failing' | 'down'
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- login_codes — six-digit sign-in codes emailed to customers. Only a keyed
-- hash is stored. A code lasts ten minutes and allows five guesses; a
-- successful sign-in deletes every code for that email.
-- ---------------------------------------------------------------------------
CREATE TABLE login_codes (
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX login_codes_email ON login_codes (email, created_at);

-- Invoices are found by the token in their pay link.
CREATE UNIQUE INDEX sales_invoice_token ON sales (invoice_token);

-- ---------------------------------------------------------------------------
-- purchase_history — past purchases from before this store (Shopify), loaded
-- by seed/import-shopify-history.py. The New invoice form combines it with
-- this store's own sales to offer a customer's recent items. product_id is
-- NULL for old lines that match no current product.
-- ---------------------------------------------------------------------------
CREATE TABLE purchase_history (
  email        TEXT NOT NULL,
  sold_at      TEXT NOT NULL,
  product_id   TEXT,
  name         TEXT NOT NULL,
  unit         TEXT,
  qty          INTEGER NOT NULL,
  price_cents  INTEGER NOT NULL,
  source       TEXT NOT NULL      -- 'shopify'
);
CREATE INDEX purchase_history_email ON purchase_history (email, sold_at);

-- ===========================================================================
-- Products, stock, supplier purchases, locations and consignment sales.
-- See research/inventory-plan.md. Every statement is IF NOT EXISTS so the file
-- can be re-run; production got these one statement at a time.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- products — the catalog. D1 is the source of truth; products.json is only the
-- one-time seed and the fallback if this table cannot be read. data holds
-- every products.json field (name, sku, supplier, unit, weight_lbs,
-- price_cents, cost_cents, freight_cents, taxable, category, active,
-- description, image, animals, popular, ...) as JSON. A product with sales or
-- stock history is hidden (active:false, archived:true), never deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 100,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- stock_moves — the stock ledger. On hand = SUM(qty) per product. location_id
-- NULL means the farm. A product with no moves at all is "untracked" (milk,
-- say) and shows no stock badge. unit_cost_cents is the landed cost, set on
-- purchases only. 'count' is a stock take: the move stores the difference.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_moves (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      TEXT NOT NULL,
  location_id     TEXT,
  qty             INTEGER NOT NULL,                  -- + in, - out
  unit_cost_cents INTEGER,
  kind            TEXT NOT NULL CHECK (kind IN ('purchase','sale','location_sale','adjust','count')),
  ref             TEXT,                              -- purchase id / sale id / report id
  note            TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT
);
CREATE INDEX IF NOT EXISTS stock_moves_product ON stock_moves (product_id, created_at);
CREATE INDEX IF NOT EXISTS stock_moves_ref ON stock_moves (kind, ref);

-- ---------------------------------------------------------------------------
-- purchases — a supplier order (header) and what was on it (lines). Stock moves
-- are added when it is marked received. landed_unit_cents is the supplier's
-- price plus the line's share of shipping and fees, split by weight.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  id            TEXT PRIMARY KEY,
  supplier      TEXT NOT NULL,
  ordered_at    TEXT NOT NULL,
  received_at   TEXT,
  ref           TEXT,                 -- the supplier's order number, e.g. SO343263
  po            TEXT,                 -- our own PO, e.g. PO60
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  other_cents   INTEGER NOT NULL DEFAULT 0,
  tax_cents     INTEGER NOT NULL DEFAULT 0,
  total_cents   INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_by    TEXT
);
CREATE TABLE IF NOT EXISTS purchase_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id       TEXT NOT NULL,
  product_id        TEXT,
  name              TEXT NOT NULL,
  sku               TEXT,
  qty               INTEGER NOT NULL,
  unit_cost_cents   INTEGER NOT NULL,
  weight_lbs        REAL,
  landed_unit_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS purchase_lines_purchase ON purchase_lines (purchase_id);
CREATE INDEX IF NOT EXISTS purchase_lines_product ON purchase_lines (product_id);

-- ---------------------------------------------------------------------------
-- locations — where stock lives or is sold: the farm, and shops that sell our
-- goods on consignment. commission_bps is the shop's cut, if any.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'store' CHECK (kind IN ('farm','store','market','other')),
  address     TEXT,
  contact     TEXT,
  phone       TEXT,
  email       TEXT,
  commission_bps INTEGER NOT NULL DEFAULT 0,
  tax_collected_by_location INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- location_reports — one statement from a shop (e.g. "Sep 2026"). Saving one
-- writes location_sale stock moves and a single sales row (channel 'location').
-- payout_cents is what the shop owes us.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS location_reports (
  id          TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  period_label TEXT NOT NULL,
  period_start TEXT,
  period_end   TEXT,
  gross_cents  INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  net_cents    INTEGER NOT NULL DEFAULT 0,
  tax_cents    INTEGER NOT NULL DEFAULT 0,
  total_cents  INTEGER NOT NULL DEFAULT 0,
  commission_cents INTEGER NOT NULL DEFAULT 0,
  payout_cents INTEGER NOT NULL DEFAULT 0,
  paid_at      TEXT,
  paid_method  TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  created_by   TEXT
);
CREATE TABLE IF NOT EXISTS location_report_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id   TEXT NOT NULL,
  product_id  TEXT,
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  gross_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  net_cents   INTEGER NOT NULL DEFAULT 0,
  tax_cents   INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS location_report_lines_report ON location_report_lines (report_id);
CREATE INDEX IF NOT EXISTS location_reports_location ON location_reports (location_id, period_end);

-- Seed rows: the farm itself, and the first consignment shop. The shop's
-- address and contact details are left blank to fill in from the Locations tab.
INSERT OR IGNORE INTO locations (id, name, kind, commission_bps, tax_collected_by_location, active, created_at, updated_at)
  VALUES ('farm', 'A Little Hill Farm', 'farm', 0, 0, 1, '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z');
INSERT OR IGNORE INTO locations (id, name, kind, commission_bps, tax_collected_by_location, active, created_at, updated_at)
  VALUES ('johnsons-heritage-farmstead', 'Johnson''s Heritage Farmstead', 'store', 0, 1, 1, '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z');

-- A sale takes each product out of stock once. Lets recordSaleMoves() be called
-- more than once for the same sale (webhook retries, capture then webhook).
CREATE UNIQUE INDEX IF NOT EXISTS stock_moves_sale_once ON stock_moves (ref, product_id) WHERE kind = 'sale';
