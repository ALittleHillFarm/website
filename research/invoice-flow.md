# Invoice lifecycle: duck review and decisions

Written 2026-10-28 after a real invoice (Kayla Howard) was created and never emailed, and nothing in the admin made that obvious. The owner using this is not technical, so the rule for every decision below is: **the admin screen must say what state each invoice is in and what to do next, in plain words.**

States an invoice can be in (`sales.status` plus send state):
`invoiced` (unpaid) -> `captured` (card paid) / `processing` (bank transfer in flight) -> `captured`, or `failed`; `recorded` (cash/check); `canceled`; `refunded`.
Send state is separate: never sent, sent N times, last attempt failed.

## Stage by stage

### 1. Create
- **Owner needs:** a choice between "email it now" and "save without sending", and an unmistakable result: emailed to X at T, or saved and NOT sent. If the email fails, what to do (use Send now on the Orders tab, or copy the link and text it).
- **Customer needs:** nothing until the email arrives.
- **Was:** two buttons, and the result was one line of green text, even when the email failed. "Create without emailing" left no durable trace that the invoice was unsent. This is how Kayla's invoice got lost.
- **Decision (now):** a checkbox "Email it to the customer now" (default on) plus one Create button. A result panel with status, the pay link and a copy button. A failed email gives plain instructions.

### 2. Sent / not sent / email failed
- **Was:** only `invoice_sent_at` (success only). Failures were returned to the browser once and then forgotten. A resend overwrote the timestamp, so "sent twice" was invisible.
- **Decision (now):** columns `invoice_send_count`, `invoice_last_error`, `invoice_last_attempt_at`. Every attempt, success or failure, is recorded. A failure keeps the previous `invoice_sent_at` (an earlier success still happened) but sets `invoice_last_error`; a success clears the error.
- Card shows: amber "Not sent yet" (with a Send now button), "Sent 10/26 3:12 PM (2 times)", or red "Email failed: reason".
- Honest limit: "sent" means our email provider accepted it, not that it reached an inbox. Bounce tracking (provider webhook) is **later**.

### 3. Lost in email
- Common causes: junk folder, wrong address, address typo at the phone call, customer never checks that account.
- **Decision (now):** hint on every unpaid invoice: ask them to check junk/spam; you can also copy the pay link and text it. "Change email & send" corrects the address on an unpaid invoice and sends to the new one. Validation: well-formed address. If the new address already belongs to a known customer we leave that customer record untouched; if it is new we create a customers row. We never rename or merge an existing customer.
- The invoice's `customer_email` changes on the sale. The old customer row stays (it may be a real person with other history).
- Resend uses subject "Reminder: Invoice ..." once it has been sent before.
- Double-send protection: the button disables while working, and the server refuses a second attempt within 30 seconds of the last one ("just sent a moment ago").

### 4. Reminders for unpaid
- **Was:** only a Needs attention line after 7 days, with no detail lines (who? how much?).
- **Decision (now):** detail lines per invoice (customer, amount, ref, age). The morning digest includes them. The owner decides whether to press Resend (which is the reminder).
- **Later:** automatic customer reminder emails (e.g. day 5 and day 12). Risky to automate before we know the bounce situation and the owner's tone; a surprise automatic dunning email to a friend is worse than a late one.

### 5. Payment fails (bank transfer bounces)
- **Was (real bug):** webhook `payment_intent.payment_failed` sets status `failed`. For an invoice that is a dead end: `/api/invoice/pay` refuses anything that is not `invoiced`, and the pay page treats every non-`invoiced` status as "Paid - thank you!". A customer whose bank transfer bounced was told they had paid, could not retry, and got no email. The farm got an ntfy alert.
- **Decision (now):** for invoices, a failed bank payment puts the invoice back to `invoiced` (the link works again), appends a note, alerts the farm, and emails the customer: "your bank payment did not go through; use the same link to try again or pay by card". Non-invoice orders keep today's behaviour (`failed`).
- Pay page: `processing` shows "Payment received and on its way (bank transfers take a few business days)" rather than "Paid".
- A declined card never completes checkout, so the customer just sees Stripe's own error and tries again.

