import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('history_import', Path(__file__).with_name('import-shopify-history.py'))
history_import = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history_import)


def order(**changes):
    return {'Name': '#1', 'Email': 'OLD@example.com', 'Financial Status': 'paid',
            'Created at': '2025-04-17 08:21:22 -0700', 'Total': '100.00', 'Refunded Amount': '0.00',
            'Lineitem name': 'An old product', 'Lineitem quantity': '1', 'Lineitem price': '100.00',
            'Billing Name': 'Returning Customer', 'Phone': '+1 503 555 0100', **changes}


class PurchaseHistoryImportTests(unittest.TestCase):
    def test_repeated_email_does_not_replace_order_header(self):
        rows = [order(), order(**{'Financial Status': '', 'Total': '', 'Lineitem name': 'Second item', 'Lineitem price': '5.00'})]
        result = history_import.purchases_from(rows)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[1]['email'], 'old@example.com')
        self.assertEqual(result[1]['sold_at'], '2025-04-17 08:21:22')

    def test_blank_email_continuation_inherits_order_header(self):
        rows = [order(), order(**{'Email': '', 'Financial Status': '', 'Total': '', 'Lineitem name': 'Second item'})]
        self.assertEqual(len(history_import.purchases_from(rows)), 2)

    def test_only_paid_unrefunded_non_canceled_orders_count(self):
        for status in ['refunded', 'voided', 'pending', 'authorized', 'partially_paid', '']:
            with self.subTest(status=status):
                self.assertEqual(history_import.purchases_from([order(**{'Financial Status': status})]), [])
        self.assertEqual(history_import.purchases_from([order(**{'Cancelled at': '2025-01-01'})]), [])
        self.assertEqual(history_import.purchases_from([order(**{'Refunded Amount': '100.00'})]), [])
        self.assertEqual(len(history_import.purchases_from([order(**{'Financial Status': 'partially_refunded', 'Refunded Amount': '50.00'})])), 1)

    def test_alias_preserves_original_email_and_adds_current_email(self):
        result = history_import.purchases_from([order()], {' OLD@example.com ': 'NEW@example.com'})
        self.assertEqual({p['email'] for p in result}, {'old@example.com', 'new@example.com'})

    def test_missing_email_is_reconciled_by_phone_and_name(self):
        customers = [{'email': 'current@example.com', 'name': 'Returning Customer', 'phone': '15035550100'}]
        result = history_import.purchases_from([order(Email='')], known_customers=customers)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['email'], 'current@example.com')

    def test_name_alone_or_ambiguous_phone_never_merges_accounts(self):
        customers = [{'email': 'current@example.com', 'name': 'Returning Customer', 'phone': '15035550101'}]
        self.assertEqual(history_import.purchases_from([order(Email='')], known_customers=customers), [])
        customers[0]['phone'] = '15035550100'
        customers.append({'email': 'other@example.com', 'name': 'Someone Else', 'phone': '15035550100'})
        self.assertEqual(history_import.purchases_from([order(Email='')], known_customers=customers), [])

    def test_phone_match_requires_name_agreement(self):
        customers = [{'email': 'current@example.com', 'name': 'Someone Else', 'phone': '15035550100'}]
        self.assertEqual(history_import.purchases_from([order(Email='')], known_customers=customers), [])

    def test_free_and_empty_lines_do_not_count(self):
        for changes in [{'Lineitem price': '0'}, {'Lineitem quantity': '0'}, {'Lineitem quantity': '-1'}]:
            self.assertEqual(history_import.purchases_from([order(**changes)]), [])


if __name__ == '__main__':
    unittest.main()
