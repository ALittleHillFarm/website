#!/usr/bin/env python3
"""
Load past Shopify purchases into the store's purchase_history table, so the
admin's New invoice form can offer "recent purchases" for customers whose
history is all on Shopify.

    python seed/import-shopify-history.py "<path to orders_export_1.csv>" > <scratch>/history.sql
    cd store && npx wrangler d1 execute alhf-store --remote --file=<scratch>/history.sql

The SQL contains customer emails — write it OUTSIDE this public repo. Each
Shopify line is matched to a store product by SKU, then by name and size;
unmatched lines are kept with product_id NULL (shown, but not one-click).
Re-running replaces the earlier import (source = 'shopify').
"""
import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
products = json.load(open(os.path.join(HERE, '..', 'store', 'products.json'), encoding='utf-8'))['products']
norm = lambda s: re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()
by_sku = {p['sku'].upper(): p for p in products if p.get('sku')}
by_name_unit = {(norm(p['name']), norm(p.get('unit'))): p for p in products}
by_name = {}
for p in products:
    by_name.setdefault(norm(p['name']), []).append(p)


def match(name, sku):
    if sku and sku.upper() in by_sku:
        return by_sku[sku.upper()]
    # Shopify line names are "Title - Variant", e.g. "Corn-Free Layer Feed - 50 lbs".
    title, _, variant = name.rpartition(' - ')
    if title:
        p = by_name_unit.get((norm(title), norm(variant)))
        if p:
            return p
        # "Layer Feed with Power Pellet - 1000 lb tote" -> name + tote unit
        for q in by_name.get(norm(title), []) + by_name.get(norm(title) + 's', []):
            u = norm(q.get('unit'))
            if u and (norm(variant) in u or u in norm(variant)):
                return q
    c = by_name.get(norm(name), [])
    return c[0] if len(c) == 1 else None


def q(v):
    return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"


def main():
    rows = list(csv.DictReader(open(sys.argv[1], encoding='utf-8-sig')))
    out = ["DELETE FROM purchase_history WHERE source = 'shopify';"]
    matched = unmatched = 0
    head = {}
    for r in rows:
        # Shopify repeats order-level fields only on the first line of an order.
        if r.get('Email'):
            head[r['Name']] = r
        h = head.get(r['Name'], r)
        email = (h.get('Email') or '').strip().lower()
        if not email or not r.get('Lineitem name') or h.get('Financial Status') in ('voided',):
            continue
        p = match(r['Lineitem name'], r.get('Lineitem sku'))
        matched += bool(p)
        unmatched += not p
        out.append('INSERT INTO purchase_history (email, sold_at, product_id, name, unit, qty, price_cents, source) VALUES (' +
                   ', '.join([q(email), q(h.get('Created at', '')[:19]), q(p['id'] if p else None),
                              q(p['name'] if p else r['Lineitem name']), q(p.get('unit', '') if p else ''),
                              str(int(float(r.get('Lineitem quantity') or 0))),
                              str(round(float(r.get('Lineitem price') or 0) * 100)), q('shopify')]) + ');')
    print('\n'.join(out))
    print(f'-- {matched} lines matched to store products, {unmatched} kept by name only', file=sys.stderr)


if __name__ == '__main__':
    main()
