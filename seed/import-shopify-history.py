#!/usr/bin/env python3
"""
Load past Shopify purchases into the store's purchase_history table, so the
admin's New invoice form can offer "recent purchases" and checkout can recognize
returning customers whose history is all on Shopify. Only paid, non-canceled
orders with a positive unrefunded balance are imported.

    python seed/import-shopify-history.py "<path to orders_export_1.csv>" > <scratch>/history.sql
    cd store && npx wrangler d1 execute alhf-store --remote --file=<scratch>/history.sql

Or generate JSON for the authenticated /api/admin/customer-history/import API:

    python seed/import-shopify-history.py "<orders.csv>" --json --email-map "<private-map.json>"

The optional map is {"old@email": "current@email"}, reviewed by the farm owner.
It adds the same history to the current email while preserving the original.
Never infer an email change from a matching customer name alone. Keep the map
and generated SQL/JSON outside this public repo.
--known-customers accepts the admin customer list (a JSON array). Orders without
an email can be linked by an exact, unique normalized phone AND full-name match.

The SQL contains customer emails — write it OUTSIDE this public repo. Each
Shopify line is matched to a store product by SKU, then by name and size;
unmatched lines are kept with product_id NULL (shown, but not one-click).
Re-running replaces the earlier import (source = 'shopify').
"""
import csv
import argparse
import json
import os
import re
import sys
from decimal import Decimal, InvalidOperation

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


def cents(value):
    return int((Decimal(value or '0') * 100).quantize(Decimal('1')))


def purchases_from(rows, email_map=None, known_customers=None):
    aliases = {}
    for old, current in (email_map or {}).items():
        old, current = old.strip().lower(), current.strip().lower()
        if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', old) or not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', current):
            raise ValueError('email map must contain valid email addresses')
        aliases[old] = current
    by_phone = {}
    for customer in known_customers or []:
        phone = re.sub(r'\D', '', customer.get('phone') or '').removeprefix('1')
        if len(phone) == 10:
            by_phone.setdefault(phone, []).append(customer)
    # Email can be repeated on continuation lines while payment status is blank.
    # Identify the order header by its financial status, not presence of email.
    headers = {r['Name']: r for r in rows if r.get('Financial Status')}
    result = []
    for row in rows:
        head = headers.get(row['Name'], {})
        email = (head.get('Email') or '').strip().lower()
        recipients = {email, aliases.get(email, email)} if re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', email) else set()
        phones = {re.sub(r'\D', '', head.get(field) or '').removeprefix('1') for field in ('Phone', 'Billing Phone', 'Shipping Phone')}
        candidates = {c['email']: c for phone in phones if len(phone) == 10 for c in by_phone.get(phone, [])}
        if len(candidates) == 1:
            customer = next(iter(candidates.values()))
            if norm(customer.get('name')) and norm(customer.get('name')) in {norm(head.get('Billing Name')), norm(head.get('Shipping Name'))}:
                recipients.add(customer['email'].strip().lower())
        if (not recipients or not row.get('Lineitem name') or
                head.get('Financial Status') not in ('paid', 'partially_refunded') or head.get('Cancelled at')):
            continue
        if cents(head.get('Total')) <= cents(head.get('Refunded Amount')):
            continue
        quantity = Decimal(row.get('Lineitem quantity') or '0')
        price = cents(row.get('Lineitem price'))
        if quantity <= 0 or quantity != int(quantity) or price <= 0:
            continue
        sold_at = head.get('Created at', '')[:19]
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', sold_at):
            raise ValueError('order is missing its purchase timestamp')
        product = match(row['Lineitem name'], row.get('Lineitem sku'))
        for recipient in sorted(recipients):
            result.append(dict(email=recipient, sold_at=sold_at, product_id=product['id'] if product else None,
                               name=product['name'] if product else row['Lineitem name'],
                               unit=product.get('unit', '') if product else '', qty=int(quantity), price_cents=price))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('orders_csv')
    parser.add_argument('--json', action='store_true', help='emit the admin import API payload instead of SQL')
    parser.add_argument('--email-map', help='private owner-reviewed old-to-current email mapping JSON')
    parser.add_argument('--known-customers', help='private admin customer list for exact phone/name reconciliation')
    args = parser.parse_args()
    with open(args.orders_csv, encoding='utf-8-sig', newline='') as stream:
        rows = list(csv.DictReader(stream))
    aliases = {}
    if args.email_map:
        with open(args.email_map, encoding='utf-8-sig') as stream:
            aliases = json.load(stream)
    known = []
    if args.known_customers:
        with open(args.known_customers, encoding='utf-8-sig') as stream:
            known = json.load(stream)
    try:
        purchases = purchases_from(rows, aliases, known)
    except (ValueError, InvalidOperation) as error:
        parser.error(str(error))
    if not purchases:
        parser.error('no paid purchase lines found; refusing to erase imported history')
    if args.json:
        print(json.dumps(dict(source='shopify', purchases=purchases)))
    else:
        out = ["DELETE FROM purchase_history WHERE source = 'shopify';"]
        for p in purchases:
            out.append('INSERT INTO purchase_history (email, sold_at, product_id, name, unit, qty, price_cents, source) VALUES (' +
                       ', '.join([q(p['email']), q(p['sold_at']), q(p['product_id']), q(p['name']), q(p['unit']),
                                  str(p['qty']), str(p['price_cents']), q('shopify')]) + ');')
        print('\n'.join(out))
    print(f'-- {len(purchases)} paid purchase lines, {len({p["email"] for p in purchases})} customer emails', file=sys.stderr)


if __name__ == '__main__':
    main()
