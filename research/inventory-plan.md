# Inventory, supplier purchases, locations and consignment sales

Design for the admin features requested 2026-10-08. Read this before changing
any of it.

## Decisions

### Products move into D1 (`products` table)
Products were `store/products.json` + a `product_settings` overlay. The admin
now needs to create, edit and delete products, so D1 is the source of truth:

- `products(id TEXT PK, data TEXT JSON, sort INTEGER, created_at, updated_at)`.
  `data` holds every products.json field: name, sku, supplier, unit,
  weight_lbs, price_cents, cost_cents, freight_cents, taxable, category,
  active, description, image, animals, popular, and so on.
- On first run (the table is empty), seed it once from products.json merged
  with product_settings.
- `loadCatalog()` reads `products`. If that read fails, it falls back to
  products.json + product_settings, so the storefront never goes down.
- Nothing writes to `product_settings` any more; the table is kept as
  history. products.json becomes the seed snapshot and fallback, and is no
  longer edited to change the store.
- Deleting a product that has sales or stock history only hides it
  (`active:false`, `archived:true`). A hard delete is allowed only when the
  product has no history.

### Stock is a ledger (`stock_moves`), totalled across locations for now
```
stock_moves(id INTEGER PK, product_id, location_id NULL, qty INTEGER,   -- + in, - out
            unit_cost_cents INTEGER NULL,                              -- landed cost, purchases only
            kind TEXT CHECK IN ('purchase','sale','location_sale','adjust','count'),
            ref TEXT,                    -- purchase id / sale id / report id
            note TEXT, created_at TEXT, created_by TEXT)
```
- On hand = `SUM(qty)` per product.
- Every move already records a `location_id` (NULL means the farm), so
  stock per location later is a `GROUP BY` plus a "transfer" kind. The
  schema does not need to change for it.
- `count` is a stock take. She enters what she counted, and the move
  stores the difference.
- Only products that have at least one move are "tracked". Untracked
  products, such as milk, show no stock badge.
- Online, invoice and direct sales add a `sale` move (−qty) when the sale
  becomes paid: captured, or recorded as cash or check. Canceled or failed
  sales never add one. Refunds do not restock automatically; she can adjust
  stock by hand.

### Cost method: moving weighted average, from landed cost
Each purchase line keeps the exact price paid, so history is never lost.
The product's `cost_cents` used for COGS is the weighted average of what is
on hand:

    new_avg = (on_hand_before × old_avg + qty × landed) / (on_hand_before + qty)
    (if on_hand_before <= 0, new_avg = landed)

- **Landed cost** = the supplier's rate + that line's share of shipping and
  fees, split by **weight**: shipping ÷ total lbs × the line's lbs. This is
  the method she already uses: on New Country Organics SO343263, $368.59 ÷
  2,100 lb ≈ 17.6¢/lb. Lines with no weight fall back to splitting by
  dollar amount.
- `freight_cents` on the product is then 0, because freight is already in
  the landed cost.
- After any purchase is created, edited or deleted, `recomputeCost(product)`
  replays the product's moves in date order. This keeps edits exact, with
  no drift.
- Why this method: Shopify (purchase orders), Lightspeed and QuickBooks
  Desktop all use weighted average. QuickBooks Online uses FIFO. For a
  small, low-volume shop, average cost is the usual choice. It is easy to
  understand, IRS-acceptable, and smooths out the price changes from one
  order to the next.
- Using "latest price" would overstate or understate profit whenever older
  stock is still on hand. FIFO needs lot tracking, which isn't worth it at
  this volume.

### Supplier purchases
```
purchases(id TEXT PK, supplier TEXT, ordered_at TEXT, received_at TEXT NULL,
          ref TEXT,               -- supplier order no. e.g. SO343263
          po TEXT,                -- our PO, e.g. PO60
          shipping_cents, other_cents, tax_cents, total_cents,
          note, created_at, updated_at, created_by)
purchase_lines(id INTEGER PK, purchase_id, product_id NULL, name, sku,
               qty INTEGER, unit_cost_cents, weight_lbs REAL,
               landed_unit_cents INTEGER)
```
- She enters everything on one page: the header, then lines picked from
  products (search by SKU or name). A brand-new product can be added from
  the line, and is created with the supplier, SKU, unit and weight filled in.
