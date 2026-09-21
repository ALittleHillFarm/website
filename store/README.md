# A Little Hill Farm — store

A small pre-order store for a farm that sells bulk feed. Runs on Cloudflare
Workers with a D1 database. **Zero dependencies** — no npm packages, no
framework, no container. The only thing to keep patched is nothing.

```
config.json    operational settings — pickup spots, tax rate, discounts, terms
products.json  the catalog. edit, commit, deploy.
schema.sql     the ledger — three tables
worker.js      the entire application (642 lines)
wrangler.toml  deploy config
public/        the storefront
```

Read [DESIGN.md](DESIGN.md) for why it is shaped this way.

---

## First-time setup

### 1. Cloudflare DNS migration

Captured from live DNS on 2026-09-21. These are the records that must survive
the move — verify each one in Cloudflare before switching nameservers.

**Current state**

| | |
|---|---|
| Nameservers | `ns1-32.azure-dns.com`, `ns2-32.azure-dns.net`, `ns3-32.azure-dns.org`, `ns4-32.azure-dns.info` — **Azure DNS**, a paid resource to retire afterwards |
| Apex `A` | `23.227.38.65` — Shopify |
| `www` CNAME | `shops.myshopify.com` |
| Email | Proton Mail, fully configured |

**Every record that must exist in Cloudflare**

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `@` | `23.227.38.65` | **DNS only** |
| CNAME | `www` | `shops.myshopify.com` | **DNS only** |
| MX | `@` | `mail.protonmail.ch` — priority **10** | n/a |
| MX | `@` | `mailsec.protonmail.ch` — priority **20** | n/a |
| TXT | `@` | `v=spf1 include:_spf.protonmail.ch mx ~all` | n/a |
| TXT | `@` | `protonmail-verification=8425d4f9fafc434eceed4087b0c38160cefb61cf` | n/a |
| TXT | `_dmarc` | `v=DMARC1; p=none` | n/a |
| CNAME | `protonmail._domainkey` | `protonmail.domainkey.dro42pci2znvm6cfpn6wohw3zh7bi55cpatsao35e4v3l4rvxpvsa.domains.proton.ch` | **DNS only** |
| CNAME | `protonmail2._domainkey` | `protonmail2.domainkey.dro42pci2znvm6cfpn6wohw3zh7bi55cpatsao35e4v3l4rvxpvsa.domains.proton.ch` | **DNS only** |
| CNAME | `protonmail3._domainkey` | `protonmail3.domainkey.dro42pci2znvm6cfpn6wohw3zh7bi55cpatsao35e4v3l4rvxpvsa.domains.proton.ch` | **DNS only** |

> **Cloudflare does not host mailboxes.** Email Routing is inbound forwarding
> only — no storage, no sending. Proton stays exactly as it is; only the MX
> records move, and they keep pointing at Proton.
>
> **The three DKIM CNAMEs must be grey-cloud.** Cloudflare defaults new CNAMEs
> to proxied, and a proxied DKIM record resolves to Cloudflare instead of
> Proton's key. Outbound mail then silently fails DKIM and starts landing in
> spam. Nothing visibly breaks, which is what makes it dangerous.
>
> **Never enable Cloudflare Email Routing.** It rewrites MX to Cloudflare's own
> and takes Proton out of the path.
>
> **Shopify records stay grey-cloud too.** Shopify terminates its own TLS;
> proxying in front of it causes redirect loops.

**Order of operations**

1. Add the domain to Cloudflare (free plan). Let it scan and import.
2. Compare the imported records against the table above, line by line. Add
   anything missing by hand. **Do not skip this step.**
3. Set every CNAME above to DNS only (grey cloud).
4. At the **registrar** — not Azure — replace the nameservers with Cloudflare's two.
5. Wait for Cloudflare to report the zone Active.
6. Verify: load the Shopify site; send mail **to** the domain; send mail **from**
   it to an outside address and confirm it did not land in spam. Inbound proves
   MX, outbound proves SPF and DKIM.
7. Only now add `store` as a CNAME to the Worker, or let `wrangler deploy`
   attach the custom domain.
8. Enable *Always Use HTTPS*, SSL/TLS **Full (strict)**, and a rate-limiting
   rule: path equals `/api/checkout`, 10 requests per minute per IP, Block.
9. Leave the Azure DNS zone in place, unmodified, for at least a week as a
   rollback path. Delete it only once everything is confirmed healthy.

**Later, at farm-site cutover:** repoint the apex away from Shopify, add a
Redirect Rule `www` -> apex, and only then retire the App Service.

### 2. Database

```bash
cd store
npx wrangler d1 create alhf-store
```

Copy the printed `database_id` into `wrangler.toml`, then:

```bash
npx wrangler d1 execute alhf-store --remote --file=schema.sql
```

### 3. Stripe

Create the account. **Do not enable surcharging** — this is a cash-discount
program and needs no registration. See DESIGN.md for why that distinction matters.

