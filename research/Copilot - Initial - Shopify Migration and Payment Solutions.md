## Bottom line
For A Little Hill Farm, I would **not** replace Shopify with another full-scale commerce platform. Your current site is primarily a farm and goat-breeding site with a relatively modest feed catalog, so the commerce component should be a small, isolated subsystem rather than the center of the architecture. [[alittlehillfarm.com]](https://alittlehillfarm.com)

My strongest recommendation is:

**A lightweight containerized storefront using a JSON or SQLite product catalog, a server-side cart, and Stripe Payment Element with manual capture.**

That would give you:

- Essentially no additional hosting charge if it fits into your existing Azure App Service plan.

- No ecommerce-platform subscription.

- Card data handled by Stripe, not by your application.

- An Idaho-region shipping allowlist.

- Manual approval before capture.

- The ability to cancel suspicious authorizations without paying normal processing fees.

- A dramatically smaller administrative and plugin footprint than WooCommerce.

The lower-development alternative is **self-hosted WooCommerce with the official Stripe extension**. It supports your key payment workflow out of the box, but brings the ongoing security and maintenance responsibilities of WordPress.

# What I found about your actual store
Your public site currently combines:

- Nigerian Dwarf goat information and breeding schedules.

- Does and bucks pages.

- A feed store selling livestock feed, supplements, minerals, fertilizer, and garden products.

- A regional identity focused on North Idaho and surrounding areas. [[alittlehillfarm.com]](https://alittlehillfarm.com)

Your historical [Final - Orders.pdf](https://onedrive.live.com/?id=1024fafd-22fd-201b-809a-e05e0b000000&cid=9a1b22fd1024fafd&web=1&EntityRepresentationId=219e90d9-60a6-4371-a42c-43f9c94776db) also suggests that the store is strongly local, frequently supports pickup or pallet-order workflows, currently charges Idaho’s 6% sales tax on taxable orders, and occasionally handles much larger special orders alongside ordinary retail purchases. [[Final - Orders | PDF]](https://onedrive.live.com/?id=1024fafd-22fd-201b-809a-e05e0b000000&cid=9a1b22fd1024fafd&web=1)

That combination favors a **local-order request and payment approval workflow**, rather than a high-volume, instant-fulfillment ecommerce model.

# The payment design I recommend
## 1. Separate authorization from capture
At checkout, your payment provider should:

1. Validate the card.

2. Place a temporary authorization hold.

3. Create the order as Awaiting review.

4. Notify you.

5. Let you either:

  - approve and capture the payment, or

  - reject and cancel the authorization.

With Stripe, this is done with a PaymentIntent using manual capture. The authorization reserves the funds, but they are not transferred until you capture them. If the authorization expires, the held funds are released and the payment is canceled. [[docs.stripe.com]](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)

This directly addresses the refund-fee problem. Stripe says a payment canceled before completion costs nothing, while processing fees from an already completed transaction are not returned when it is refunded. [[docs.stripe.com]](https://docs.stripe.com/refunds), [[support.stripe.com]](https://support.stripe.com/questions/understanding-fees-for-refunded-payments)
### Important limitation
You cannot leave an authorization open indefinitely. For ordinary online card transactions, the authorization window is generally five to seven days depending on the card network and transaction classification. Your application should display a prominent capture deadline and automatically cancel orders you do not review. [[docs.stripe.com]](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)

For your business, that seems workable if you normally approve or decline an order within one or two business days.

## 2. Never handle raw card numbers
The storefront should use Stripe Payment Element, Stripe Checkout, or Square Web Payments SDK. The browser sends card information directly to the payment provider, and your server receives a token or payment-intent identifier.

My recommendation is Stripe Payment Element because it provides the control you need for manual capture while keeping the card-entry UI provider-hosted.

Your application should store only:

- Provider payment ID

- Order amount

- Payment state

- Card brand and last four digits, if returned

- Risk result

- Billing and shipping address

- Capture deadline

It should not log card data, CVC values, or payment-element request bodies.

## 3. Add a hard geographic allowlist
Do not rely solely on IP geolocation. It is too easy to bypass and can block legitimate customers.

Use three controls:

1. **Shipping state allowlist** Permit only the states you explicitly serve, perhaps Idaho, Washington, Oregon, Montana, Wyoming, Utah, and Nevada, depending on your business decision.

2. **Billing-country restriction** Accept only US-issued checkout addresses unless you identify a reason not to.

3. **Server-side validation** Revalidate the state after checkout submission. Do not trust a disabled dropdown or browser-side JavaScript.

For pickup orders, I would still require a valid billing address but mark fulfillment as pickup at your farm.

WooCommerce can implement this using shipping zones. Customers see shipping methods only for the first zone matching their address, and addresses outside configured areas can be left without any available shipping method. [[woocommerce.com]](https://woocommerce.com/document/setting-up-shipping-zones/)

A custom store can implement the same rule with a small server-side list:

| 1     `{`2     `    ``"allowedShippingStates"``: [``"ID"`` ,  ``"WA"`` ,  ``"OR"`` ,  ``"MT"``],`3     `    ``"pickupAvailable"`` :  ``true``,`4     `    ``"manualCapture"`` :  ``true``,`5     `    ``"maximumOrderAmount"`` :  ``1500`6     `}` |
| --- |
I would make this configurable instead of compiling it into the application.

# Fraud controls appropriate to your volume
Manual approval helps, but it does not eliminate disputes after capture. A stolen card can authorize successfully. The objective is to collect enough evidence to make an informed decision before capturing.
## Recommended baseline
For every order:

- Require CVC.

- Require the complete billing address and postal code.

- Collect a real shipping address even if billing and shipping match.

- Verify that the shipping state is allowed.

- Record the customer’s email and telephone number.

- Rate-limit checkout attempts by IP address and session.

- Limit the number of declined cards per session.

- Use CAPTCHA or a challenge after suspicious behavior, not necessarily on every initial page.

- Reject obviously disposable or malformed customer information.

- Do not permit a customer to alter the amount sent to the payment provider.

- Calculate product prices, tax, shipping, and total exclusively on the server.

- Sign and verify all payment-provider webhooks.

- Require a successful webhook before changing an order to paid.

- Use idempotency keys so retries cannot create duplicate authorizations.

Stripe Radar Lite is included with standard payment pricing and provides AI-based card-fraud and card-testing protection. More configurable rules, risk tolerances, and manual-review features belong to higher Radar plans. [[stripe.com]](https://stripe.com/radar/pricing), [[docs.stripe.com]](https://docs.stripe.com/radar/how-radar-works)

For your low volume, I would begin with included protection plus your own manual review. I would not immediately buy an advanced fraud subscription.
## Manual review screen
The approval page should show:

- Name, email, and phone

- Billing versus shipping address

- Distance from your service area

- Product quantities and order total

- Provider risk level

- Address and CVC results

- Number of recent attempts from the same email, IP, or phone

- New versus previously approved customer

- Authorization expiration time

- Capture, Cancel, and Contact customer actions

For unusually large orders, call or email the customer before capture. Your previous records include orders ranging from normal feed purchases to substantial pallet-sized transactions, so a configurable high-value threshold would be useful. [[Final - Orders | PDF]](https://onedrive.live.com/?id=1024fafd-22fd-201b-809a-e05e0b000000&cid=9a1b22fd1024fafd&web=1)

# Payment-provider choices
## Option A: Stripe, my preferred choice
Stripe standard US pricing is currently 2.9% plus $0.30 per successful domestic-card transaction, with no setup or monthly fee under standard pricing. [[stripe.com]](https://stripe.com/pricing)

**Why it fits**

- Proper manual authorization and capture.

- No monthly payment-processing subscription.

- Excellent SDKs and webhook support.

- Provider-hosted card components.

- Included basic fraud protection.

- Good integration choices for both custom stores and WooCommerce.

**Caveats**

- Most online authorizations must be reviewed promptly.

- Custom geographic Radar rules require a paid Radar tier, so state validation should primarily live in your store.

- You remain responsible for the legitimacy of orders and for disputes after capture.
## Option B: Square
Square also supports delayed capture. Its API can create an approved payment with autocomplete: false, then either complete or cancel it. [[developer....uareup.com]](https://developer.squareup.com/docs/payments-api/take-payments/card-payments/delayed-capture)

The published Square Free plan charges 3.3% plus $0.30 for its standard online channel, while Online API payments are shown at 2.9% plus $0.30. The Free plan itself is $0 per month. [[squareup.com]](https://squareup.com/us/en/payments/our-fees)

**Why you might choose it**

- You already use or want Square for farm pickup or in-person sales.

- One provider would cover both the website and card-present purchases.

- Delayed capture is supported by its Payments API.

**Why it is my second choice**

- A custom integration is still required for the exact workflow.

- Stripe has a clearer path for a minimal web-only implementation and broader documentation around authorization windows and fraud controls.
## Providers I would not prioritize
- **Authorize.Net:** Commonly carries a monthly gateway charge, which conflicts with the objective.

- **PayPal-only checkout:** Useful as an optional method, but it does not give you the same clean, consistent authorization-review workflow for all buyers.

- **Manual card entry later:** This increases risk and usually costs more. It also creates avoidable handling and compliance concerns.

- **ACH as the only option:** Its settlement and fraud characteristics are different, and Stripe does not support separate authorization and capture for ACH in the same way as cards. [[docs.stripe.com]](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)

# Store-platform options
## Option 1: Custom lightweight storefront, best long-term fit
### Suggested architecture
- ASP.NET Core 8, Node.js, or another stack you already maintain comfortably

- Server-rendered pages or a small frontend

- Product data in JSON, YAML, or SQLite

- Server-side cart stored in an encrypted session cookie or SQLite

- Stripe Payment Element

- Manual-capture PaymentIntents

- Provider webhooks

- Small password-protected order-review page

- Email notifications

- Container image deployed to Azure App Service
### Data model
You need only a few entities:

| 1     `Product`2     `  id, sku, name, description, price, taxable, active, image, category`3     4     `Order`5     `  id, created_at, status, customer, addresses, totals,`6     `  payment_intent_id, risk_summary, capture_deadline`7     8     `OrderLine`9     `  order_id, product_id, sku_snapshot, description_snapshot,`10     `  unit_price, quantity, tax`11     12     `OrderEvent`13     `  order_id, timestamp, event_type, actor, provider_event_id` |
| --- |
For 20 to 40 slowly changing products, SQLite is preferable to MySQL unless you already operate MySQL at no incremental cost. JSON is adequate for the catalog, but orders should be held in a transactional data store.
### Advantages
- Smallest attack surface.

- No plugin ecosystem.

- Exact workflow you want.

- Easy container deployment.

- You can preserve the farm-content portion of the site without forcing it into an ecommerce platform.

- Straightforward backup and source-control story.
### Disadvantages
- You own application security and patching.

- You must correctly implement webhooks, idempotency, authorization expiration, taxes, and order-state transitions.

- Building an adequate administrative UI takes some initial work.

Given your technical background, this is realistic, but it should be treated as a real production payment application rather than a weekend form with a credit-card field.

## Option 2: WooCommerce plus official Stripe extension, fastest path
The official extension supports “authorize now, capture later.” Authorized orders are placed on hold, and you can capture through the order screen or the Stripe dashboard. Its documentation warns that authorization normally must be captured within seven days and that only one capture is available under this workflow. [[woocommerce.com]](https://woocommerce.com/document/stripe/admin-experience/authorize-and-capture/)
### Advantages
- Product, cart, tax, shipping, order, email, and administrative interfaces already exist.

- Manual capture is documented.

- Shipping zones can restrict where checkout is available.

- Easier for a nondeveloper to edit products.
### Disadvantages
- Far more PHP and database code exposed to the internet.

- Regular updates for WordPress, themes, and plugins.

- Plugin conflicts and security advisories become an operational responsibility.

- Overkill for 20 to 40 stable products.

- Running WordPress and MySQL cleanly can add hosting or database expense.

I would choose this if the most important criterion is migrating quickly without writing an order-administration system.

## Option 3: Medusa, capable but oversized
Medusa is an open-source commerce backend with product, cart, fulfillment, inventory, pricing, order, tax, and regional modules. [[medusajs.com]](https://medusajs.com/), [[docs.medusajs.com]](https://docs.medusajs.com/resources/commerce-modules)

Its Stripe provider supports the payment lifecycle, including authorization, capture, and refunds. Automatic capture is configurable and defaults to false in the documented provider configuration. [[docs.medusajs.com]](https://docs.medusajs.com/resources/commerce-modules/payment/payment-provider/stripe)
### Advantages
- TypeScript and API-first architecture.

- Good if you expect substantial future custom development.

- Manual capture aligns with your workflow.

- Admin UI and commerce concepts are already available.
### Disadvantages
- Significantly more moving parts than your sales volume requires.

- Backend, database, admin, storefront, jobs, and webhooks all require deployment and monitoring.

- Higher operational complexity than a purpose-built application.

I would keep this as a future option if the farm store expands materially, not as the first choice today.

## Option 4: Vendure, also oversized
Vendure is another self-hostable TypeScript commerce system. It supports SQLite for testing or MySQL, MariaDB, and PostgreSQL for deployed configurations, and its standard project includes an administrative dashboard. [[docs.vendure.io]](https://docs.vendure.io/current/core/getting-started/installation.md)

Its community Stripe plugin uses Payment Intents and accepts additional PaymentIntent creation parameters, which could be used to customize capture behavior. [[docs.vendure.io]](https://docs.vendure.io/current/community-plugins/stripe-plugin), [[docs.vendure.io]](https://docs.vendure.io/current/community-plugins/stripe-plugin/stripe-plugin-options)

It is a good engineering platform, but I see no advantage over a small custom application for this store.

# Azure considerations
Azure App Service supports custom container deployment. Microsoft recommends using managed identity when pulling images from Azure Container Registry. [[learn.microsoft.com]](https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container)

Apps placed in the same paid App Service plan share that plan’s compute resources. Therefore, adding this store to your existing compatible plan may not add another App Service compute charge, although resource usage still needs monitoring. [[learn.microsoft.com]](https://learn.microsoft.com/en-us/azure/app-service/overview-hosting-plans)

However, “essentially free” depends on avoiding additional paid dependencies:

- Separate managed MySQL

- New storage account

- Container Registry charges

- Log Analytics ingestion

- Backup storage

- Key Vault transactions at meaningful scale

- Another App Service plan because of an OS or region mismatch

Microsoft notes that related resources, storage, logging, and backup services can create separate charges. [[learn.microsoft.com]](https://learn.microsoft.com/en-us/azure/app-service/overview-manage-costs)
### My Azure deployment preference
- Reuse the existing paid App Service plan if OS and region are compatible.

- Create a separate Web App in that plan.

- Deploy one Linux container.

- Start with a small persistent SQLite database plus automated off-instance backups.

- Keep product images in the application image or inexpensive object storage.

- Store secrets in App Service application settings or Key Vault.

- Use GitHub Actions or Azure DevOps for deployment.

- Put the direct App Service hostname behind an access restriction if your DNS/proxy design permits.

- Enable automatic HTTPS and HSTS in the application.

If you mount an Azure Files share for persistence, remember that Azure Storage is separately billed and mounted storage is not automatically included in App Service backups. [[learn.microsoft.com]](https://learn.microsoft.com/en-us/azure/app-service/configure-connect-to-azure-storage)

# Taxes and records
Idaho’s general sales and use tax rate is 6%, and most retailers selling taxable goods in Idaho must have a seller’s permit, collect sales tax, file returns, and forward the tax collected. [[tax.idaho.gov]](https://tax.idaho.gov/taxes/sales-use/online-guide/)

The Idaho State Tax Commission also requires retailers to retain supporting sales records and says delivery-location evidence should be retained when products are delivered somewhere other than the retailer’s place of business. [[tax.idaho.gov]](https://tax.idaho.gov/taxes/sales-use/guides-for-certain-groups/retailers/online-guide/)

Your replacement should therefore preserve:

- Gross sale

- Discounts

- Shipping

- Taxable subtotal

- Tax charged

- Exemption status and documentation

- Delivery or pickup location

- Capture and cancellation records

- Refunds

- An immutable price and description snapshot for every order line

Limiting sales to nearby states reduces operational scope, but it does not automatically eliminate tax obligations outside Idaho. Before enabling another state, review that state’s nexus, product-exemption, feed, fertilizer, and agricultural-use rules. This portion is worth confirming with your tax professional.

# Recommended implementation plan
## Phase 1: Reduce risk before replacing anything
1. Export products, customers, orders, redirects, and images from Shopify.

2. Identify the 20 to 40 products to retain.

3. Define the precise list of allowed shipping states and pickup ZIP codes.

4. Decide whether large pallet orders should be paid online or converted into manually issued invoices.

5. Open and verify a Stripe test account workflow.

6. Run test authorizations, captures, cancellations, expired authorizations, declines, and webhook retries.
## Phase 2: Build the minimum store
1. Farm-content pages.

2. Product listing and details.

3. Server-side cart.

4. Address collection.

5. Shipping-state validation.

6. Idaho tax calculation.

7. Payment authorization.

8. Order-review UI.

9. Capture and cancel actions.

10. Transactional email.

11. Audit log.

12. CSV order export.
## Phase 3: Fraud hardening
1. Add rate limits.

2. Add bot and card-testing detection.

3. Enforce CVC and address collection.

4. Flag mismatched billing and shipping states.

5. Require telephone confirmation above a configurable threshold.

6. Add an approved-customer list, but never bypass provider authorization.

7. Add alerts for repeated payment attempts.

8. Test webhook spoofing and replay protection.
## Phase 4: Cutover
1. Put the new site on a staging hostname.

2. Compare totals and taxes against Shopify.

3. Run a real low-dollar transaction.

4. Capture it.

5. Run another real transaction and cancel it before capture.

6. Confirm accounting, email, and bank reporting.

7. Configure redirects from old product and collection URLs.

8. Lower DNS TTL.

9. Cut over the domain.

10. Keep the old store inaccessible to buyers but available for administrative reference until the export and reconciliation are verified.

# Final ranking


| Rank | Approach | Fit | Estimated ongoing platform cost | Operational burden |
| --- | --- | --- | --- | --- |
| 1 | Custom lightweight store plus Stripe | Excellent | Near $0 beyond transactions if your existing Azure capacity suffices | Moderate |
| 2 | WooCommerce plus official Stripe extension | Very good | Hosting plus transactions | Moderate to high |
| 3 | Custom store plus Square | Good | Near $0 beyond transactions | Moderate |
| 4 | Medusa | Technically strong, oversized | Infrastructure plus transactions | High |
| 5 | Vendure | Technically strong, oversized | Infrastructure plus transactions | High |
**My decision:** build the custom lightweight version, use Stripe manual capture, keep the catalog in JSON and orders in SQLite, and design checkout around **local pickup or a small state allowlist**. If development time becomes the blocker, use WooCommerce as the fallback rather than adopting a more elaborate headless-commerce system.
