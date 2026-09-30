# Moving from Cloudflare to Render — analysis

*Written 2026-09-30. Prices and limits were checked against Render's docs and
pricing summaries that day; re-check before acting on them.*

## Recommendation

**Stay on Cloudflare** unless one of the triggers at the bottom applies.
Moving would take hosting from about **$0/month to roughly $15–35/month**, cost
several days of rewriting and payment re-testing, and change nothing a customer
would notice.

## What runs on Cloudflare today

| Piece | Cloudflare today | Cost |
|---|---|---|
| Farm site (pages, goat pages, sitemap, Shopify redirects) | Worker `alhf-site` + static assets | $0 |
| Store, admin, Stripe webhook, customer sign-in | Worker `alhf-store` | $0 |
| Database (sales, customers, goats, product settings, login codes, alert state) | D1 (SQLite) `alhf-store` | $0 |
| Uploaded photos | R2 bucket `alhf-media` | $0 |
| Site checks (every 30 min) + 7am digest | Cron triggers on `alhf-store` | $0 |
| DNS, TLS, checkout rate-limit rule, DDoS protection | Cloudflare zone `alittlehillfarm.com` | $0 |
| Email (sign-in codes, order confirmations) | Resend (independent of host) | $0 |

Free-plan limits to watch: 100,000 Worker requests/day and a small per-request
CPU budget. The farm is far below both. If either is ever hit, **Workers Paid
is $5/month** — far cheaper than moving.

## The same system on Render

| Piece | Render equivalent | Approx. cost |
|---|---|---|
| Farm site | Static site is free, but goat pages are rendered from the database, so it needs a **web service** (or merge into the store's) | $7/mo or $0 if merged |
| Store server | **Web service, Starter** (0.5 CPU, 512 MB) | **$7/mo** |
| Database | **Postgres Basic-256mb** (free Postgres is deleted after 30 days) | **$6/mo** (1 GB tier $19/mo) |
| Photos | No built-in object storage: persistent disk on a paid service, or keep R2 / use S3 | ~$1/mo |
| Site checks + digest | **Cron job** service | small monthly charge |
| DNS / TLS | Render issues certificates; DNS would stay on Cloudflare | $0 |
| Team features, more bandwidth | **Pro workspace** if needed (Hobby includes 5 GB/mo bandwidth) | $25/mo |

**The free web service is not usable for the store:** it spins down after 15
minutes without traffic and takes about a minute to wake. The first shopper of
the morning waits, and Stripe webhooks can time out during the wake-up.

## What we would gain

- **A conventional server.** Plain Node.js instead of Cloudflare-specific APIs.
  Any developer or AI tool knows the shape, and it could move again (Fly,
  Railway, a small VPS) without another rewrite.
- **Postgres instead of D1.** More capable database and tooling; managed backups
  on paid tiers. Not a limitation at the farm's size.
- **No per-request time limits.** Long jobs become easy: big CSV imports, PDF or
  label generation, bulk emails, image processing.
- **One simpler dashboard** for logs, deploys, env vars and a shell.
- **Push-to-deploy from GitHub** out of the box (possible on Cloudflare too;
  today we deploy from the laptop).

## What we would lose

- **Money:** ~$15–35/month for the same thing, growing with add-ons — the
  opposite of why we left Shopify ($45/month).
- **Edge serving:** Cloudflare serves from hundreds of locations with no
  restarts or maintenance windows. Render runs in one region (e.g. Oregon —
  close enough for Idaho customers, so this matters less than it sounds).
- **Built-in protection:** the checkout rate limit and DDoS protection come with
  Cloudflare. We could keep Cloudflare proxying in front of Render, but then we
  run both.
- **Free extras:** R2 photo storage, cron triggers, and D1 Time Travel restore
  points (up to 30 days) each become a paid service or extra setup.
- **Working, tested code.** A move means rewriting:
  - the page-rendering layer (it uses Cloudflare's `HTMLRewriter`);
  - every query, SQLite → Postgres (`INSERT OR IGNORE`, `json_set`, date handling);
  - photo storage (R2 binding), secrets handling, cron triggers;
  - then re-running the full payment test cycle (card authorize/cancel,
    capture, refund, bank transfer, webhooks) plus Google sign-in and email
    checks — several days, with real risk of new bugs in the money path.
- **Zero dependencies:** the store has no npm packages to patch today. A typical
  Render app brings a Node server and packages that need security updates.

## Triggers that would make Render (or similar) worth it

- Need for **long-running or scheduled heavy work**: nightly reports, bulk
  email, image processing, an accounting-software integration.
- Wanting a **conventional app** so a hired developer can work on it without
  learning Cloudflare Workers.
- **Outgrowing D1** — thousands of orders a month, far beyond current volume.

## If we ever do move — the plan

1. **Keep Cloudflare DNS** (and optionally proxying/WAF) in front of Render.
2. One Render **web service** running both sites (Node, a small router that
   ports `site-worker.js` and `store/worker.js` routes; replace `HTMLRewriter`
   with a server-side HTML transform).
3. **Postgres Basic**: port `store/schema.sql`; export D1
   (`wrangler d1 export alhf-store --remote`) and load it.
4. Photos: keep **R2** via its S3-compatible API (no migration needed) or copy
   to a Render disk.
5. **Cron job** service for `siteChecks` / `morningDigest`.
6. Move secrets from `store/.env` to Render environment variables.
7. Stage on a Render URL, run the full payment + sign-in test list from
   `store/README.md`, then point the Stripe webhook and DNS at Render.
8. Keep the Cloudflare Workers deployed (unrouted) for a week as rollback.

## Sources

- [Render free tier docs](https://render.com/docs/free)
- [Render pricing overview (Kuberns)](https://kuberns.com/blogs/render-pricing/)
- [Render pricing calculator (Makerkit)](https://makerkit.dev/pricing-calculator/render)
- [Render pricing (srvrlss.io)](https://www.srvrlss.io/provider/render/)
- [Render pricing (Costbench)](https://costbench.com/software/developer-tools/render/)
- [Render: hosting cost for small businesses](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses)