Enable ACH: **Settings → Payment methods → US bank account**. Turn on instant
verification (Financial Connections), not micro-deposits.

Add the webhook endpoint at `https://store.alittlehillfarm.com/api/webhook`
subscribed to exactly these events:

- `checkout.session.completed`
- `checkout.session.expired`
- `payment_intent.amount_capturable_updated`
- `payment_intent.succeeded`
- `payment_intent.canceled`
- `charge.dispute.created`

`payment_intent.canceled` is not optional. It is how an expired authorization
gets recorded. Without it the admin screen keeps offering to capture a hold the
bank has already released.

Set **Radar rules to Review, not Block**, at least at first:

```
Review if :card_country: != 'US'
Review if :amount_in_usd: > 300
Block  if Postal code verification fails based on risk score
```

### 4. Secrets and deploy

Put the values in `.env` (gitignored), then:

```bash
npx wrangler secret bulk .env
npx wrangler deploy
```

> **Never put a `#` in a secret.** Wrangler parses `.env` with `#` as a comment
> marker, so `ADMIN_PASSWORD=abc#def` uploads silently as just `abc`. Quoting
> does not help — the comment is stripped first. You get no warning, and the
> password you think you set is not the one in effect.
>
> If a value must contain `#`, bypass `.env` entirely:
> `printf '%s' 'the#value' | npx wrangler secret put ADMIN_PASSWORD`

> **Secrets take a minute to propagate.** Right after an upload some edge
> locations still hold the old value, so auth can fail intermittently. Wait and
> retry rather than assuming the password is wrong.

Add `store.alittlehillfarm.com` as a custom domain when prompted. The certificate
is automatic and free.

---

## Before taking real money

Run every one of these against Stripe **test mode**. Do not skip the boring ones —
the failure paths are where money goes missing.

- [ ] Card order from a new customer → lands as `authorized`, **no money moves**
- [ ] Capture it → status `captured`, funds appear in Stripe
- [ ] Capture a **partial** amount → remainder released, sale reflects the lower total
- [ ] Cancel an authorization → status `canceled`, **no fee charged**
- [ ] Declined card (`4000000000000002`) → no sale row left in `pending`
- [ ] Let an authorization expire → webhook flips it to `canceled` on its own
- [ ] Replay a webhook from the Stripe CLI → second delivery is a no-op
- [ ] Send a webhook with a bad signature → rejected with 400
- [ ] Tamper with a price in the browser devtools → server ignores it entirely
- [ ] Trusted customer → captures immediately, no review step
- [ ] Tax-exempt customer → tax is zero, `exemption_ref` stored on the sale
- [ ] ACH order end to end
- [ ] Cash order from an untrusted customer → refused with a clear message
- [ ] Record a cash milk sale → appears in the quarterly report
- [ ] Quarterly report totals match Stripe's own payout report
- [ ] Cost basis is NOT visible in `/api/catalog` or `/api/quote` responses

Then do one **live** low-dollar order, capture it, and one more that you cancel
before capture. Confirm both in your bank and in Stripe before going public.

---

## Day to day

**A new order arrives.** It sits as `authorized` — the card is held, nothing is
charged. Open `/admin`, look it over, then Capture or Cancel.

Capture when you are ready to place the supplier order. **Cancelling costs
nothing. Refunding after capture costs 2.9% + 30¢ forever.** That asymmetry is
the whole reason the hold exists.

**Card holds expire in seven days.** Review within a day or two. Capture funds
the bulk purchase; it does not mean the order shipped.

**Emails are sent by hand.** The admin screen tracks which stage emails have gone
out per order — received, supplier ordered, arrived, picked up — so nothing gets
missed. Tick them off as you send them.

**Cash, milk, cheese and goat sales** go in through *Record a sale*. They land in
the same ledger, so the quarterly report covers everything, not just the website.

**Quarterly Idaho filing.** Admin → Tax report, enter the quarter dates. Gross,
exempt, taxable subtotal and tax collected.

---

## Changing things

| To change | Edit | Then |
|---|---|---|
| **Price, cost, freight, on/off** | **`/admin` → Inventory** | **nothing — takes effect immediately** |
| A genuinely new product, or its name/photo/description | `products.json` | commit + `wrangler deploy` |
| Pickup locations, tax rate, discounts | `config.json` | commit + `wrangler deploy` |
| The pre-order terms text | `config.json` — **bump `terms.version`** | commit + deploy |

Set `active: true` on a product to put it on sale. Everything imported from
Shopify is `active: false` — turn on only what you actually stock.

Bumping `terms.version` matters: each sale stores the version the customer
accepted, so old orders keep the wording they actually agreed to. That is the
evidence if a delayed delivery is ever disputed.

---

## Turning shipping back on (P2)

Set `shipping.enabled: true` in `config.json`. `allowed_states` is already
populated and validated server-side.

One rule to keep: **shipped orders should always use manual capture**, whatever
the customer's trust level. Ship-to-a-drop-address is the fraud pattern that
caused the original problem, and pickup is what currently makes it impossible.
