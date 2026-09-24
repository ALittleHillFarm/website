# A Little Hill Farm — store

A small pre-order store for a farm that sells bulk feed. Runs on Cloudflare
Workers with a D1 database. **Zero dependencies** — no npm packages, no
framework, no container. The only thing to keep patched is nothing.

```
config.json    operational settings — pickup spots, tax rate, discounts, terms
products.json  the catalog. edit, commit, deploy.
schema.sql     the ledger — four tables
worker.js      the entire application (~1,000 lines)
wrangler.toml  deploy config
public/        the storefront
```

Read [DESIGN.md](DESIGN.md) for why it is shaped this way.

---

## First-time setup

### 1. Cloudflare DNS migration

Captured from live DNS on 2026-09-21. These are the records that must survive
the move — verify each one in Cloudflare before switching nameservers.

**Status: done.** The zone is Active on Cloudflare (`janet` / `kyrie.ns.cloudflare.com`)
and Proton mail verified healthy afterwards. Kept below as the record of what
had to survive the move, and as the checklist if it ever has to be repeated.

> **Open item:** the apex and `www` records were imported **proxied** (orange
> cloud). Shopify still answers, but it does not support being proxied and its
> certificate renewals can fail behind it. Set both to **DNS only** until the
> farm-site cutover below replaces them.

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
(the sandbox one points at the `workers.dev` address — see *Going live* below)
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

## Going live — the switch from test addresses

Both sites currently run on their `workers.dev` addresses:

| | Test address | Real address |
|---|---|---|
| Farm site | `https://alhf-site.shiny-band-89b4.workers.dev/` | `https://alittlehillfarm.com/` |
| Store | `https://alhf-store.shiny-band-89b4.workers.dev/` | `https://store.alittlehillfarm.com/` — **live** |

The store is on its real address. The store still links back to the farm
site's test address, because the apex belongs to Shopify until step 3. In order:

1. ~~**Store domain.**~~ Done 2026-09-24: `store.alittlehillfarm.com` serves
   the store and every Feed Store link points at it. The `workers.dev` address
   stays on only for the sandbox webhook.
2. **Stripe live.** Create the live webhook against the real store address,
   put the live keys in `.env`, `npx wrangler secret bulk .env`, run the smoke
   test below. Deactivate the *Goat Breath* test product.
3. **Farm site.** Attach `alittlehillfarm.com` and `www` to `alhf-site`
   (replacing the Shopify records), then change the farm links in
   `store/public/*.html` back to the apex. Cancel Shopify only after both sites
   have served real traffic for a few days.

Find every remaining test address with:
`grep -rl shiny-band-89b4 --include=*.html --include=*.py .`

---

## How to test a purchase

### While in sandbox — test cards only

A real card number is rejected in test mode, so there is nothing to gain by
trying one, and never use a card that is not yours. Stripe publishes numbers
for every outcome. Any future expiry, any CVC, any ZIP.

| Card | What happens |
|---|---|
| `4242 4242 4242 4242` | Succeeds — the normal path |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 9995` | Insufficient funds |
| `4000 0000 0000 0069` | Expired card |
| `4000 0000 0000 0127` | Wrong CVC |
| `4000 0025 0000 3155` | Requires 3D Secure |

For ACH, use routing `110000000` with:

| Account | What happens |
|---|---|
| `000123456789` | Succeeds |
| `000222222227` | Insufficient funds |
| `000111111113` | Account closed |
| `000000004954` | Blocked by Radar |
| `000555555559` | Triggers a dispute |

Test ACH settles instantly. **Live ACH takes several days** — do not read the
instant test result as how it will behave in production.

### The live smoke test, for about 33 cents

Once the live keys are in, you do need one real transaction. Make it cheap
instead of buying a $127 bag of kelp from yourself.

1. **Inventory tab → set one product to $1.00.** The decimal-point guard will
   stop you and ask for confirmation, which conveniently tests that too.
2. **Order A — prove the free path.** Buy it with your own card. Confirm it
   lands as `authorized`, that your bank shows a *pending hold* and not a
   charge, then **Cancel** it. Watch the hold disappear. This costs **nothing**
   and exercises checkout, the webhook, the admin screen and cancellation.
3. **Order B — prove money moves.** Order again, **Capture** it, confirm it
   reaches your Stripe balance, then refund it from the Stripe dashboard.
   You lose the processing fee — about **33c** on a $1 order — and that is
   the whole cost of knowing the system works.
4. **Set the price back.** The guard will ask again.

Do not skip step 2. Cancelling an authorization is the single most important
behaviour in this store, and it is the one you will use on every suspicious
order.

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

Set `active: true` on a product to put it on sale. Everything that sold on
Shopify between 2022 and September 2026 is on, except the bulk totes and
Loyalty Senior Horse Pellets; the rest of the Shopify import is
`active: false`. Products added from that sales report carry
`cost_cents: 0` until a supplier cost is entered in `/admin`.

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