- The page shows a live landed-cost column and the per-lb freight rate.
- Stock moves are added when the purchase is marked **received**. It
  defaults to received on save, with a "not arrived yet" checkbox.
- Editing a received purchase rewrites its moves (delete by ref, then
  re-insert) and recomputes the cost of each affected product.

### Locations
```
locations(id TEXT PK slug, name, kind TEXT CHECK IN ('farm','store','market','other'),
          address, contact, phone, email,
          commission_bps INTEGER DEFAULT 0,  -- the shop's cut, if any
          tax_collected_by_location INTEGER DEFAULT 1,
          active INTEGER DEFAULT 1, note, created_at, updated_at)
```
Seed rows: `farm` (A Little Hill Farm, kind farm), and Johnson's Heritage
Farmstead (kind store). The store's address and contact details are left
blank for her to fill in.

### Location (consignment) sales reports
One report per statement from the shop, such as the "Sep 2026" Shopify
report from Johnson's Heritage Farmstead.
```
location_reports(id TEXT PK, location_id, period_label TEXT, period_start, period_end,
                 gross_cents, discount_cents, net_cents, tax_cents, total_cents,
                 commission_cents, payout_cents,       -- what we are owed
                 paid_at NULL, paid_method NULL, note, created_at, updated_at, created_by)
location_report_lines(id INTEGER PK, report_id, product_id NULL, name, qty,
                      gross_cents, discount_cents, net_cents, tax_cents, total_cents)
```
- The entry page mirrors the report's columns: product, qty, gross,
  discounts, net, taxes, total. Net and total calculate automatically but
  can be overridden.
- Extra lines can be added for things sold outside the report, such as
  "milk sale, 2 qt, $12". Whether they count as feed or milk comes from
  the product.
- Payout defaults to net − commission, and can be overridden. Her Sep 2026
  sheet: $156 gross − $6 actual discount + $12 milk = $162.
- The report can be marked paid (date, method).
- Saving writes `location_sale` moves (−qty, location_id), and also one
  `sales` row per report:
  - `channel 'location'` and `status 'recorded'`;
  - `items_json` from the lines;
  - `cogs_cents` from the current average cost;
  - `tax_exempt` = 1 when the location collects the tax, so it isn't
    counted in our Idaho filing;
  - `notes` = "Location report <id>".
  This keeps revenue and COGS reports whole. Editing a report rewrites
  both the moves and the sales row.

### Storefront stock display
- `/api/catalog` gains `in_stock: true | false | null` (null = untracked).
  The exact count is never exposed publicly.
- Product cards and the product page show a small badge: **In stock**, or
  **Out of stock: order now, arrives with the next delivery**. The store
  is pre-order, so out-of-stock items can still be bought.
- Product JSON-LD availability is InStock / BackOrder accordingly
  (untracked stays InStock).

### Goats
Goat create, edit, reorder and hide/delete already exist in the admin Goats
tab (`assets/admin-goats.js`, `adminGoats` in worker.js). No new work is
needed beyond any gaps found.

## Admin UI
- New tabs: **Products** (replaces the old Inventory tab), **Purchases**,
  **Locations**, and **Location sales**.
- Each tab has its own script: `assets/admin-products.js`,
  `admin-purchases.js`, `admin-locations.js`, `admin-location-sales.js`.
  These follow the style of admin-goats.js and admin-invoices.js.
- **Products** is a dense, fast table:
  - search, plus filters for category, supplier, active and low/out of stock;
  - inline editing of price, cost, active and on-hand (a count);
  - a row expands to the full edit form (description, photo upload,
    animals, weight, SKU);
  - "New product", and delete/archive.
  - On hand, average cost and margin are shown per row.
- Purchases and location reports are lists (newest first) with an editor.
  Each has "Duplicate last" for the next order from the same supplier.
- Everything should work on a phone, and errors should be in plain words.
  Admin API routes sit under `/api/admin/…`, behind the existing
  `requireAdmin`.