### 6. Paid
- Online (card): webhook -> `captured`, stock moves recorded, farm notified (ntfy + new-order email), customer gets a confirmation.
- **Was (real bug):** `sendOrderConfirmation` and `sendFarmOrderEmail` read `line_total_cents` from each line. Invoice lines are stored raw (`list_price_cents`), so every line in both emails showed **$0.00**, and the customer email says "your order is in ... 2-4 weeks from our suppliers", which is wrong for an invoice.
- **Decision (now):** one helper for a line's amount that works for both shapes; invoice-specific customer wording ("We received your payment for invoice X", no supplier-timing paragraph, farm contact); farm email says "Invoice paid".
- Two open Stripe sessions: a customer who opens the pay page twice can complete both; the second payment finds the sale already paid and is charged with no record. **Decision (now):** each new pay attempt expires the previous open session; cancel and record-cash expire it too.

### 7. Cash / check at pickup
- **Was:** records the payment and stock moves, but no receipt to the customer; the UPDATE was not guarded, so a double click or a simultaneous online payment could both apply; the open Stripe session stayed payable.
- **Decision (now):** guarded UPDATE (`WHERE status = 'invoiced'`), expire any open Stripe session, send the customer a receipt email. No farm email: the farm just did it.

### 8. Cancel / void
- Old link before: a red "not valid any more" error with no explanation or contact.
- **Decision (now):** the pay page says plainly "This invoice (ref) was cancelled" with how to reach the farm (email, phone). An unknown link keeps a generic message so nobody can probe which tokens exist.
- Cancel also expires an open Stripe session.
- We do not email the customer on cancel (the owner may be cancelling a mistake the customer never saw). **Later:** optional "tell the customer" checkbox.

### 9. Edit after sent
- **Decision: no editing.** The customer may already have the old amount in their inbox or a half-finished Stripe session; changing amounts under a live link is how double charges and disputes happen. Process: Cancel, then create a new invoice. The cancelled invoice stays in the list for the record.
- **Later:** a "Copy as new invoice" button to pre-fill the form from an existing one, which makes cancel-and-redo painless.
- Exception built now: correcting the email address (does not change money).

### 10. Expired / forgotten links
- Tokens never expire by time. A forgotten unpaid invoice stays payable until cancelled, which is what we want (customers do pay weeks later); the unpaid-over-a-week attention item is the nudge to follow up.
- **Later:** optional auto-expiry (e.g. 90 days). Not needed at this volume.

### 11. Privacy of the link
- The token is 24 random bytes (192 bits): unguessable. Possession means access, like a Stripe invoice link.
- The link shows: customer name, items, totals, pickup, note. Not email, phone or address.
- Pay page is `noindex`. **Now:** add `referrer: no-referrer` so the token cannot leak to third parties (fonts) through Referer; API responses are already `no-store`.
- Forwarding the email forwards the ability to pay, not to see anything sensitive. Acceptable.

## Gaps and risks found in the current code
1. Send failures never stored; success timestamp overwritten on resend (no count). **Fix now.**
2. Unsent invoices look the same as sent ones in the list; the default filter hides them. **Fix now.**
3. Needs attention has no unsent / failed-email items; unpaid-over-a-week has no detail lines. **Fix now.**
4. Failed bank payment on an invoice: customer told "Paid", cannot retry, no customer email. **Fix now.**
5. Confirmation and farm emails show $0.00 for invoice lines, and use order wording. **Fix now.**
6. Cash/check: unguarded update, no receipt, open Stripe session still payable. **Fix now.**
7. Cancel / re-pay leave older Stripe sessions payable (double payment). **Fix now.**
8. Cancelled link shows an unexplained error; no farm contact on the pay page except the generic footer. **Fix now.**
9. Creating an invoice overwrites an existing customer's name with whatever was typed. **Fix now** (keep the existing name; fill blanks only).
10. A wrong address cannot be fixed. **Fix now.**
11. No bounce tracking, automatic reminders, copy-as-new, cancel notice or link expiry. **Later**, reasons above.
12. "Sent" means the email provider accepted it. **Accepted limitation**, documented in the README.
