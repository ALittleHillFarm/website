You’re right to focus on this. The transaction store is where “cheap and simple” can quietly become “fragile and expensive.”
## My revised recommendation
For this store, I would choose one of these two paths:

1. **Turso Cloud using libSQL**, if you want SQLite semantics and the lowest practical operating cost.

2. **Neon Free Postgres**, if you value conventional relational-database portability over your preference for SQLite/MySQL.

I would **not put the authoritative order database in a local SQLite file on Azure App Service**. It can be made to work in a tightly constrained single-instance deployment, but the Azure storage model introduces enough locking, durability, deployment, and recovery complications that the savings are not worth it for payment records.

For A Little Hill Farm, **Turso looks like the best fit**.

# Why local SQLite on Azure App Service is problematic
There are really three possible locations for a SQLite file:
## 1. Inside the container filesystem
This is unsafe because the container filesystem should be treated as ephemeral. A restart, redeployment, relocation, or replacement can remove the new data.

That rules it out for paid orders.
## 2. In App Service’s persistent /home storage
This sounds better, but the persistent filesystem presented to App Service applications is network-backed. Microsoft guidance specifically warns that SQLite relies on file handles and locks and can run into locking problems on App Service storage, especially if the application scales. [[learn.microsoft.com]](https://learn.microsoft.com/en-us/answers/questions/346794/how-to-update-or-insert-sqlite-database-in-web-app), [[learn.microsoft.com]](https://learn.microsoft.com/en-us/answers/questions/1399494/locating-sqlite-file-on-azure-after-publishing-web)

The specific failure modes include:

- SQLite’s locking assumptions not lining up cleanly with the remote filesystem.

- Lock contention if more than one worker or instance accesses the file.

- Accidental scale-out introducing multiple SQLite writers.

- Deployment slots or overlapping deployments opening separate application instances.

- Backups capturing a live database file incorrectly.

- The application restarting while a write is active.

- Ambiguity about which filesystem copy is authoritative.

Even if traffic never exceeds two concurrent customers, the platform can still restart or relocate the application. Your visitor count does not eliminate the platform-level lifecycle issue.
## 3. An Azure Files mount
This is the option I would explicitly avoid for SQLite. Microsoft says storage mounts are not recommended for local databases such as SQLite or other components depending on file handles and locks. [[learn.microsoft.com]](https://learn.microsoft.com/en-us/answers/questions/1229984/how-to-download-sqlite-database-from-azure-web-app)

Azure Files also carries its own charge, and mounted storage is not automatically included in App Service backups. [[learn.microsoft.com]](https://learn.microsoft.com/en-us/azure/app-service/configure-connect-to-azure-storage)

So you could end up paying for Azure storage while still having a less dependable database configuration.

# Best fit: Turso Cloud
Turso provides a managed, SQLite-compatible database reachable over the network. This separates the application container from the authoritative database without requiring a traditional always-running MySQL or Postgres server.

Its current free plan includes:

- $0 per month

- 5 GB of storage

- 500 million rows read per month

- 10 million rows written per month

- 100 databases

- One day of point-in-time recovery [[turso.tech]](https://turso.tech/pricing)

Those limits are many orders of magnitude beyond what your store should need.
## Does it provide real transactions?
Yes. Turso supports explicit BEGIN, COMMIT, and ROLLBACK transactions. Multiple statements can be grouped into one atomic unit, meaning either all changes commit or all are rolled back. It also supports savepoints and implicit transactions for individual statements. [[docs.turso.tech]](https://docs.turso.tech/sql-reference/statements/transactions)

That is sufficient for operations such as:

| 1     `BEGIN`2     3     `Create order`4     `Create order lines`5     `Record Stripe payment-intent ID`6     `Record authorization expiration`7     `Create initial audit event`8     9     `COMMIT` |
| --- |
If any step fails, none of the order is committed.
## Backup and recovery
Turso automatically creates recovery information at transaction commit. Free-plan databases can be restored to a point within the previous 24 hours. Its restore process creates a new database, after which you update the application connection string and token. [[docs.turso.tech]](https://docs.turso.tech/features/point-in-time-recovery)

The $4.99-per-month Developer plan currently increases the restore window and included resources. [[turso.tech]](https://turso.tech/pricing)

For a financial order system, I would supplement provider recovery with a periodic logical export to inexpensive Azure Blob Storage or another independent destination. That gives you:

- Provider point-in-time recovery for fast operational mistakes.

- Independent nightly or daily exports.

- Long-term order archives.

- A migration path if pricing or service terms change.
## Which Turso engine?
For production orders today, I would start with **libSQL on Turso Cloud**.

Turso describes libSQL as its production-ready, battle-tested SQLite fork with SQLite file-format and API compatibility. Its newer Turso Database engine adds concurrent-write capabilities but is more recently introduced on the cloud platform. [[docs.turso.tech]](https://docs.turso.tech/libsql), [[docs.turso.tech]](https://docs.turso.tech/turso-cloud)

Your store does not need cutting-edge concurrent writes. It needs boring, understandable durability.
## Do you need embedded replicas?
No.

Use the **remote database directly** from the server-side store application:

| 1     `Browser`2     `   |`3     `Azure App Service container`4     `   |`5     `Turso/libSQL over TLS`6     `   |`7     `Authoritative order database` |
| --- |
Embedded replicas are useful for heavier read traffic or local-first applications. They add synchronization behavior that your tiny store does not need.

The product catalog can still live in a version-controlled JSON or YAML file. Only transactional state needs the remote database.

# Second choice: Neon Postgres
Neon currently has a $0 plan with:

- 0.5 GB storage per project

- 100 compute-unit hours per month per project

- Scale-to-zero after five minutes

- One manual snapshot

- A limited point-in-time restore window [[neon.com]](https://neon.com/pricing), [[neon.com]](https://neon.com/docs/introduction/plans)

A small store database should fit comfortably within 0.5 GB. Orders composed mostly of text, identifiers, addresses, and totals remain small unless you put images, logs, or webhook bodies into the database.
## Advantages over Turso
- Standard Postgres.

- Excellent ORM and migration support.

- Easy portability to another Postgres provider.

- Strong constraints, indexing, transaction semantics, and tooling.

- Built-in pooled connection endpoint using PgBouncer. [[neon.com]](https://neon.com/docs/connect/connection-pooling)

- Better choice if the application may grow into something larger.
## Disadvantages for your use case
- It is Postgres, not SQLite or MySQL.

- Scale-to-zero creates occasional cold-start latency. Neon documents that activation typically takes a few hundred milliseconds, excluding network and other services. [[neon.com]](https://neon.com/docs/connect/connection-latency)

- The free plan’s 0.5 GB storage and recovery capabilities are less generous than Turso for this particular workload. [[neon.com]](https://neon.com/docs/introduction/plans)

- You need to pay attention to connection pooling, though that is manageable with one App Service instance.

Because your application runs in a persistent Azure container rather than a short-lived edge function, you would use a conventional Postgres driver with a small connection pool. Neon recommends a standard TCP driver and pooling for Docker or self-hosted persistent environments. [[neon.com]](https://neon.com/docs/connect/choose-connection)

A pool of approximately two to five connections would be more than enough for this store.

# What about MySQL?
Unfortunately, the inexpensive scale-to-zero managed-database market currently offers better choices in Postgres and SQLite-compatible systems than in ordinary MySQL.

PlanetScale is MySQL-compatible through Vitess, but its official current pricing is aimed above your requirements rather than at a permanently free tiny production store. Its pricing page describes resource-based Vitess deployments, while its lowest published single-node entry point is for Postgres, starting at $5 per month. [[planetscale.com]](https://planetscale.com/pricing)

Even when the monthly price is tolerable, using Vitess for a feed store processing a few orders would be substantial architectural overkill.

My opinion: **do not let the MySQL preference force you into a more expensive or complex solution.** The schema for this application is simple enough that moving between SQLite/libSQL, Postgres, and MySQL later would be straightforward if we keep provider-specific SQL out of the core data layer.

# Other viable alternatives
## Cloudflare D1
Cloudflare D1 is a SQLite-based serverless SQL database. Its free allowance includes five million rows read per day, 100,000 rows written per day, and 5 GB total storage. It scales to zero rather than billing by active compute time. [[developers...dflare.com]](https://developers.cloudflare.com/d1/platform/pricing/)

It also provides a seven-day Time Travel recovery window on the free plan, although the free database-size limit is 500 MB per database. [[developers...dflare.com]](https://developers.cloudflare.com/d1/platform/limits/)

This is attractive if the whole store runs on Cloudflare Workers. It is less attractive as the database behind an Azure-hosted container because D1 is designed around native Worker bindings. Cloudflare describes it as the stateful backend integrated into its Workers ecosystem. [[cloudflare.com]](https://www.cloudflare.com/products/d1/)

I would not split the app between Azure and Cloudflare merely to gain D1 when Turso already offers a straightforward remote database API.
## Supabase
Supabase offers a free Postgres database with 500 MB storage, but free projects are paused after one week of inactivity. Its paid Pro plan starts at $25 per month. [[supabase.com]](https://supabase.com/pricing)

Although otherwise capable, automatic pausing after a week of inactivity is undesirable for a low-traffic commercial store. Low traffic is exactly what could repeatedly trigger it.

For that reason, I rate Neon above Supabase here.

# Recommended data split
One important optimization is that we do **not** need to put everything in the transaction database.
## Keep in source-controlled files
- Product names

- Descriptions

- Current prices

- Product images or image URLs

- Categories

- Active/inactive flags

- Shipping configuration

- Allowed states

- Pickup instructions

- General farm and goat content

For example:

| 1     `products``:`2     `   -  ``id`` :  ``corn-free-layer-50`3     `      ``sku`` :  ``F50-LAYER-NC`4     `      ``name`` :  ``Corn-Free Layer Feed`5     `      ``weight`` :  ``50 lb`6     `      ``price_cents`` :  ``5799`7     `      ``taxable`` :  ``true`8     `      ``active`` :  ``true` |
| --- |
## Store transactionally
- Orders

- Order-line snapshots

- Customer-provided contact information

- Billing and shipping address snapshots

- Tax charged

- PaymentIntent ID

- Authorization state

- Capture deadline

- Capture/cancel status

- Provider webhook event IDs

- Refund records

- Administrative audit events

The order line should contain a snapshot of the product information used at checkout:

| 1     `product_id`2     `sku`3     `description`4     `quantity`5     `unit_price_cents`6     `tax_rate_basis_points`7     `tax_amount_cents`8     `line_total_cents` |
| --- |
That way, editing the product YAML next month does not alter an old order.

# Critical correctness pattern
The database transaction and payment-provider transaction cannot form one distributed ACID transaction. We therefore need an idempotent order state machine.

A safe sequence is:

1. Create a draft order and immutable total in the database.

2. Commit it.

3. Create the Stripe PaymentIntent using an idempotency key based on the order ID.

4. Save the PaymentIntent ID.

5. Customer completes authorization.

6. Receive the signed provider webhook.

7. Atomically move the order from payment_pending to authorized.

8. Review the order.

9. Capture or cancel it.

10. Process the resulting webhook idempotently.

11. Record every state change as an order event.

Suggested states:

| 1     `draft`2     `payment_pending`3     `authorized`4     `under_review`5     `approved_for_capture`6     `captured`7     `canceled`8     `authorization_expired`9     `capture_failed`10     `refunded`11     `disputed` |
| --- |
Every webhook event should have a unique constraint on the provider event ID. If Stripe delivers the event more than once, subsequent processing becomes a harmless no-op.

I would also use integer cents rather than floating-point currency values.

# What I would deploy
## Application
- One Azure Linux App Service instance

- One container

- No automatic scale-out

- Stateless application container

- Product catalog compiled or mounted as read-only content

- Server-side cart stored in a signed cookie or short-lived database record

- Stripe manual capture

- Turso libSQL remote database
## Availability and recovery
- Provider point-in-time recovery

- Daily encrypted logical export

- Export copied to Azure Blob Storage

- Monthly restore test into a temporary database

- CSV order export for accounting

- PaymentIntent IDs retained so orders can be reconciled against Stripe

- Alert if a backup does not complete

- Alert when an authorization approaches expiration
## Cost target
- Existing Azure App Service plan: no incremental compute if capacity permits

- Turso: $0 initially

- Stripe: transaction fees only

- Azure Blob backup storage: likely negligible at this data volume

- Optional future Turso Developer plan: $4.99 per month if you want a longer recovery window [[turso.tech]](https://turso.tech/pricing), [[docs.turso.tech]](https://docs.turso.tech/features/point-in-time-recovery)

That keeps the recurring platform cost close to zero without making the SQLite file inside App Service the single point of failure.
# Final decision matrix


| Choice | Database style | Free production fit | Recovery | Azure integration | My assessment |
| --- | --- | --- | --- | --- | --- |
| Turso libSQL | SQLite-compatible | Excellent | 24-hour PITR on free plan | Simple remote connection | **Best fit** |
| Neon | Postgres | Very good | Limited free history and snapshot | Standard TCP or pooled Postgres | **Best conventional option** |
| Local SQLite in App Service | SQLite file | No database bill | Entirely your responsibility | Locking and filesystem concerns | **Avoid for authoritative orders** |
| Cloudflare D1 | SQLite-based | Excellent | Seven-day free Time Travel | Best from Workers, not Azure | Good only if moving the app |
| Supabase | Postgres | Marginal for an infrequently used store | Free project pauses | Easy remote access | Not preferred |
| Managed Azure MySQL | MySQL | No | Strong, depending on tier | Native Azure | Too expensive for this use |
**My recommendation is now more specific: use Turso libSQL as the authoritative order store, retain products in YAML or JSON, and keep the Azure container stateless.** This preserves most of what you like about SQLite while moving durability, recovery, and file locking out of App Service.
