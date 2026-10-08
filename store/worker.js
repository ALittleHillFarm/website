/**
 * A Little Hill Farm — store
 *
 * One file. Zero dependencies. Talks to Stripe over plain fetch().
 *
 * Design rules, in order of importance:
 *   1. The server prices everything. A price from the browser is never trusted.
 *   2. Stripe owns card payment state. We do not build an order state machine.
 *   3. The ledger owns the books — every sale, every channel, cash included.
 *   4. All money is integer cents. Never floats.
 *
 * Bindings (wrangler.toml):
 *   DB                     D1 database
 *   ASSETS                 static storefront files
 *   STRIPE_SECRET_KEY      secret
 *   STRIPE_WEBHOOK_SECRET  secret
 *   ADMIN_EMAILS           secret — who may use /admin once signed in
 *   ADMIN_PASSWORD         secret — emergency admin login only (/admin?password)
 *   NOTIFY_URL             secret, optional — where alerts go (see Alerts)
 *   SESSION_SECRET         secret — signs customer sign-in cookies (see sign-in)
 *   RESEND_API_KEY         secret, optional — sends sign-in codes and order emails
 *   GOOGLE_CLIENT_ID/SECRET  secrets, optional — "Sign in with Google"
 *   MEDIA                  R2 bucket of uploaded photos
 */

import catalog from './products.json';
import config from './config.json';

const STRIPE = 'https://api.stripe.com/v1';

/** The short order number shown everywhere: emails, admin, account page, Stripe. */
const orderRef = (saleId) => String(saleId).slice(0, 8);

const pickupLabel = (id) =>
  (config.pickup_locations.find((l) => l.id === String(id || '').replace(/^pickup:/, '')) || {}).label || String(id || '');

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;

    try {
      if (path === '/api/me' || path.startsWith('/api/auth/') || path.startsWith('/auth/google')) {
        const res = await authRoutes(path, request, env);
        if (res) return res;
      }
      if (path === '/api/config') return apiConfig(env);
      if (path === '/api/invoice') return apiInvoice(request, env);
      if (path === '/api/invoice/pay' && request.method === 'POST') return apiInvoicePay(request, env);
      if (path === '/api/catalog') return apiCatalog(env);
      if (path === '/api/quote' && request.method === 'POST') return apiQuote(request, env);
      if (path === '/api/checkout' && request.method === 'POST') return apiCheckout(request, env, ctx);
      if (path === '/api/webhook' && request.method === 'POST') return apiWebhook(request, env, ctx);
      if (path.startsWith('/media/')) return serveMedia(path, env);
      if (path === '/product') return productPage(request, env);
      if (path === '/sitemap.xml') return sitemap(request, env);
      if (path === '/robots.txt') return robots(request);

      if (path === '/admin' || path.startsWith('/api/admin/')) {
        const denied = await requireAdmin(request, env, path);
        if (denied) return denied;
        return adminRoutes(path, request, env);
      }

      // Anything else is a static asset (the storefront).
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err && err.stack ? err.stack : String(err));
      return json({ error: 'internal_error' }, 500);
    }
  },

  // Cron triggers (wrangler.toml): site checks and the morning digest.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(event, env));
  },
};

// ---------------------------------------------------------------------------
// Catalog + config (public)
// ---------------------------------------------------------------------------

/**
 * The catalog, from the `products` table (D1 is the source of truth, edited in
 * the admin Products tab). The first time it is read empty, it is seeded once
 * from products.json merged with the old product_settings overlay. If the table
 * cannot be read at all, fall back to that same merge so the storefront never
 * goes down. products.json is now only the seed snapshot and the fallback.
 */
async function loadCatalog(env) {
  try {
    let rows = (await env.DB.prepare('SELECT id, data FROM products ORDER BY sort, rowid').all()).results || [];
    if (!rows.length) {
      await seedProducts(env);
      rows = (await env.DB.prepare('SELECT id, data FROM products ORDER BY sort, rowid').all()).results || [];
    }
    if (rows.length) return rows.map((r) => ({ ...JSON.parse(r.data), id: r.id }));
  } catch (err) {
    // A products-table problem must not take the storefront down. The committed
    // catalog is always a safe, known-good state.
    console.error('products table unavailable, using products.json: ' + err);
  }
  return legacyCatalog(env);
}

/** products.json with the old product_settings overlay applied: the seed, and the fallback. */
async function legacyCatalog(env) {
  let overrides = new Map();
  try {
    const rows = (await env.DB.prepare('SELECT * FROM product_settings').all()).results || [];
    overrides = new Map(rows.map((r) => [r.product_id, r]));
  } catch (err) {
    console.error('product_settings unavailable, using products.json alone: ' + err);
  }
  return catalog.products.map((p) => {
    const o = overrides.get(p.id);
    const merged = !o ? { ...p } : {
      ...p,
      active: o.active == null ? p.active : !!o.active,
      image: o.image || p.image,
      price_cents: o.price_cents == null ? p.price_cents : o.price_cents,
      cost_cents: o.cost_cents == null ? p.cost_cents : o.cost_cents,
      freight_cents: o.freight_cents == null ? p.freight_cents : o.freight_cents,
      note: o.note || null,
    };
    if (merged.weight_lbs == null) merged.weight_lbs = weightFromUnit(merged.unit);
    return merged;
  });
}

/** "40 lbs" -> 40, "1000 lb tote" -> 1000, "2,000 lbs" -> 2000, "12 oz" -> 0.75.
 *  null when the size says nothing about weight ("1 quart", "9\""). */
function weightFromUnit(unit) {
  const m = String(unit || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(lbs?|pounds?|oz|ounces?)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]) * (/^o/i.test(m[2]) ? 1 / 16 : 1);
  return Math.round(n * 100) / 100;
}

let seeding = null;
/** Fill an empty products table from the legacy catalog. INSERT OR IGNORE, so
 *  two requests racing to seed cannot collide or overwrite an edit. */
function seedProducts(env) {
  if (!seeding) {
    seeding = (async () => {
      const list = await legacyCatalog(env);
      const now = new Date().toISOString();
      const stmts = list.map((p, i) => {
        const { id, ...data } = p;
        return env.DB.prepare('INSERT OR IGNORE INTO products (id, data, sort, created_at, updated_at) VALUES (?,?,?,?,?)')
          .bind(id, JSON.stringify(data), (i + 1) * 10, now, now);
      });
      for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
    })().finally(() => { seeding = null; });
  }
  return seeding;
}

const activeFrom = (products) => products.filter((p) => p.active);

function apiConfig(env) {
  return json({
    sign_in: authMethods(env),
    pickup_locations: config.pickup_locations
      .filter((l) => l.active)
      .map(({ id, label }) => ({ id, label })),
    terms: { version: config.terms.version, text: config.terms.text },
    pricing: {
      ach_discount_bps: config.pricing.ach_discount_bps,
      cash_discount_bps: config.pricing.cash_discount_bps,
    },
    cash_enabled: config.pricing.cash_on_pickup.enabled,
    shipping_enabled: config.shipping.enabled,
  });
}

/** product id -> units on hand, for every product that has at least one stock
 *  move. A product that is not in the map is untracked (milk, say). */
async function stockLevels(env) {
  try {
    const rows = (await env.DB.prepare('SELECT product_id, SUM(qty) AS on_hand FROM stock_moves GROUP BY product_id').all()).results || [];
    return new Map(rows.map((r) => [r.product_id, Number(r.on_hand) || 0]));
  } catch (err) {
    // No stock table yet, or a database hiccup: show no badges rather than fail.
    console.error('stock levels unavailable: ' + err);
    return new Map();
  }
}

/** true / false for tracked products, null for untracked. The exact count is
 *  never public. */
const inStockOf = (levels, id) => (levels.has(id) ? levels.get(id) > 0 : null);

async function apiCatalog(env) {
  const levels = await stockLevels(env);
  return json({
    products: activeFrom(await loadCatalog(env)).map((p) => ({
      id: p.id,
      name: p.name,
      supplier: p.supplier,
      unit: p.unit,
      price_cents: p.price_cents,
      category: p.category,
      description: p.description,
      image: p.image,
      // Which animals this is for, driving the quick-pick filter on the store.
      animals: p.animals || [],
      note: p.note || '',
      // Rank on the store's default "Popular" view; 0 = not in it.
      popular: p.popular || 0,
      // Stock badge: true = in stock, false = out (still orderable, arrives
      // with the next delivery), null = not tracked.
      in_stock: inStockOf(levels, p.id),
    })),
  });
}

// ---------------------------------------------------------------------------
// Search engines and link previews
// ---------------------------------------------------------------------------

/**
 * product.html fills itself in with JavaScript, which link previews and most
 * crawlers never run. So the worker stamps each product's own name, photo,
 * description and price into the page's <head> on the way out — a shared link
 * to a bag of kelp shows the kelp.
 */
async function productPage(request, env) {
  const res = await env.ASSETS.fetch(request);
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!res.ok) return res;
  const p = id && activeFrom(await loadCatalog(env)).find((x) => x.id === id);
  // No such product, or no longer for sale: the page still says so in plain
  // words, but with a real 404 so search engines drop the address instead of
  // flagging a "soft 404".
  if (!p) {
    const out = new Response(res.body, { status: 404, headers: res.headers });
    out.headers.set('x-robots-tag', 'noindex');
    return out;
  }

  const inStock = inStockOf(await stockLevels(env), p.id);
  const pageUrl = url.origin + '/product?id=' + encodeURIComponent(p.id);
  const image = p.image ? new URL(p.image, url.origin).toString() : url.origin + '/assets/og-store.jpg';
  const title = p.name + (p.unit ? ' (' + p.unit + ')' : '') + ' — A Little Hill Farm';
  const plain = String(p.description || '').replace(/\s+/g, ' ').trim();
  const desc = (plain.length > 180 ? plain.slice(0, 177).replace(/\s+\S*$/, '') + '…' : plain) ||
    p.name + ' from A Little Hill Farm. Pre-order online, pick up locally.';
  const price = (p.price_cents / 100).toFixed(2);
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    image,
    // Google wants a description on every product; some have none in the
    // catalog, so say plainly what it is.
    description: plain ||
      (p.name + (p.unit ? ', ' + p.unit : '') + (p.supplier ? ', from ' + p.supplier : '') +
        '. Pre-ordered through A Little Hill Farm and picked up locally in North Idaho.'),
    brand: p.supplier ? { '@type': 'Brand', name: p.supplier } : undefined,
    offers: {
      '@type': 'Offer',
      price,
      priceCurrency: 'USD',
      // Tracked stock decides it; a product we do not track stays a pre-order.
      availability: inStock === true ? 'https://schema.org/InStock'
        : inStock === false ? 'https://schema.org/BackOrder' : 'https://schema.org/PreOrder',
      url: pageUrl,
      seller: { '@type': 'Organization', name: 'A Little Hill Farm' },
      // Pickup only — we don't ship (policies.html#pickup).
      availableDeliveryMethod: 'https://schema.org/OnSitePickup',
      shippingDetails: {
        '@type': 'OfferShippingDetails',
        doesNotShip: true,
        shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
      },
      // The store's return policy (policies.html#returns): 10 days, in person.
      hasMerchantReturnPolicy: {
        '@type': 'MerchantReturnPolicy',
        applicableCountry: 'US',
        returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
        merchantReturnDays: 10,
        returnMethod: 'https://schema.org/ReturnInStore',
        returnFees: 'https://schema.org/FreeReturn',
        merchantReturnLink: url.origin + '/policies#returns',
      },
    },
  };

  const set = (value) => ({ element(e) { e.setAttribute('content', value); } });
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(title); } })
    .on('meta[name="description"]', set(desc))
    .on('meta[property="og:title"]', set(title))
    .on('meta[property="og:description"]', set(desc))
    .on('meta[property="og:url"]', set(pageUrl))
    .on('meta[property="og:image"]', set(image))
    .on('meta[property="og:type"]', set('product'))
    .on('link[rel="canonical"]', { element(e) { e.setAttribute('href', pageUrl); } })
    .on('head', {
      element(e) {
        e.onEndTag((end) => {
          end.before(
            '<meta property="product:price:amount" content="' + price + '">\n' +
            '<meta property="product:price:currency" content="USD">\n' +
            '<script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>\n',
            { html: true }
          );
        });
      },
    })
    .transform(res);
}

async function sitemap(request, env) {
  const origin = new URL(request.url).origin;
  const urls = [origin + '/', origin + '/policies'].concat(
    activeFrom(await loadCatalog(env)).map((p) => origin + '/product?id=' + encodeURIComponent(p.id))
  );
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => '  <url><loc>' + u.replace(/&/g, '&amp;') + '</loc></url>').join('\n') +
    '\n</urlset>\n';
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}

function robots(request) {
  const origin = new URL(request.url).origin;
  return new Response(
    'User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /checkout\nDisallow: /thanks\nDisallow: /pay\n\n' +
      'Sitemap: ' + origin + '/sitemap.xml\n',
    { headers: { 'content-type': 'text/plain; charset=utf-8' } }
  );
}

// ---------------------------------------------------------------------------
// Pricing — the single source of truth for money
// ---------------------------------------------------------------------------

class BadRequest extends Error {}

const VALID_METHODS = new Set(['card', 'ach', 'cash']);

function discountBpsFor(method) {
  if (method === 'ach') return config.pricing.ach_discount_bps;
  if (method === 'cash') return config.pricing.cash_discount_bps;
  return 0; // card pays the posted price
}

/**
 * Price a cart. A pure function of (items, method, customer) and the catalog.
 * Never reads a price from the request.
 */
function priceCart(items, method, customer, products) {
  const active = activeFrom(products);
  const findProduct = (id) => active.find((p) => p.id === id);
  const discountBps = discountBpsFor(method);
  const lines = [];
  let subtotal = 0;
  let taxableBase = 0;
  let listSubtotal = 0;
  let cogs = 0;

  for (const item of items) {
    const product = findProduct(item.id);
    if (!product) throw new BadRequest('unknown product: ' + item.id);

    const qty = Math.floor(Number(item.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > 999) {
      throw new BadRequest('bad quantity for ' + item.id);
    }

    // Discount the unit price, then multiply. Keeps per-unit display honest.
    const unit = Math.round((product.price_cents * (10000 - discountBps)) / 10000);
    const lineTotal = unit * qty;

    // Cost basis, snapshotted. Supplier costs change; this sale must keep the
    // cost it was actually sold at or COGS for a closed quarter would drift.
    const lineCogs = ((product.cost_cents || 0) + (product.freight_cents || 0)) * qty;

    listSubtotal += product.price_cents * qty;
    subtotal += lineTotal;
    cogs += lineCogs;
    if (product.taxable) taxableBase += lineTotal;

    lines.push({
      id: product.id,
      sku: product.sku,
      name: product.name,
      unit: product.unit,
      qty,
      list_price_cents: product.price_cents,
      unit_price_cents: unit,
      line_total_cents: lineTotal,
      cost_cents: product.cost_cents || 0,
      freight_cents: product.freight_cents || 0,
      line_cogs_cents: lineCogs,
      taxable: product.taxable,
    });
  }

  const taxExempt = !!(customer && customer.tax_exempt);
  const tax = taxExempt ? 0 : Math.round((taxableBase * config.tax.idaho_rate_bps) / 10000);

  return {
    lines,
    subtotal_cents: subtotal,
    discount_cents: listSubtotal - subtotal,
    tax_cents: tax,
    total_cents: subtotal + tax,
    cogs_cents: cogs,
    tax_exempt: taxExempt,
    exemption_ref: taxExempt ? customer.exemption_ref : null,
    payment_method: method,
  };
}

async function readCart(request) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    throw new BadRequest('cart is empty');
  }
  if (body.items.length > 100) throw new BadRequest('too many line items');

  const method = String(body.payment_method || 'card');
  if (!VALID_METHODS.has(method)) throw new BadRequest('bad payment method');

  return { body, method };
}

/**
 * Strip the cost basis before anything is sent to a browser. priceCart carries
 * COGS for the ledger; customers must never see what we pay our suppliers.
 */
function publicQuote(q) {
  const { cogs_cents, exemption_ref, ...rest } = q;
  return {
    ...rest,
    lines: q.lines.map(({ cost_cents, freight_cents, line_cogs_cents, ...line }) => line),
  };
}

async function apiQuote(request, env) {
  try {
    const { body, method } = await readCart(request);
    // Special terms (tax exemption) only for the signed-in customer's own email.
    const customer = await customerFor(request, env, body.email);
    return json(publicQuote(priceCart(body.items, method, customer, await loadCatalog(env))));
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

async function apiCheckout(request, env, ctx) {
  let body;
  let method;
  try {
    ({ body, method } = await readCart(request));
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }

  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  // Pickup is in person, weeks out. A phone number is how we reach someone
  // about a delayed supplier order, and it is a useful fraud-review signal.
  const phone = String(body.phone || '').trim().slice(0, 40);
  const pickup = String(body.pickup || '').trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'valid email required' }, 400);
  }
  if (!name) return json({ error: 'name required' }, 400);
  if (body.terms_ack !== true) {
    return json({ error: 'pre-order terms must be accepted' }, 400);
  }

  const pickupOk = config.pickup_locations.some((l) => l.active && l.id === pickup);
  if (!pickupOk) return json({ error: 'choose a pickup location' }, 400);

  // A customer's tax exemption and trusted status apply only when they are
  // signed in as this email. A guest who types a known customer's email is
  // treated as a new customer — before sign-in existed, typing it was enough.
  const customer = await customerFor(request, env, email);
  if (customer) {
    // Keep the details they just used, so next checkout is pre-filled.
    await env.DB.prepare('UPDATE customers SET name = ?, phone = COALESCE(?, phone) WHERE email = ?')
      .bind(name, phone || null, email).run();
  }

  let quote;
  try {
    quote = priceCart(body.items, method, customer, await loadCatalog(env));
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }

  // Cash carries no payment guarantee, and we buy stock weeks before pickup.
  if (method === 'cash') {
    if (!config.pricing.cash_on_pickup.enabled) {
      return json({ error: 'cash not available' }, 400);
    }
    if (config.pricing.cash_on_pickup.trusted_only && !(customer && customer.trusted)) {
      return json(
        { error: 'cash at pickup is available to established customers — please choose card or bank transfer' },
        400
      );
    }
  }

  const saleId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Trusted customers under the review threshold skip the hold entirely.
  const autoCapture =
    !!(customer && customer.trusted) && quote.total_cents <= config.limits.max_order_cents;

  await env.DB.prepare(
    'INSERT INTO sales (id, sold_at, channel, category, customer_email, customer_name, customer_phone,' +
      ' items_json, subtotal_cents, tax_cents, total_cents, cogs_cents, tax_exempt, exemption_ref,' +
      ' payment_method, stripe_payment_intent, status, fulfillment,' +
      ' terms_ack_version, terms_ack_at, notified_json)' +
      ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  )
    .bind(
      saleId,
      now,
      'online',
      'feed',
      email,
      name,
      phone || null,
      JSON.stringify(quote.lines),
      quote.subtotal_cents,
      quote.tax_cents,
      quote.total_cents,
      quote.cogs_cents,
      quote.tax_exempt ? 1 : 0,
      quote.exemption_ref,
      method,
      null,
      // 'recorded' would count this as revenue immediately, but cash is not in
      // hand until pickup, weeks away. It stays out of the books until collected.
      method === 'cash' ? 'awaiting_cash' : 'pending',
      'pickup:' + pickup,
      config.terms.version,
      now,
      JSON.stringify({ received: now })
    )
    .run();

  // Cash never touches Stripe, so no webhook will announce it — do it here.
  if (method === 'cash') {
    ctx.waitUntil(notifyNewOrder(env, saleId));
    ctx.waitUntil(sendOrderConfirmation(env, saleId));
    return json({ sale_id: saleId, redirect_url: null, total_cents: quote.total_cents });
  }

  const origin = new URL(request.url).origin;
  const session = await stripeCheckout(env, origin, {
    saleId, email, name, pickup, method, lines: quote.lines, taxCents: quote.tax_cents, autoCapture,
    // The cart lives on the storefront index, not a separate page.
    cancelUrl: origin + '/?cart=1',
    // The sale id, so a retry can never double-authorize.
    idempotencyKey: saleId,
  });

  return json({ sale_id: saleId, redirect_url: session.url, total_cents: quote.total_cents });
}

/**
 * Create the Stripe Checkout session for a sale. Shared by the storefront
 * checkout and by invoices, so both describe payments the same way.
 */
async function stripeCheckout(env, origin, { saleId, email, name, pickup, method, lines, taxCents, autoCapture, cancelUrl, idempotencyKey }) {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('customer_email', email);
  form.set('success_url', origin + '/thanks?sale=' + saleId);
  form.set('cancel_url', cancelUrl);
  form.set('client_reference_id', saleId);
  form.set('metadata[sale_id]', saleId);
  form.set('metadata[pickup]', pickup);
  form.set('metadata[terms_version]', config.terms.version);

  // What a person sees in the Stripe dashboard and its emails instead of a
  // bare pi_... id: the same short order number the customer and admin use,
  // who bought it, and what. Stripe caps descriptions at 1000 characters.
  const ref = orderRef(saleId);
  const itemsText = lines.map((l) => l.qty + ' × ' + l.name + (l.unit ? ' (' + l.unit + ')' : '')).join(', ');
  form.set('payment_intent_data[description]',
    ('Order ' + ref + ' · ' + name + ' · ' + itemsText).slice(0, 1000));
  form.set('payment_intent_data[metadata][order]', ref);
  form.set('payment_intent_data[metadata][customer]', name.slice(0, 500));
  form.set('payment_intent_data[metadata][items]', itemsText.slice(0, 500));
  form.set('payment_intent_data[metadata][pickup]', pickupLabel(pickup).slice(0, 500));
  form.set('payment_intent_data[metadata][sale_id]', saleId);

  if (method === 'ach') {
    // ACH cannot authorize-then-capture: it debits at checkout, with no review
    // step (DESIGN.md, "ACH notes"). Instant verification only — the customer
    // signs in to their bank. No micro-deposit fallback, which would leave the
    // order unpaid for days while two test deposits cleared.
    form.set('payment_method_types[0]', 'us_bank_account');
    form.set('payment_method_options[us_bank_account][verification_method]', 'instant');
  } else {
    form.set('payment_method_types[0]', 'card');
    if (!autoCapture) form.set('payment_intent_data[capture_method]', 'manual');
  }

  lines.forEach((line, i) => {
    form.set('line_items[' + i + '][quantity]', String(line.qty));
    form.set('line_items[' + i + '][price_data][currency]', 'usd');
    form.set('line_items[' + i + '][price_data][unit_amount]', String(line.unit_price_cents));
    form.set(
      'line_items[' + i + '][price_data][product_data][name]',
      line.unit ? line.name + ' (' + line.unit + ')' : line.name
    );
  });

  if (taxCents > 0) {
    const i = lines.length;
    form.set('line_items[' + i + '][quantity]', '1');
    form.set('line_items[' + i + '][price_data][currency]', 'usd');
    form.set('line_items[' + i + '][price_data][unit_amount]', String(taxCents));
    form.set('line_items[' + i + '][price_data][product_data][name]', 'Idaho sales tax');
  }

  const session = await stripe(env, 'POST', '/checkout/sessions', form, idempotencyKey);

  // Stripe does not create the PaymentIntent until the customer completes the
  // session, so payment_intent is usually null here. Store the session id as
  // well — before completion it is the only link back to Stripe, and it is what
  // lets us reconcile by hand if a webhook is ever missed.
  await env.DB.prepare('UPDATE sales SET stripe_session_id = ?, stripe_payment_intent = ? WHERE id = ?')
    .bind(session.id || null, session.payment_intent || null, saleId)
    .run();
  return session;
}

// ---------------------------------------------------------------------------
// Stripe transport
// ---------------------------------------------------------------------------

async function stripe(env, method, path, form, idempotencyKey) {
  const headers = {
    authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const res = await fetch(STRIPE + path, {
    method,
    headers,
    body: form ? form.toString() : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'stripe error';
    throw new Error('Stripe ' + path + ': ' + msg);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Webhook — signature verified by hand, no SDK
// ---------------------------------------------------------------------------

async function apiWebhook(request, env, ctx) {
  const sig = request.headers.get('stripe-signature') || '';
  const raw = await request.text();

  if (!(await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'bad signature' }, 400);
  }

  const event = JSON.parse(raw);

  // Stripe redelivers. A unique constraint makes reprocessing a harmless no-op.
  const seen = await env.DB.prepare(
    'INSERT OR IGNORE INTO webhook_events (id, type, received_at) VALUES (?,?,?)'
  )
    .bind(event.id, event.type, new Date().toISOString())
    .run();

  if (seen.meta && seen.meta.changes === 0) {
    return json({ received: true, duplicate: true });
  }

  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const saleId = obj.client_reference_id || (obj.metadata && obj.metadata.sale_id);
      if (saleId) {
        // 'paid' means it settled. Otherwise a card is being HELD (authorized,
        // ours to capture) while a bank transfer is PROCESSING — the debit is
        // already on its way and settles in a few business days, or fails.
        const isBank = (obj.payment_method_types || []).includes('us_bank_account');
        const status = obj.payment_status === 'paid' ? 'captured' : isBank ? 'processing' : 'authorized';
        const done = await env.DB.prepare(
          "UPDATE sales SET status = ?," +
            ' stripe_payment_intent = COALESCE(?, stripe_payment_intent)' +
            " WHERE id = ? AND status IN ('pending','invoiced')"
        )
          .bind(status, obj.payment_intent || null, saleId)
          .run();
        // Only the first completion of a pending sale is a new order.
        if (done.meta && done.meta.changes) {
          await settleInvoiceMethod(env, saleId, obj.payment_method_types);
          // Paid already (an automatic-capture card). A held card or a bank
          // transfer in flight is stocked later, when it actually settles.
          if (status === 'captured') await recordSaleMoves(env, saleId);
          ctx.waitUntil(notifyNewOrder(env, saleId));
          ctx.waitUntil(sendOrderConfirmation(env, saleId));
        }
      }
      break;
    }

    case 'payment_intent.amount_capturable_updated':
      await setStatusByIntent(env, obj.id, 'authorized');
      break;

    // Card captured, or a bank transfer settled.
    case 'payment_intent.succeeded':
      await setStatusByIntent(env, obj.id, 'captured');
      await recordSaleMovesForIntent(env, obj.id);
      break;

    // A bank transfer bounced (closed account, insufficient funds...). Only
    // bank payments land here: a declined card never completes checkout.
    case 'payment_intent.payment_failed': {
      const r = await env.DB.prepare("UPDATE sales SET status = 'failed' WHERE stripe_payment_intent = ? AND status = 'processing'")
        .bind(obj.id).run();
      if (r.meta && r.meta.changes) {
        ctx.waitUntil(notify(env, {
          title: 'Bank payment failed',
          message: 'A ' + dollars(obj.amount) + ' bank transfer did not go through. Contact the customer before ordering their items.',
          priority: 4,
          tags: 'warning',
          click: adminUrl(),
        }));
      }
      break;
    }

    // The authorization-expiry case. Without this, the admin list would keep
    // showing a hold the bank has already released.
    case 'payment_intent.canceled':
      await setStatusByIntent(env, obj.id, 'canceled');
      break;

    // Customer abandoned Stripe Checkout. Without this, the row sits in
    // 'pending' forever and clutters the admin list.
    case 'checkout.session.expired': {
      const saleId = obj.client_reference_id || (obj.metadata && obj.metadata.sale_id);
      if (saleId) {
        await env.DB.prepare("UPDATE sales SET status = 'abandoned' WHERE id = ? AND status = 'pending'")
          .bind(saleId)
          .run();
      }
      break;
    }

    // A refund - from the admin's Refund button or straight from the Stripe
    // dashboard. amount_refunded is the running total, so replays and
    // several partial refunds all land correctly.
    case 'charge.refunded':
      if (obj.payment_intent) {
        await env.DB.prepare(
          'UPDATE sales SET refunded_cents = ?, refunded_at = ?,' +
            " status = CASE WHEN ? >= total_cents THEN 'refunded' ELSE status END" +
            ' WHERE stripe_payment_intent = ? AND refunded_cents < ?'
        ).bind(obj.amount_refunded, new Date().toISOString(), obj.amount_refunded, obj.payment_intent, obj.amount_refunded).run();
      }
      break;

    case 'charge.dispute.created':
      await env.DB.prepare(
        "UPDATE sales SET notes = COALESCE(notes,'') || ' [DISPUTE OPENED ' || ? || ']'" +
          ' WHERE stripe_payment_intent = ?'
      )
        .bind(new Date().toISOString(), obj.payment_intent)
        .run();
      ctx.waitUntil(notify(env, {
        title: 'Payment dispute opened',
        message: 'A customer disputed a ' + dollars(obj.amount) + ' payment. Respond in the Stripe dashboard before the deadline.',
        priority: 5,
        tags: 'warning',
        click: 'https://dashboard.stripe.com/disputes',
      }));
      break;
  }

  return json({ received: true });
}

const setStatusByIntent = (env, intentId, status) =>
  env.DB.prepare('UPDATE sales SET status = ? WHERE stripe_payment_intent = ?')
    .bind(status, intentId)
    .run();

/**
 * Stripe signs "{timestamp}.{raw body}" with HMAC-SHA256.
 * Reject anything older than five minutes to blunt replay.
 */
async function verifyStripeSignature(raw, header, secret) {
  if (!secret || !header) return false;

  let timestamp = null;
  const provided = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = v;
    if (k === 'v1') provided.push(v);
  }
  if (!timestamp || provided.length === 0) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + '.' + raw));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return provided.some((p) => timingSafeEqual(p, expected));
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const getCustomer = (env, email) =>
  env.DB.prepare('SELECT * FROM customers WHERE email = ?')
    .bind(String(email).trim().toLowerCase())
    .first();

// ---------------------------------------------------------------------------
// Uploaded media (R2)
// ---------------------------------------------------------------------------

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Identify an image from its leading bytes. The browser's Content-Type header
 * is a claim, not evidence — anything can be sent with any header. Only these
 * four types are ever stored, and the type we detect is the type we serve,
 * so a file cannot be uploaded as an image and served as something executable.
 */
function sniffImage(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
  const ascii = String.fromCharCode(b[0], b[1], b[2], b[3], b[8], b[9], b[10], b[11]);
  if (ascii === 'RIFFWEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

async function serveMedia(path, env) {
  // Only ever look up the final path segment, so no amount of ../ in the URL
  // can reach outside the uploads prefix.
  const name = path.split('/').filter(Boolean).pop() || '';
  if (!/^[a-f0-9-]{8,}\.(jpg|png|gif|webp)$/.test(name)) return new Response('Not found', { status: 404 });

  const obj = await env.MEDIA.get('uploads/' + name);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  headers.set('content-type', obj.httpMetadata?.contentType || 'application/octet-stream');
  // Keys are random and content never changes under a key, so cache hard.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', "default-src 'none'; sandbox");
  return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------------------
// Customer sign-in and email
//
// Two ways in, both passwordless:
//   - a six-digit code emailed to the customer (needs RESEND_API_KEY)
//   - Sign in with Google (needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)
// Either one needs SESSION_SECRET, which signs the session cookie. With no
// SESSION_SECRET the Log in link simply doesn't appear.
//
// Signing in is optional — guests can always check out. What it changes:
// a customer's tax exemption and "trusted" status (cash at pickup, no hold
// on the card) apply ONLY when they are signed in as that email. Before
// sign-in existed, typing someone else's email at checkout was enough.
//
// The session is a signed cookie (email + expiry, HMAC-SHA256), so there is
// no session table to clean up. Login codes live in login_codes, hashed.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'alhf_session';
const SESSION_DAYS = 60;
const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

function authMethods(env) {
  const on = !!env.SESSION_SECRET;
  return {
    email: on && (!!env.RESEND_API_KEY || env.DEV_EMAIL_LOG === '1'),
    google: on && !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
  };
}

function readCookie(request, name) {
  const all = request.headers.get('cookie') || '';
  const m = all.split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}

function cookieHeader(name, value, maxAgeSeconds) {
  return name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAgeSeconds;
}

async function makeSession(env, email) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    e: email, x: Date.now() + SESSION_DAYS * 24 * 3600 * 1000,
  })));
  return payload + '.' + (await hmac(env.SESSION_SECRET, payload));
}

/** The signed-in email, or '' for a guest. Never throws. */
async function sessionEmail(request, env) {
  if (!env.SESSION_SECRET) return '';
  const raw = readCookie(request, SESSION_COOKIE);
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return '';
  const payload = raw.slice(0, dot);
  if (!timingSafeEqual(raw.slice(dot + 1), await hmac(env.SESSION_SECRET, payload))) return '';
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return s && s.x > Date.now() && typeof s.e === 'string' ? s.e : '';
  } catch {
    return '';
  }
}

/** The customer record whose special terms apply to this request: only the
 *  signed-in customer's, and only when the order is in their own email. */
async function customerFor(request, env, email) {
  const who = await sessionEmail(request, env);
  if (!who || !email || who !== String(email).trim().toLowerCase()) return null;
  return getCustomer(env, who);
}

function signedInResponse(res, cookieValue) {
  const out = new Response(res.body, res);
  out.headers.append('set-cookie', cookieHeader(SESSION_COOKIE, cookieValue, SESSION_DAYS * 24 * 3600));
  out.headers.set('cache-control', 'no-store');
  return out;
}

const cleanEmail = (v) => {
  const e = String(v || '').trim().toLowerCase().slice(0, 254);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
};

/** Ensure a customers row exists for someone who has signed in, so the admin
 *  can later mark them trusted or tax-exempt. Never downgrades a record. */
async function rememberCustomer(env, email, name) {
  await env.DB.prepare(
    'INSERT INTO customers (email, name, created_at) VALUES (?,?,?)' +
      ' ON CONFLICT(email) DO UPDATE SET name = COALESCE(customers.name, excluded.name)'
  ).bind(email, name || null, new Date().toISOString()).run();
}

async function authRoutes(path, request, env) {
  const methods = authMethods(env);

  if (path === '/api/me') {
    const email = await sessionEmail(request, env);
    if (!email) return json({ signed_in: false, methods }, 200);
    const c = (await getCustomer(env, email)) || {};
    const orders = (await env.DB.prepare(
      "SELECT id, sold_at, status, payment_method, total_cents, items_json, fulfillment FROM sales" +
        " WHERE customer_email = ? AND status NOT IN ('pending','abandoned') ORDER BY sold_at DESC LIMIT 50"
    ).bind(email).all()).results || [];
    const res = json({
      signed_in: true,
      methods,
      email,
      is_admin: adminEmails(env).includes(email),
      name: c.name || '',
      phone: c.phone || '',
      tax_exempt: !!c.tax_exempt,
      trusted: !!c.trusted,
      orders: orders.map((o) => ({
        id: o.id, sold_at: o.sold_at, status: o.status, payment_method: o.payment_method,
        total_cents: o.total_cents, pickup: String(o.fulfillment || '').replace(/^pickup:/, ''),
        items: JSON.parse(o.items_json || '[]').map((l) => ({ name: l.name, unit: l.unit, qty: l.qty })),
      })),
    });
    res.headers.set('cache-control', 'no-store');
    return res;
  }

  if (path === '/api/auth/logout' && request.method === 'POST') {
    const res = json({ ok: true });
    res.headers.append('set-cookie', cookieHeader(SESSION_COOKIE, '', 0));
    return res;
  }

  // ---- emailed code -------------------------------------------------------
  if (path === '/api/auth/code' && request.method === 'POST') {
    if (!methods.email) return json({ error: 'email sign-in is not available' }, 400);
    const b = await request.json().catch(() => ({}));
    const email = cleanEmail(b.email);
    if (!email) return json({ error: 'enter a valid email address' }, 400);

    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?')
      .bind(email, since).first();
    if (recent && recent.n >= CODES_PER_HOUR) {
      return json({ error: 'Too many codes requested. Wait a while, then try again.' }, 429);
    }

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    await env.DB.prepare(
      'INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?,?,?,0,?)'
    ).bind(email, await hmac(env.SESSION_SECRET, email + ':' + code),
      new Date(Date.now() + CODE_MINUTES * 60 * 1000).toISOString(), new Date().toISOString()).run();

    const sent = await sendEmail(env, {
      to: email,
      subject: 'Your sign-in code: ' + code,
      text: 'Your A Little Hill Farm sign-in code is ' + code + '.\n\nIt works for ' + CODE_MINUTES +
        ' minutes. If you did not ask for it, you can ignore this email.',
      html: emailShell('<p style="margin:0 0 14px">Your sign-in code is</p>' +
        '<p style="font-size:32px;letter-spacing:6px;font-weight:600;margin:0 0 18px;color:#1E1B16">' + code + '</p>' +
        '<p style="margin:0;color:#6B6353">It works for ' + CODE_MINUTES +
        ' minutes. If you did not ask for it, you can ignore this email.</p>'),
    });
    if (!sent.sent) return json({ error: 'Could not send the email just now. Please try again in a minute.' }, 502);
    // Same answer whether or not we have seen this email before.
    return json({ ok: true });
  }

  if (path === '/api/auth/verify' && request.method === 'POST') {
    if (!methods.email) return json({ error: 'email sign-in is not available' }, 400);
    const b = await request.json().catch(() => ({}));
    const email = cleanEmail(b.email);
    const code = String(b.code || '').replace(/\D/g, '');
    const row = email && await env.DB.prepare(
      'SELECT rowid AS rid, code_hash, expires_at, attempts FROM login_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(email).first();
    const bad = json({ error: 'That code is not right, or it has expired. Ask for a new one.' }, 400);
    if (!row || code.length !== 6 || Date.parse(row.expires_at) < Date.now() || row.attempts >= CODE_ATTEMPTS) return bad;
    await env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE rowid = ?').bind(row.rid).run();
    if (!timingSafeEqual(row.code_hash, await hmac(env.SESSION_SECRET, email + ':' + code))) return bad;

    await env.DB.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();
    await rememberCustomer(env, email, null);
    return signedInResponse(json({ ok: true }), await makeSession(env, email));
  }

  // ---- Google -------------------------------------------------------------
  if (path === '/auth/google') {
    if (!methods.google) return Response.redirect(new URL('/account', request.url).toString(), 302);
    const url = new URL(request.url);
    const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
    const back = safeReturn(url.searchParams.get('return'));
    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    google.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    google.searchParams.set('redirect_uri', url.origin + '/auth/google/callback');
    google.searchParams.set('response_type', 'code');
    google.searchParams.set('scope', 'openid email profile');
    google.searchParams.set('state', state);
    google.searchParams.set('prompt', 'select_account');
    const res = new Response(null, { status: 302, headers: { location: google.toString() } });
    // Ties the callback to this browser (and remembers where to go after).
    res.headers.append('set-cookie', cookieHeader('alhf_oauth', state + '|' + back, 600));
    return res;
  }

  if (path === '/auth/google/callback') {
    const url = new URL(request.url);
    const [state, back] = readCookie(request, 'alhf_oauth').split('|');
    const fail = (why) => Response.redirect(url.origin + '/account?error=' + encodeURIComponent(why), 302);
    if (!methods.google) return fail('Google sign-in is not available');
    if (!state || url.searchParams.get('state') !== state) return fail('That sign-in link expired. Please try again.');
    if (!url.searchParams.get('code')) return fail('Google sign-in was cancelled.');

    const token = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code'),
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: url.origin + '/auth/google/callback',
        grant_type: 'authorization_code',
      }),
    }).then((r) => r.json()).catch(() => ({}));
    if (!token.id_token) return fail('Google did not confirm the sign-in. Please try again.');

    // The ID token came straight from Google's token endpoint over TLS, in
    // exchange for our client secret, so its claims can be read directly
    // (Google's documented exception to verifying the signature).
    let claims = {};
    try { claims = JSON.parse(new TextDecoder().decode(fromB64url(token.id_token.split('.')[1]))); } catch { /* checked below */ }
    const email = cleanEmail(claims.email);
    if (!email || claims.email_verified !== true || claims.aud !== env.GOOGLE_CLIENT_ID) {
      return fail('Google did not share a verified email address.');
    }
    await rememberCustomer(env, email, cleanText(claims.name, 80));
    const res = new Response(null, { status: 302, headers: { location: url.origin + (back || '/account') } });
    res.headers.append('set-cookie', cookieHeader('alhf_oauth', '', 0));
    return signedInResponse(res, await makeSession(env, email));
  }

  return null;
}

// Only ever send someone back to a page on this site.
function safeReturn(v) {
  const s = String(v || '');
  return /^\/[A-Za-z0-9/_?=&.%-]*$/.test(s) && !s.startsWith('//') ? s : '/account';
}

// ---------------------------------------------------------------------------
// Email (Resend). Off until RESEND_API_KEY is set; callers carry on either way.
// ---------------------------------------------------------------------------

async function sendEmail(env, { to, subject, text, html }) {
  // Local testing only (store/.dev.vars): print the email instead of sending.
  // Never set DEV_EMAIL_LOG on the live store.
  if (env.DEV_EMAIL_LOG === '1') {
    console.log('[dev email] to ' + to + ' | ' + subject + ' | ' + text.replace(/\s+/g, ' ').slice(0, 300));
    return { sent: true };
  }
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'RESEND_API_KEY is not set' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: config.email.from,
        reply_to: config.email.reply_to,
        to: [to],
        subject,
        text,
        html,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    return { sent: true };
  } catch (err) {
    console.error('email failed: ' + err);
    return { sent: false, reason: String(err.message || err) };
  }
}

function emailShell(inner) {
  return '<div style="background:#F3EEE4;padding:28px 12px;font-family:Georgia,serif">' +
    '<div style="max-width:520px;margin:0 auto;background:#FBF8F2;border:1px solid #E3DCCE;padding:28px 28px 22px;' +
    'font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#4A443A">' +
    '<div style="font-family:Georgia,serif;font-size:22px;color:#1E1B16;margin-bottom:18px">A Little Hill Farm</div>' +
    inner +
    '<p style="margin:22px 0 0;font-size:12px;color:#6B6353;border-top:1px solid #E3DCCE;padding-top:14px">' +
    'A Little Hill Farm · Potlatch, Idaho · Reply to this email to reach us.</p></div></div>';
}

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The customer's copy of a new order. Sent once, when the order is placed. */
async function sendOrderConfirmation(env, saleId) {
  if (!env.RESEND_API_KEY && env.DEV_EMAIL_LOG !== '1') return;
  const s = await env.DB.prepare('SELECT * FROM sales WHERE id = ?').bind(saleId).first();
  if (!s || !s.customer_email) return;
  const lines = JSON.parse(s.items_json || '[]');
  const pickupId = String(s.fulfillment || '').replace(/^pickup:/, '');
  const pickup = (config.pickup_locations.find((l) => l.id === pickupId) || {}).label || pickupId;
  const how = s.payment_method === 'cash' ? 'You will pay in cash at pickup.'
    : s.payment_method === 'ach' ? 'Your bank transfer is on its way. Bank payments take a few business days to settle.'
    : s.status === 'captured' ? 'Your card has been charged.'
    : 'Your card is authorized but not charged yet. We charge it when we place the supplier order.';
  const rows = lines.map((l) =>
    '<tr><td style="padding:6px 0">' + escHtml(l.qty) + ' × ' + escHtml(l.name) + (l.unit ? ' <span style="color:#6B6353">(' + escHtml(l.unit) + ')</span>' : '') +
    '</td><td style="padding:6px 0;text-align:right">' + dollars(l.line_total_cents != null ? l.line_total_cents : (l.unit_price_cents || 0) * (l.qty || 0)) + '</td></tr>').join('');
  const html = emailShell(
    '<p style="margin:0 0 14px">Thank you' + (s.customer_name ? ', ' + escHtml(String(s.customer_name).split(' ')[0]) : '') +
    ' — your order is in.</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #E3DCCE;border-bottom:1px solid #E3DCCE;margin:0 0 12px">' + rows + '</table>' +
    '<table style="width:100%;font-size:14px;margin:0 0 16px">' +
      '<tr><td>Subtotal</td><td style="text-align:right">' + dollars(s.subtotal_cents) + '</td></tr>' +
      '<tr><td>Idaho sales tax' + (s.tax_exempt ? ' (exempt)' : '') + '</td><td style="text-align:right">' + dollars(s.tax_cents) + '</td></tr>' +
      '<tr><td style="font-weight:600;color:#1E1B16">Total</td><td style="text-align:right;font-weight:600;color:#1E1B16">' + dollars(s.total_cents) + '</td></tr>' +
    '</table>' +
    '<p style="margin:0 0 10px"><strong>Payment.</strong> ' + escHtml(how) + '</p>' +
    '<p style="margin:0 0 10px"><strong>Pickup.</strong> ' + escHtml(pickup) + '. We will email you when your order is ready and set a time.</p>' +
    '<p style="margin:0 0 10px"><strong>Timing.</strong> ' + escHtml(config.terms.text) + '</p>' +
    '<p style="margin:0;color:#6B6353;font-size:13px">Order reference: ' + escHtml(s.id.slice(0, 8)) + '</p>');
  const text = 'Thank you — your order is in.\n\n' +
    lines.map((l) => l.qty + ' x ' + l.name + (l.unit ? ' (' + l.unit + ')' : '')).join('\n') +
    '\n\nTotal: ' + dollars(s.total_cents) + '\n\nPayment: ' + how + '\nPickup: ' + pickup +
    '. We will email you when your order is ready.\n\n' + config.terms.text + '\n\nOrder reference: ' + s.id.slice(0, 8);
  await sendEmail(env, { to: s.customer_email, subject: 'Your A Little Hill Farm order — ' + dollars(s.total_cents), text, html });
}

// ---------------------------------------------------------------------------
// Invoices — phone and bulk orders the farm writes up for a customer
//
// The admin builds the order (any product, including ones hidden from the
// storefront like totes, a changed price, or a free-text line such as
// freight), and the customer gets an email with a link to /pay?inv=<token>.
// There they choose bank transfer (2% off) or card and pay through Stripe
// like any other order; cash or check is recorded from the admin instead.
//
// An invoice is a row in `sales` with channel 'invoice' and status
// 'invoiced' until it is paid. It stays out of the books until then.
// The token is long and random: the link is the customer's key to it.
// ---------------------------------------------------------------------------

const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(24)));
const payLink = (token) => String(config.store_url || '').replace(/\/+$/, '') + '/pay?inv=' + encodeURIComponent(token);

/** Price invoice lines for a payment method. Lines carry their own list
 *  price (catalog or as written by the farm), so this does not consult the
 *  catalog. Same discount and tax rules as the storefront. */
function priceInvoice(lines, method, customer) {
  const discountBps = discountBpsFor(method);
  let subtotal = 0, taxableBase = 0, listSubtotal = 0, cogs = 0;
  const out = lines.map((l) => {
    const unit = Math.round((l.list_price_cents * (10000 - discountBps)) / 10000);
    const lineTotal = unit * l.qty;
    const lineCogs = ((l.cost_cents || 0) + (l.freight_cents || 0)) * l.qty;
    listSubtotal += l.list_price_cents * l.qty;
    subtotal += lineTotal;
    cogs += lineCogs;
    if (l.taxable) taxableBase += lineTotal;
    return { ...l, unit_price_cents: unit, line_total_cents: lineTotal, line_cogs_cents: lineCogs };
  });
  const taxExempt = !!(customer && customer.tax_exempt);
  const tax = taxExempt ? 0 : Math.round((taxableBase * config.tax.idaho_rate_bps) / 10000);
  return {
    lines: out, subtotal_cents: subtotal, discount_cents: listSubtotal - subtotal, tax_cents: tax,
    total_cents: subtotal + tax, cogs_cents: cogs, tax_exempt: taxExempt,
    exemption_ref: taxExempt ? customer.exemption_ref : null, payment_method: method,
  };
}

/** Turn what the admin form sent into clean invoice lines. Catalog lines
 *  start from the product (active or not); a price typed in the form wins. */
async function invoiceLines(env, raw) {
  if (!Array.isArray(raw) || !raw.length) throw new BadRequest('add at least one item');
  if (raw.length > 60) throw new BadRequest('too many lines');
  const catalogNow = await loadCatalog(env);
  return raw.map((r) => {
    const qty = Math.floor(Number(r.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > 9999) throw new BadRequest('each line needs a quantity of at least 1');
    const priceIn = r.price_cents === '' || r.price_cents == null ? null : Math.round(Number(r.price_cents));
    if (priceIn != null && (!Number.isFinite(priceIn) || priceIn < 0 || priceIn > 10000000)) {
      throw new BadRequest('prices must be zero or more');
    }
    if (r.product_id) {
      const p = catalogNow.find((x) => x.id === r.product_id);
      if (!p) throw new BadRequest('unknown product: ' + r.product_id);
      return {
        id: p.id, sku: p.sku, name: p.name, unit: p.unit || '', qty,
        list_price_cents: priceIn != null ? priceIn : p.price_cents,
        cost_cents: p.cost_cents || 0, freight_cents: p.freight_cents || 0, taxable: !!p.taxable,
      };
    }
    const name = cleanText(r.name, 120);
    if (!name) throw new BadRequest('a custom line needs a description');
    if (priceIn == null) throw new BadRequest('a custom line needs a price');
    return {
      id: null, sku: null, name, unit: cleanText(r.unit, 40), qty, list_price_cents: priceIn,
      cost_cents: Math.max(0, Math.round(Number(r.cost_cents) || 0)), freight_cents: 0, taxable: !!r.taxable,
    };
  });
}

async function sendInvoiceEmail(env, sale) {
  const lines = JSON.parse(sale.items_json || '[]');
  const customer = await getCustomer(env, sale.customer_email);
  const card = priceInvoice(lines, 'card', customer);
  const ach = priceInvoice(lines, 'ach', customer);
  const link = payLink(sale.invoice_token);
  const ref = orderRef(sale.id);
  const rows = lines.map((l) => '<tr><td style="padding:6px 0">' + escHtml(l.qty) + ' × ' + escHtml(l.name) +
    (l.unit ? ' <span style="color:#6B6353">(' + escHtml(l.unit) + ')</span>' : '') +
    '</td><td style="padding:6px 0;text-align:right">' + dollars(l.list_price_cents * l.qty) + '</td></tr>').join('');
  const html = emailShell(
    '<p style="margin:0 0 14px">Hi ' + escHtml(String(sale.customer_name || '').split(' ')[0] || 'there') +
      ' — here is your invoice from A Little Hill Farm.</p>' +
    (sale.invoice_note ? '<p style="margin:0 0 14px;padding:10px 12px;background:#F3EEE4">' + escHtml(sale.invoice_note) + '</p>' : '') +
    '<table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #E3DCCE;border-bottom:1px solid #E3DCCE;margin:0 0 12px">' + rows + '</table>' +
    '<table style="width:100%;font-size:14px;margin:0 0 16px">' +
      '<tr><td>Total by bank transfer (2% off)</td><td style="text-align:right;font-weight:600;color:#1E1B16">' + dollars(ach.total_cents) + '</td></tr>' +
      '<tr><td>Total by card</td><td style="text-align:right">' + dollars(card.total_cents) + '</td></tr>' +
      (card.tax_exempt ? '<tr><td colspan="2" style="color:#6B6353">Tax-exempt — no sales tax.</td></tr>' : '<tr><td colspan="2" style="color:#6B6353">Totals include Idaho sales tax.</td></tr>') +
    '</table>' +
    '<p style="margin:0 0 18px"><a href="' + escHtml(link) + '" style="background:#59803D;color:#fff;text-decoration:none;padding:12px 22px;border-radius:2px;display:inline-block;font-size:15px">Pay invoice</a></p>' +
    '<p style="margin:0 0 6px"><strong>Pickup:</strong> ' + escHtml(pickupLabel(sale.fulfillment)) + '</p>' +
    '<p style="margin:0 0 6px;color:#6B6353;font-size:13px">Rather pay by cash or check at pickup? Just reply and let us know.</p>' +
    '<p style="margin:0;color:#6B6353;font-size:13px">Invoice ' + escHtml(ref) + '</p>');
  const text = ['Invoice ' + ref + ' from A Little Hill Farm', '',
    ...(sale.invoice_note ? [sale.invoice_note, ''] : []),
    ...lines.map((l) => l.qty + ' x ' + l.name + (l.unit ? ' (' + l.unit + ')' : '') + '  ' + dollars(l.list_price_cents * l.qty)),
    '', 'Total by bank transfer (2% off): ' + dollars(ach.total_cents), 'Total by card: ' + dollars(card.total_cents), '',
    'Pay here: ' + link, '', 'Pickup: ' + pickupLabel(sale.fulfillment),
    'Rather pay by cash or check at pickup? Just reply and let us know.'].join('\n');
  const r = await sendEmail(env, {
    to: sale.customer_email,
    subject: 'Invoice ' + ref + ' from A Little Hill Farm — ' + dollars(ach.total_cents),
    text, html,
  });
  if (r.sent) {
    await env.DB.prepare('UPDATE sales SET invoice_sent_at = ? WHERE id = ?').bind(new Date().toISOString(), sale.id).run();
  }
  return r;
}

/** Admin: preview, create, resend, cancel, and the customer list. */
async function adminInvoices(request, env) {
  const b = await request.json();
  try {
    if (b.action === 'preview' || b.action === 'create') {
      const email = cleanEmail(b.customer && b.customer.email);
      if (!email) throw new BadRequest('enter the customer’s email address');
      const name = cleanText(b.customer && b.customer.name, 80);
      if (!name) throw new BadRequest('enter the customer’s name');
      const phone = cleanText(b.customer && b.customer.phone, 40);
      const pickup = String(b.pickup || '');
      if (!config.pickup_locations.some((l) => l.id === pickup)) throw new BadRequest('choose a pickup location');
      const lines = await invoiceLines(env, b.lines);
      const customer = await getCustomer(env, email);
      const card = priceInvoice(lines, 'card', customer);
      const ach = priceInvoice(lines, 'ach', customer);
      if (b.action === 'preview') {
        return json({ card: publicQuote(card), ach: publicQuote(ach), tax_exempt: card.tax_exempt, known_customer: !!customer });
      }

      // Remember the customer, never downgrading flags set in the admin.
      await env.DB.prepare(
        'INSERT INTO customers (email, name, phone, created_at) VALUES (?,?,?,?)' +
          ' ON CONFLICT(email) DO UPDATE SET name = excluded.name, phone = COALESCE(excluded.phone, customers.phone)'
      ).bind(email, name, phone || null, new Date().toISOString()).run();

      const id = crypto.randomUUID();
      const token = newToken();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO sales (id, sold_at, channel, category, customer_email, customer_name, customer_phone,' +
          ' items_json, subtotal_cents, tax_cents, total_cents, cogs_cents, tax_exempt, exemption_ref,' +
          ' payment_method, status, fulfillment, notified_json, invoice_token, invoice_note)' +
          ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(id, now, 'invoice', 'feed', email, name, phone || null, JSON.stringify(lines),
        card.subtotal_cents, card.tax_cents, card.total_cents, card.cogs_cents, card.tax_exempt ? 1 : 0, card.exemption_ref,
        'card', 'invoiced', 'pickup:' + pickup, JSON.stringify({ received: now }), token, cleanPara(b.note, 1000) || null).run();

      const sale = await env.DB.prepare('SELECT * FROM sales WHERE id = ?').bind(id).first();
      const sent = b.send === false ? { sent: false, reason: 'not requested' } : await sendInvoiceEmail(env, sale);
      return json({ ok: true, sale_id: id, ref: orderRef(id), link: payLink(token), emailed: sent.sent, email_error: sent.sent ? null : sent.reason });
    }

    const sale = await env.DB.prepare("SELECT * FROM sales WHERE id = ? AND channel = 'invoice'").bind(String(b.sale_id || '')).first();
    if (!sale) return json({ error: 'no invoice with that id' }, 404);

    if (b.action === 'send') {
      if (sale.status !== 'invoiced') throw new BadRequest('this invoice is already ' + sale.status);
      const r = await sendInvoiceEmail(env, sale);
      return r.sent ? json({ ok: true }) : json({ error: 'email not sent: ' + r.reason }, 502);
    }
    if (b.action === 'cancel') {
      if (sale.status !== 'invoiced') throw new BadRequest('only an unpaid invoice can be cancelled (this one is ' + sale.status + ')');
      await env.DB.prepare("UPDATE sales SET status = 'canceled' WHERE id = ?").bind(sale.id).run();
      return json({ ok: true });
    }
    // Paid outside the website: cash or check at pickup.
    if (b.action === 'record_payment') {
      if (sale.status !== 'invoiced') throw new BadRequest('this invoice is already ' + sale.status);
      const method = b.method === 'check' ? 'check' : 'cash';
      const customer = await getCustomer(env, sale.customer_email);
      const q = priceInvoice(JSON.parse(sale.items_json || '[]'), 'cash', customer);
      await env.DB.prepare(
        "UPDATE sales SET status = 'recorded', payment_method = ?, subtotal_cents = ?, tax_cents = ?, total_cents = ?," +
          ' cogs_cents = ?, fulfilled_at = ? WHERE id = ?'
      ).bind(method, q.subtotal_cents, q.tax_cents, q.total_cents, q.cogs_cents, new Date().toISOString(), sale.id).run();
      await recordSaleMoves(env, sale.id);
      return json({ ok: true, total_cents: q.total_cents });
    }
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
  return json({ error: 'unknown action' }, 400);
}

// ---- the customer's pay page ----------------------------------------------

async function findInvoice(env, token) {
  if (!token || String(token).length < 20) return null;
  return env.DB.prepare("SELECT * FROM sales WHERE invoice_token = ? AND channel = 'invoice'").bind(String(token)).first();
}

async function apiInvoice(request, env) {
  const sale = await findInvoice(env, new URL(request.url).searchParams.get('t'));
  if (!sale || sale.status === 'canceled') return json({ error: 'This invoice link is not valid any more. Please contact us.' }, 404);
  const lines = JSON.parse(sale.items_json || '[]');
  const customer = await getCustomer(env, sale.customer_email);
  const card = priceInvoice(lines, 'card', customer);
  const ach = priceInvoice(lines, 'ach', customer);
  const res = json({
    ref: orderRef(sale.id),
    status: sale.status,
    paid: !['invoiced'].includes(sale.status),
    customer_name: sale.customer_name,
    note: sale.invoice_note || '',
    pickup: pickupLabel(sale.fulfillment),
    tax_exempt: card.tax_exempt,
    lines: lines.map((l) => ({ name: l.name, unit: l.unit, qty: l.qty, list_price_cents: l.list_price_cents })),
    card: { subtotal_cents: card.subtotal_cents, tax_cents: card.tax_cents, total_cents: card.total_cents },
    ach: { subtotal_cents: ach.subtotal_cents, tax_cents: ach.tax_cents, total_cents: ach.total_cents },
    total_paid_cents: sale.status === 'invoiced' ? null : sale.total_cents,
  });
  res.headers.set('cache-control', 'no-store');
  return res;
}

async function apiInvoicePay(request, env) {
  const b = await request.json().catch(() => ({}));
  const sale = await findInvoice(env, b.t);
  if (!sale || sale.status === 'canceled') return json({ error: 'This invoice link is not valid any more. Please contact us.' }, 404);
  if (sale.status !== 'invoiced') return json({ error: 'This invoice has already been paid. Thank you!' }, 409);
  const method = b.method === 'ach' ? 'ach' : 'card';
  const customer = await getCustomer(env, sale.customer_email);
  const q = priceInvoice(JSON.parse(sale.items_json || '[]'), method, customer);

  // The totals follow the method chosen. The webhook re-checks against the
  // method the customer actually completed, in case they switched.
  await env.DB.prepare(
    'UPDATE sales SET payment_method = ?, subtotal_cents = ?, tax_cents = ?, total_cents = ?, cogs_cents = ? WHERE id = ?'
  ).bind(method, q.subtotal_cents, q.tax_cents, q.total_cents, q.cogs_cents, sale.id).run();

  const origin = new URL(request.url).origin;
  let session;
  try {
    session = await stripeCheckout(env, origin, {
    saleId: sale.id, email: sale.customer_email, name: sale.customer_name || '',
    pickup: String(sale.fulfillment || '').replace(/^pickup:/, ''), method, lines: q.lines, taxCents: q.tax_cents,
    // The farm wrote this order up itself, so there is nothing to review:
    // charge the card straight away rather than holding it.
    autoCapture: true,
    cancelUrl: origin + '/pay?inv=' + encodeURIComponent(sale.invoice_token),
    idempotencyKey: 'inv_' + sale.id + '_' + method + '_' + crypto.randomUUID(),
    });
  } catch (err) {
    console.error('invoice pay: ' + err);
    return json({ error: 'The payment page could not be opened just now. Please try again, or reply to the invoice email.' }, 502);
  }
  return json({ redirect_url: session.url });
}

/** After Stripe confirms an invoice payment: make the stored totals match
 *  the method the customer actually used. */
async function settleInvoiceMethod(env, saleId, sessionTypes) {
  const sale = await env.DB.prepare("SELECT * FROM sales WHERE id = ? AND channel = 'invoice'").bind(saleId).first();
  if (!sale) return;
  const method = (sessionTypes || []).includes('us_bank_account') ? 'ach' : 'card';
  if (method === sale.payment_method) return;
  const customer = await getCustomer(env, sale.customer_email);
  const q = priceInvoice(JSON.parse(sale.items_json || '[]'), method, customer);
  await env.DB.prepare(
    'UPDATE sales SET payment_method = ?, subtotal_cents = ?, tax_cents = ?, total_cents = ?, cogs_cents = ? WHERE id = ?'
  ).bind(method, q.subtotal_cents, q.tax_cents, q.total_cents, q.cogs_cents, saleId).run();
}

// ---------------------------------------------------------------------------
// Goats — the herd, edited from the admin screen's Goats tab
//
// Rows live in the `goats` table (schema.sql). The farm site's worker reads
// the same table and renders the pages (site/goats.js at the repo root), so
// a save here is live on the next page load. Everything the form sends is
// rebuilt field by field below: unknown keys are dropped, text is trimmed
// and length-capped, and a photo must be a path we issued or one of the
// site's own photos. The site escapes everything again when it renders.
// ---------------------------------------------------------------------------

const PHOTO_PATH = /^(\/media\/[a-f0-9-]{8,}\.(jpg|png|gif|webp)|\/assets\/photos\/(thumbs\/)?[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp))$/;

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanPara(v, max) {
  // Paragraph text keeps its words but not stray whitespace runs.
  return String(v == null ? '' : v).replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

function cleanPhoto(p) {
  if (!p || typeof p !== 'object') return null;
  const src = String(p.src || '');
  if (!PHOTO_PATH.test(src)) throw new BadRequest('a photo path was not one this site issued');
  const out = { src };
  if (p.thumb) {
    if (!PHOTO_PATH.test(String(p.thumb))) throw new BadRequest('a thumbnail path was not one this site issued');
    out.thumb = String(p.thumb);
  }
  const caption = cleanText(p.caption, 120);
  if (caption) out.caption = caption;
  const alt = cleanText(p.alt, 160);
  if (alt) out.alt = alt;
  return out;
}

function cleanGoatData(d, previous) {
  if (!d || typeof d !== 'object') throw new BadRequest('missing goat data');
  const name = cleanText(d.name, 60);
  if (!name) throw new BadRequest('every goat needs a name');
  const dob = String(d.dob || '');
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new BadRequest('date of birth must be a date');

  let elite = null;
  if (d.elite && (d.elite.year || d.elite.percentile)) {
    const year = String(d.elite.year || '').trim();
    const pct = d.elite.percentile === '' || d.elite.percentile == null ? null : Number(d.elite.percentile);
    if (year && !/^\d{4}$/.test(year)) throw new BadRequest('Elite year must be four digits, like 2025');
    if (pct != null && (!Number.isInteger(pct) || pct < 1 || pct > 100)) {
      throw new BadRequest('Elite percentile must be a whole number from 1 to 100');
    }
    elite = { title: cleanText(d.elite.title, 40) || 'ADGA Elite Doe', year, percentile: pct };
  }

  const ped = d.pedigree || {};
  return {
    name,
    registered_name: cleanText(d.registered_name, 120),
    dob,
    reg: cleanText(d.reg, 20).toUpperCase(),
    alpha_s1_casein: cleanText(d.alpha_s1_casein, 12).toUpperCase(),
    colour: cleanText(d.colour, 120),
    height: cleanText(d.height, 40),
    dna_on_file: !!d.dna_on_file,
    badge: cleanText(d.badge, 80),
    badge_tone: d.badge_tone === 'rust' ? 'rust' : '',
    blurb: cleanPara(d.blurb, 600),
    hero: d.hero ? cleanPhoto(d.hero) : null,
    gallery: (Array.isArray(d.gallery) ? d.gallery : []).slice(0, 24).map(cleanPhoto).filter(Boolean),
    elite,
    pedigree: {
      sire: cleanText(ped.sire, 120), dam: cleanText(ped.dam, 120),
      ss: cleanText(ped.ss, 120), sd: cleanText(ped.sd, 120),
      ds: cleanText(ped.ds, 120), dd: cleanText(ped.dd, 120),
    },
    parents: (Array.isArray(d.parents) ? d.parents : []).slice(0, 2).map((p) => ({
      who: cleanText(p && p.who, 30),
      name: cleanText(p && p.name, 120),
      credit: cleanText(p && p.credit, 80),
      lines: (Array.isArray(p && p.lines) ? p.lines : []).slice(0, 8).map((l) => cleanText(l, 160)).filter(Boolean),
      photos: (Array.isArray(p && p.photos) ? p.photos : []).slice(0, 4).map(cleanPhoto).filter(Boolean),
    })),
    facts: (Array.isArray(d.facts) ? d.facts : []).slice(0, 8)
      .map((f) => ({ label: cleanText(f && f.label, 40), value: cleanText(f && f.value, 160) }))
      .filter((f) => f.label && f.value),
    sections: (Array.isArray(d.sections) ? d.sections : []).slice(0, 8)
      .map((s) => ({
        title: cleanText(s && s.title, 60),
        paragraphs: (Array.isArray(s && s.paragraphs) ? s.paragraphs : []).slice(0, 12)
          .map((t) => cleanPara(t, 2000)).filter(Boolean),
      }))
      .filter((s) => s.title && s.paragraphs.length),
    // Writing prompts from the original import. Shown in the form, never on
    // the site, and not editable — carried over from what was stored.
    prompts: (previous && previous.prompts) || [],
  };
}

function slugify(name, fallback = 'goat') {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || fallback;
}

async function adminGoats(request, env) {
  if (request.method === 'GET') {
    const rows = (await env.DB.prepare('SELECT * FROM goats ORDER BY template, sort, id').all()).results || [];
    return json({
      farm_url: config.farm_url,
      goats: rows.map((r) => ({
        id: r.id, sort: r.sort, status: r.status, template: r.template, updated_at: r.updated_at,
        data: JSON.parse(r.data || '{}'),
        // Only what the form needs: ADGA's names, shown as "blank = this".
        registry: r.registry ? (({ sire, dam, grandparents, dna_on_file, dob }) =>
          ({ sire, dam, grandparents, dna_on_file, dob }))(JSON.parse(r.registry)) : null,
      })),
    });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const b = await request.json();
  const now = new Date().toISOString();
  const template = b.template === 'buck' ? 'buck' : 'doe';

  try {
    if (b.action === 'create') {
      const name = cleanText(b.name, 60);
      if (!name) throw new BadRequest('every goat needs a name');
      const base = slugify(name);
      let id = base;
      for (let n = 2; await env.DB.prepare('SELECT 1 FROM goats WHERE id = ?').bind(id).first(); n++) id = base + '-' + n;
      const last = await env.DB.prepare('SELECT MAX(sort) AS s FROM goats WHERE template = ?').bind(template).first();
      const data = cleanGoatData({ name, parents: [{ who: '' }, { who: '' }] }, null);
      // New goats start hidden, so a half-filled page never goes public.
      await env.DB.prepare(
        'INSERT INTO goats (id, sort, status, template, data, registry, updated_at) VALUES (?,?,?,?,?,NULL,?)'
      ).bind(id, ((last && last.s) || 0) + 10, 'hidden', template, JSON.stringify(data), now).run();
      return json({ ok: true, id });
    }

    const row = await env.DB.prepare('SELECT * FROM goats WHERE id = ?').bind(String(b.id || '')).first();
    if (!row) return json({ error: 'no goat with that id' }, 404);

    if (b.action === 'save') {
      // Two people editing the same goat: the second save must not silently
      // erase the first. The form sends back the version it loaded.
      if (b.updated_at !== row.updated_at) {
        return json({ error: 'This goat was changed somewhere else since you opened it. Reload it, then make your change again.' }, 409);
      }
      const data = cleanGoatData(b.data, JSON.parse(row.data || '{}'));
      const status = b.status === 'active' ? 'active' : 'hidden';
      await env.DB.prepare('UPDATE goats SET data = ?, status = ?, template = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(data), status, template, now, row.id).run();
      return json({ ok: true, updated_at: now });
    }

    if (b.action === 'move') {
      const dir = b.direction === 'up' ? -1 : 1;
      const list = (await env.DB.prepare('SELECT id, sort FROM goats WHERE template = ? ORDER BY sort, id')
        .bind(row.template).all()).results;
      const i = list.findIndex((g) => g.id === row.id);
      const j = i + dir;
      if (j < 0 || j >= list.length) return json({ ok: true, unchanged: true });
      [list[i], list[j]] = [list[j], list[i]];
      // Renumber the whole group so ties and gaps can never confuse the order.
      await env.DB.batch(list.map((g, k) =>
        env.DB.prepare('UPDATE goats SET sort = ? WHERE id = ?').bind((k + 1) * 10, g.id)));
      return json({ ok: true });
    }

    if (b.action === 'delete') {
      const name = JSON.parse(row.data || '{}').name || row.id;
      if (cleanText(b.confirm_name, 60).toLowerCase() !== String(name).toLowerCase()) {
        throw new BadRequest('type the goat\'s name exactly to confirm deleting');
      }
      await env.DB.prepare('DELETE FROM goats WHERE id = ?').bind(row.id).run();
      return json({ ok: true });
    }
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
  return json({ error: 'unknown action' }, 400);
}

// ---------------------------------------------------------------------------
// Products, stock, supplier purchases, locations and location sales
//
// Design notes live in research/inventory-plan.md. In short:
//   products        D1 is the catalog (loadCatalog above); edited in admin.
//   stock_moves     a ledger. On hand = SUM(qty). A product with no moves is
//                   untracked (milk) and shows no stock badge.
//   purchases       supplier orders. Receiving one adds stock and moves each
//                   product's cost to a weighted average of LANDED cost
//                   (supplier price + a weight-based share of shipping/fees).
//   location sales  a shop's monthly statement for goods we left there. It
//                   writes stock moves and one sales row (channel 'location').
// All money is integer cents, as everywhere else in this file.
// ---------------------------------------------------------------------------

/** "Low" in the Products filter: this many or fewer left. */
const LOW_STOCK = 3;

/** A whole number of cents, zero or more. Blank counts as zero. */
function centsIn(v, what) {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000000) {
    throw new BadRequest(what + ' must be an amount of zero or more (whole cents)');
  }
  return n;
}

/** A whole number of units, at least 1. */
function qtyIn(v, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 99999) throw new BadRequest(what + ' must be a whole number of at least 1');
  return n;
}

/** YYYY-MM-DD or null. Anything else is a mistake worth saying out loud. */
function dateIn(v, what) {
  if (v == null || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw new BadRequest(what + ' is not a valid date');
  return s;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

/** Placeholders for an IN (...) list. */
const marks = (n) => new Array(n).fill('?').join(',');

// ---- stock moves from sales -------------------------------------------------

/**
 * Take a paid sale's items out of stock. Called wherever a sale becomes paid:
 * a captured card, a settled bank transfer, cash or check recorded, a direct
 * sale. Safe to call twice: the unique index stock_moves_sale_once makes the
 * second insert a no-op. Only products that already have stock moves are
 * touched, so milk and other untracked items stay untracked. A problem here is
 * logged and never blocks the payment that triggered it.
 */
async function recordSaleMoves(env, saleId) {
  try {
    const sale = await env.DB.prepare('SELECT id, items_json, channel FROM sales WHERE id = ?').bind(saleId).first();
    if (!sale || sale.channel === 'location') return;
    let lines = [];
    try { lines = JSON.parse(sale.items_json || '[]'); } catch { /* old free-text sale */ }
    const want = new Map();
    for (const l of Array.isArray(lines) ? lines : []) {
      const qty = Math.floor(Number(l && l.qty));
      if (l && l.id && qty > 0) want.set(l.id, (want.get(l.id) || 0) + qty);
    }
    if (!want.size) return;
    const tracked = new Set(((await env.DB.prepare(
      'SELECT DISTINCT product_id FROM stock_moves WHERE product_id IN (' + marks(want.size) + ')'
    ).bind(...want.keys()).all()).results || []).map((r) => r.product_id));
    const now = new Date().toISOString();
    const stmts = [...want].filter(([id]) => tracked.has(id)).map(([id, qty]) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO stock_moves (product_id, location_id, qty, kind, ref, note, created_at, created_by)" +
          " VALUES (?, NULL, ?, 'sale', ?, ?, ?, 'system')"
      ).bind(id, -qty, sale.id, 'Sale ' + orderRef(sale.id), now));
    if (stmts.length) await env.DB.batch(stmts);
  } catch (err) {
    console.error('stock moves for sale ' + saleId + ' failed: ' + err);
  }
}

async function recordSaleMovesForIntent(env, intentId) {
  try {
    const rows = (await env.DB.prepare("SELECT id FROM sales WHERE stripe_payment_intent = ? AND status = 'captured'")
      .bind(intentId).all()).results || [];
    for (const r of rows) await recordSaleMoves(env, r.id);
  } catch (err) {
    console.error('stock moves for payment ' + intentId + ' failed: ' + err);
  }
}

// ---- landed cost and the moving average -------------------------------------

/**
 * Landed cost per unit for each line of a supplier order: the supplier's price
 * plus the line's share of shipping and fees. The share is split by weight
 * (shipping / total lbs x the line's lbs) when every line has a weight, and by
 * dollars otherwise. Example, New Country Organics SO343263: $368.59 over
 * 2,100 lb is about 17.6 cents a lb, so a 40 lb bag costs about $7.02 more.
 * lines: [{ qty, unit_cost_cents, weight_lbs }]
 * (public/assets/admin-purchases.js has the same arithmetic for the live
 * preview; this copy is the one that is saved.)
 */
function landedCosts(lines, extraCents) {
  const lbs = lines.map((l) => (Number(l.weight_lbs) > 0 ? Number(l.weight_lbs) * l.qty : 0));
  const byWeight = lines.length > 0 && lbs.every((w) => w > 0);
  const basis = lines.map((l, i) => (byWeight ? lbs[i] : l.unit_cost_cents * l.qty));
  const total = basis.reduce((a, b) => a + b, 0);
  const totalLbs = lbs.reduce((a, b) => a + b, 0);
  return {
    by: byWeight ? 'weight' : 'dollars',
    total_lbs: totalLbs,
    cents_per_lb: byWeight && totalLbs > 0 ? extraCents / totalLbs : null,
    landed: lines.map((l, i) => Math.round(l.unit_cost_cents + (total > 0 ? (extraCents * basis[i]) / total : 0) / l.qty)),
  };
}

/**
 * Replay each product's stock moves in date order and set its cost to the
 * moving weighted average of landed cost:
 *   new_avg = (on_hand_before x old_avg + qty x landed) / (on_hand_before + qty)
 * (landed cost alone when nothing was on hand). Replaying from the start,
 * instead of nudging the old average, keeps edits and deletes exact. The cost
 * the product had before its first purchase is kept as its opening cost so
 * stock counted before then still carries it. Freight is zero afterwards:
 * it is already in the landed cost.
 */
async function recomputeCosts(env, productIds) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return;
  const rows = (await env.DB.prepare('SELECT id, data FROM products WHERE id IN (' + marks(ids.length) + ')')
    .bind(...ids).all()).results || [];
  const moves = (await env.DB.prepare(
    'SELECT product_id, qty, unit_cost_cents, kind FROM stock_moves WHERE product_id IN (' + marks(ids.length) +
      ') ORDER BY created_at, id'
  ).bind(...ids).all()).results || [];
  const now = new Date().toISOString();
  const stmts = [];
  for (const r of rows) {
    const data = JSON.parse(r.data);
    const mine = moves.filter((m) => m.product_id === r.id);
    if (data.opening_cost_cents == null) data.opening_cost_cents = (data.cost_cents || 0) + (data.freight_cents || 0);
    let onHand = 0;
    let avg = data.opening_cost_cents;
    for (const m of mine) {
      if (m.kind === 'purchase' && m.unit_cost_cents != null) {
        avg = onHand <= 0 ? m.unit_cost_cents : Math.round((onHand * avg + m.qty * m.unit_cost_cents) / (onHand + m.qty));
      }
      onHand += m.qty;
    }
    if (mine.some((m) => m.kind === 'purchase')) {
      data.cost_cents = avg;
      data.freight_cents = 0;
    } else {
      // Every purchase of it was deleted: back to what it cost before.
      data.cost_cents = data.opening_cost_cents;
    }
    stmts.push(env.DB.prepare('UPDATE products SET data = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(data), now, r.id));
  }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
}

// ---- products ---------------------------------------------------------------

const PRODUCT_IMAGE = /^\/media\/[a-f0-9-]{8,}\.(jpg|png|gif|webp)$/;

/** Turn what the Products form sent into a clean patch for a product's data.
 *  Only fields that were sent are touched. */
function cleanProductFields(f, existing) {
  if (!f || typeof f !== 'object') throw new BadRequest('nothing to save');
  const out = {};
  if ('name' in f) {
    out.name = cleanText(f.name, 120);
    if (!out.name) throw new BadRequest('every product needs a name');
  }
  if ('sku' in f) out.sku = cleanText(f.sku, 40);
  if ('supplier' in f) out.supplier = cleanText(f.supplier, 80);
  if ('unit' in f) out.unit = cleanText(f.unit, 40);
  if ('category' in f) out.category = cleanText(f.category, 30).toLowerCase() || 'other';
  if ('description' in f) out.description = cleanPara(f.description, 4000);
  if ('note' in f) out.note = cleanText(f.note, 200) || null;
  if ('taxable' in f) out.taxable = !!f.taxable;
  if ('active' in f) out.active = !!f.active;
  if ('archived' in f) out.archived = !!f.archived;
  if ('weight_lbs' in f) {
    if (f.weight_lbs === '' || f.weight_lbs == null) out.weight_lbs = null;
    else {
      const w = Number(f.weight_lbs);
      if (!Number.isFinite(w) || w < 0 || w > 5000) throw new BadRequest('weight must be a number of pounds, zero or more');
      out.weight_lbs = Math.round(w * 100) / 100;
    }
  }
  for (const k of ['price_cents', 'cost_cents', 'freight_cents']) {
    if (k in f) out[k] = centsIn(f[k], k === 'price_cents' ? 'the price' : k === 'cost_cents' ? 'the cost' : 'the freight');
  }
  if ('popular' in f) {
    const n = Number(f.popular) || 0;
    out.popular = Number.isInteger(n) && n > 0 && n < 1000 ? n : 0;
  }
  if ('animals' in f) {
    const list = Array.isArray(f.animals) ? f.animals : String(f.animals || '').split(',');
    out.animals = [...new Set(list.map((a) => cleanText(a, 30)).filter(Boolean))].slice(0, 12);
  }
  if ('image' in f) {
    const img = String(f.image || '');
    // Only a photo we issued, or the one it already has. Never an arbitrary URL.
    if (img && img !== (existing && existing.image) && !PRODUCT_IMAGE.test(img)) {
      throw new BadRequest('the photo must be one uploaded here');
    }
    out.image = img;
  }
  return out;
}

async function productHasHistory(env, id) {
  const checks = [
    ['SELECT 1 FROM stock_moves WHERE product_id = ? LIMIT 1', id],
    ['SELECT 1 FROM purchase_lines WHERE product_id = ? LIMIT 1', id],
    ['SELECT 1 FROM location_report_lines WHERE product_id = ? LIMIT 1', id],
    ['SELECT 1 FROM purchase_history WHERE product_id = ? LIMIT 1', id],
    ['SELECT 1 FROM sales WHERE items_json LIKE ? LIMIT 1', '%"id":"' + id + '"%'],
  ];
  for (const [sql, arg] of checks) {
    if (await env.DB.prepare(sql).bind(arg).first()) return true;
  }
  return false;
}

async function adminProducts(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    // One product's recent stock moves, for its edit form.
    const movesFor = url.searchParams.get('moves');
    if (movesFor) {
      const rows = (await env.DB.prepare(
        'SELECT m.id, m.qty, m.kind, m.ref, m.note, m.created_at, m.unit_cost_cents, m.location_id, l.name AS location_name' +
          ' FROM stock_moves m LEFT JOIN locations l ON l.id = m.location_id' +
          ' WHERE m.product_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 40'
      ).bind(movesFor).all()).results || [];
      return json({ moves: rows });
    }
    const products = await loadCatalog(env);
    const levels = await stockLevels(env);
    return json({
      low_stock: LOW_STOCK,
      products: products.map((p) => ({
        id: p.id,
        sku: p.sku || '',
        name: p.name,
        supplier: p.supplier || '',
        unit: p.unit || '',
        weight_lbs: p.weight_lbs == null ? null : p.weight_lbs,
        category: p.category || 'other',
        image: p.image || '',
        active: !!p.active,
        archived: !!p.archived,
        taxable: !!p.taxable,
        price_cents: p.price_cents || 0,
        cost_cents: p.cost_cents || 0,
        freight_cents: p.freight_cents || 0,
        description: p.description || '',
        animals: p.animals || [],
        popular: p.popular || 0,
        note: p.note || '',
        // null = not tracked; the first count or purchase starts tracking it.
        on_hand: levels.has(p.id) ? levels.get(p.id) : null,
        // What is left after cost and freight. Negative means we lose money.
        margin_cents: (p.price_cents || 0) - (p.cost_cents || 0) - (p.freight_cents || 0),
      })),
    });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const b = await request.json();
  const who = await adminIdentity(request, env);
  const now = new Date().toISOString();
  try {
    if (b.action === 'create') {
      const patch = cleanProductFields(b.fields, null);
      if (!patch.name) throw new BadRequest('every product needs a name');
      const base = slugify(patch.name + (patch.unit ? ' ' + patch.unit : ''), 'product');
      let id = base;
      for (let n = 2; await env.DB.prepare('SELECT 1 FROM products WHERE id = ?').bind(id).first(); n++) id = base + '-' + n;
      const last = await env.DB.prepare('SELECT MAX(sort) AS s FROM products').first();
      // New products start switched off, so a half-filled one never reaches the store.
      const data = {
        sku: '', supplier: '', unit: '', category: 'feed', taxable: true, description: '', image: '', animals: [],
        price_cents: 0, cost_cents: 0, freight_cents: 0, weight_lbs: null, ...patch, active: !!patch.active,
      };
      if (data.weight_lbs == null) data.weight_lbs = weightFromUnit(data.unit);
      await env.DB.prepare('INSERT INTO products (id, data, sort, created_at, updated_at) VALUES (?,?,?,?,?)')
        .bind(id, JSON.stringify(data), ((last && last.s) || 0) + 10, now, now).run();
      return json({ ok: true, id });
    }

    const row = await env.DB.prepare('SELECT id, data FROM products WHERE id = ?').bind(String(b.id || '')).first();
    if (!row) return json({ error: 'no product with that id' }, 404);
    const data = JSON.parse(row.data);

    if (b.action === 'save') {
      const patch = cleanProductFields(b.fields, data);
      // A misplaced decimal point is the most expensive mistake this form can
      // make. 0.53 for 53.00 sells $53 feed for 53 cents, and those orders are
      // binding. So a price that moves more than 5x either way must be confirmed.
      if ('price_cents' in patch) {
        const before = data.price_cents || 0;
        const price = patch.price_cents;
        const wild = before > 0 && price > 0 && (price > before * 5 || price * 5 < before);
        if (wild && b.confirm !== true) {
          return json({
            error: 'price_change_needs_confirmation',
            message: 'That changes the price from $' + (before / 100).toFixed(2) + ' to $' + (price / 100).toFixed(2) +
              '. Check the decimal point, then confirm to save.',
            before_cents: before,
            after_cents: price,
          }, 409);
        }
      }
      // Typing a new cost by hand starts a new average from that figure.
      const costTyped = 'cost_cents' in patch && patch.cost_cents !== data.cost_cents;
      if (costTyped) data.opening_cost_cents = patch.cost_cents;
      Object.assign(data, patch);
      if (data.active) data.archived = false;
      await env.DB.prepare('UPDATE products SET data = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(data), now, row.id).run();
      // On a product with purchases, the average is rebuilt on top of the
      // typed cost, so what she sees is what will stick.
      if (costTyped) await recomputeCosts(env, [row.id]);
      return json({ ok: true });
    }

    if (b.action === 'stock') {
      const sum = await env.DB.prepare('SELECT COALESCE(SUM(qty),0) AS s, COUNT(*) AS n FROM stock_moves WHERE product_id = ?')
        .bind(row.id).first();
      const note = cleanText(b.note, 120) || null;
      let qty, kind;
      if (b.mode === 'count') {
        const counted = Number(b.counted);
        if (b.counted === '' || b.counted == null || !Number.isInteger(counted) || counted < 0 || counted > 1000000) {
          throw new BadRequest('the count must be a whole number, zero or more');
        }
        qty = counted - sum.s;
        kind = 'count';
        // Already right, and already tracked: nothing to record.
        if (sum.n > 0 && qty === 0) return json({ ok: true, on_hand: sum.s, unchanged: true });
      } else {
        qty = Number(b.delta);
        kind = 'adjust';
        if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 1000000) {
          throw new BadRequest('enter how many to add or take off, such as 5 or -2');
        }
      }
      await env.DB.prepare(
        'INSERT INTO stock_moves (product_id, location_id, qty, kind, ref, note, created_at, created_by) VALUES (?,NULL,?,?,NULL,?,?,?)'
      ).bind(row.id, qty, kind, note, now, who).run();
      return json({ ok: true, on_hand: sum.s + qty });
    }

    if (b.action === 'delete') {
      // A product that was ever sold, bought or counted is hidden, not erased,
      // so old orders and the books still make sense.
      if (await productHasHistory(env, row.id)) {
        data.active = false;
        data.archived = true;
        await env.DB.prepare('UPDATE products SET data = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(data), now, row.id).run();
        return json({ ok: true, archived: true });
      }
      await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(row.id).run();
      return json({ ok: true, deleted: true });
    }
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
  return json({ error: 'unknown action' }, 400);
}

// ---- supplier purchases -----------------------------------------------------

async function loadPurchase(env, id) {
  const purchase = await env.DB.prepare('SELECT * FROM purchases WHERE id = ?').bind(id).first();
  if (!purchase) return null;
  purchase.lines = (await env.DB.prepare('SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY id').bind(id).all()).results || [];
  return purchase;
}

async function adminPurchases(request, env) {
  if (request.method === 'GET') {
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
      const purchase = await loadPurchase(env, id);
      return purchase ? json({ purchase }) : json({ error: 'no purchase with that id' }, 404);
    }
    const rows = (await env.DB.prepare(
      'SELECT p.*, (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_id = p.id) AS line_count,' +
        ' (SELECT COALESCE(SUM(qty),0) FROM purchase_lines l WHERE l.purchase_id = p.id) AS units' +
        ' FROM purchases p ORDER BY p.ordered_at DESC, p.created_at DESC LIMIT 300'
    ).all()).results || [];
    return json({ purchases: rows });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const b = await request.json();
  const who = await adminIdentity(request, env);
  const now = new Date().toISOString();
  try {
    if (b.action === 'delete') {
      const old = await loadPurchase(env, String(b.id || ''));
      if (!old) return json({ error: 'no purchase with that id' }, 404);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM stock_moves WHERE kind = 'purchase' AND ref = ?").bind(old.id),
        env.DB.prepare('DELETE FROM purchase_lines WHERE purchase_id = ?').bind(old.id),
        env.DB.prepare('DELETE FROM purchases WHERE id = ?').bind(old.id),
      ]);
      await recomputeCosts(env, old.lines.map((l) => l.product_id));
      return json({ ok: true });
    }
    if (b.action !== 'save') return json({ error: 'unknown action' }, 400);

    const supplier = cleanText(b.supplier, 80);
    if (!supplier) throw new BadRequest('enter the supplier’s name');
    const orderedAt = dateIn(b.ordered_at, 'the order date') || todayStr();
    const received = b.received !== false;
    const receivedAt = received ? dateIn(b.received_at, 'the received date') || orderedAt : null;
    if (!Array.isArray(b.lines) || !b.lines.length) throw new BadRequest('add at least one item');
    if (b.lines.length > 60) throw new BadRequest('too many lines on one purchase');

    const products = new Map((await loadCatalog(env)).map((p) => [p.id, p]));
    const lines = b.lines.map((l, i) => {
      const where = 'line ' + (i + 1);
      const product = l.product_id ? products.get(String(l.product_id)) : null;
      if (l.product_id && !product) throw new BadRequest(where + ': that product no longer exists');
      const name = cleanText(l.name, 120) || (product && product.name) || '';
      if (!name) throw new BadRequest(where + ' needs a product or a description');
      const weight = l.weight_lbs === '' || l.weight_lbs == null ? (product && product.weight_lbs) || null : Number(l.weight_lbs);
      if (weight != null && (!Number.isFinite(weight) || weight < 0 || weight > 5000)) {
        throw new BadRequest(where + ': weight must be pounds, zero or more');
      }
      return {
        product_id: product ? product.id : null,
        name,
        sku: cleanText(l.sku, 40) || (product && product.sku) || '',
        qty: qtyIn(l.qty, where + ' quantity'),
        unit_cost_cents: centsIn(l.unit_cost_cents, where + ' price'),
        weight_lbs: weight || null,
      };
    });
    const shipping = centsIn(b.shipping_cents, 'shipping');
    const other = centsIn(b.other_cents, 'other fees');
    const tax = centsIn(b.tax_cents, 'tax');
    const landed = landedCosts(lines, shipping + other).landed;
    const total = lines.reduce((n, l) => n + l.qty * l.unit_cost_cents, 0) + shipping + other + tax;

    let id = String(b.id || '');
    let oldIds = [];
    const stmts = [];
    if (id) {
      const old = await loadPurchase(env, id);
      if (!old) return json({ error: 'no purchase with that id' }, 404);
      oldIds = old.lines.map((l) => l.product_id);
      stmts.push(env.DB.prepare(
        'UPDATE purchases SET supplier=?, ordered_at=?, received_at=?, ref=?, po=?, shipping_cents=?, other_cents=?, tax_cents=?,' +
          ' total_cents=?, note=?, updated_at=? WHERE id=?'
      ).bind(supplier, orderedAt, receivedAt, cleanText(b.ref, 60) || null, cleanText(b.po, 60) || null, shipping, other, tax,
        total, cleanPara(b.note, 1000) || null, now, id));
      stmts.push(env.DB.prepare('DELETE FROM purchase_lines WHERE purchase_id = ?').bind(id));
    } else {
      id = crypto.randomUUID();
      stmts.push(env.DB.prepare(
        'INSERT INTO purchases (id, supplier, ordered_at, received_at, ref, po, shipping_cents, other_cents, tax_cents, total_cents,' +
          ' note, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(id, supplier, orderedAt, receivedAt, cleanText(b.ref, 60) || null, cleanText(b.po, 60) || null, shipping, other, tax,
        total, cleanPara(b.note, 1000) || null, now, now, who));
    }
    lines.forEach((l, i) => {
      stmts.push(env.DB.prepare(
        'INSERT INTO purchase_lines (purchase_id, product_id, name, sku, qty, unit_cost_cents, weight_lbs, landed_unit_cents)' +
          ' VALUES (?,?,?,?,?,?,?,?)'
      ).bind(id, l.product_id, l.name, l.sku, l.qty, l.unit_cost_cents, l.weight_lbs, landed[i]));
    });
    // Rewrite this purchase's stock moves from scratch: delete by ref, re-insert.
    stmts.push(env.DB.prepare("DELETE FROM stock_moves WHERE kind = 'purchase' AND ref = ?").bind(id));
    if (received) {
      const note = 'Purchase from ' + supplier + (b.ref ? ' ' + cleanText(b.ref, 60) : '');
      lines.forEach((l, i) => {
        if (!l.product_id) return;
        stmts.push(env.DB.prepare(
          "INSERT INTO stock_moves (product_id, location_id, qty, unit_cost_cents, kind, ref, note, created_at, created_by)" +
            " VALUES (?, NULL, ?, ?, 'purchase', ?, ?, ?, ?)"
        ).bind(l.product_id, l.qty, landed[i], id, note, receivedAt + 'T00:00:00.000Z', who));
      });
    }
    await env.DB.batch(stmts);
    await recomputeCosts(env, oldIds.concat(lines.map((l) => l.product_id)));
    return json({ ok: true, id, total_cents: total });
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
}

// ---- locations --------------------------------------------------------------

async function adminLocations(request, env) {
  if (request.method === 'GET') {
    const rows = (await env.DB.prepare(
      "SELECT l.*, (SELECT COUNT(*) FROM location_reports r WHERE r.location_id = l.id) AS reports FROM locations l" +
        " ORDER BY (l.id = 'farm') DESC, l.active DESC, l.name COLLATE NOCASE"
    ).all()).results || [];
    return json({ locations: rows });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const b = await request.json();
  const now = new Date().toISOString();
  try {
    if (b.action === 'save') {
      const name = cleanText(b.name, 80);
      if (!name) throw new BadRequest('every location needs a name');
      const kind = ['farm', 'store', 'market', 'other'].includes(b.kind) ? b.kind : 'store';
      const bps = Math.round(Number(b.commission_bps) || 0);
      if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new BadRequest('the shop’s cut must be between 0% and 100%');
      const fields = [
        name, kind, cleanText(b.address, 200) || null, cleanText(b.contact, 80) || null, cleanText(b.phone, 40) || null,
        cleanText(b.email, 120) || null, bps, b.tax_collected_by_location ? 1 : 0, b.active === false ? 0 : 1,
        cleanPara(b.note, 1000) || null,
      ];
      if (b.id) {
        const r = await env.DB.prepare('SELECT id FROM locations WHERE id = ?').bind(String(b.id)).first();
        if (!r) return json({ error: 'no location with that id' }, 404);
        await env.DB.prepare(
          'UPDATE locations SET name=?, kind=?, address=?, contact=?, phone=?, email=?, commission_bps=?,' +
            ' tax_collected_by_location=?, active=?, note=?, updated_at=? WHERE id=?'
        ).bind(...fields, now, r.id).run();
        return json({ ok: true, id: r.id });
      }
      const base = slugify(name, 'location');
      let id = base;
      for (let n = 2; await env.DB.prepare('SELECT 1 FROM locations WHERE id = ?').bind(id).first(); n++) id = base + '-' + n;
      await env.DB.prepare(
        'INSERT INTO locations (name, kind, address, contact, phone, email, commission_bps, tax_collected_by_location, active, note,' +
          ' id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(...fields, id, now, now).run();
      return json({ ok: true, id });
    }
    if (b.action === 'delete') {
      const id = String(b.id || '');
      if (id === 'farm') throw new BadRequest('the farm itself cannot be deleted');
      const used = (await env.DB.prepare('SELECT 1 FROM location_reports WHERE location_id = ? LIMIT 1').bind(id).first()) ||
        (await env.DB.prepare('SELECT 1 FROM stock_moves WHERE location_id = ? LIMIT 1').bind(id).first());
      // A location with reports behind it is switched off, not erased.
      if (used) {
        await env.DB.prepare('UPDATE locations SET active = 0, updated_at = ? WHERE id = ?').bind(now, id).run();
        return json({ ok: true, archived: true });
      }
      await env.DB.prepare('DELETE FROM locations WHERE id = ?').bind(id).run();
      return json({ ok: true, deleted: true });
    }
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
  return json({ error: 'unknown action' }, 400);
}

// ---- location (consignment) sales reports -----------------------------------

/** Totals for a shop's statement. Line net and total calculate (gross less
 *  discount; net plus tax) unless a figure was typed over them. The payout
 *  defaults to net less the shop's cut, and can be typed over too: Johnson's
 *  Sep 2026 sheet pays $156 gross - $6 actual discount + $12 milk = $162, which
 *  the report's own discount column would not give.
 *  (public/assets/admin-location-sales.js repeats this for the live preview.) */
function reportTotals(rawLines, location, b) {
  const lines = rawLines.map((l, i) => {
    const where = 'line ' + (i + 1);
    const gross = centsIn(l.gross_cents, where + ' gross');
    const discount = centsIn(l.discount_cents, where + ' discount');
    const tax = centsIn(l.tax_cents, where + ' tax');
    const net = l.net_cents === '' || l.net_cents == null ? Math.max(0, gross - discount) : centsIn(l.net_cents, where + ' net');
    const total = l.total_cents === '' || l.total_cents == null ? net + tax : centsIn(l.total_cents, where + ' total');
    return { gross_cents: gross, discount_cents: discount, net_cents: net, tax_cents: tax, total_cents: total };
  });
  const sum = (k) => lines.reduce((n, l) => n + l[k], 0);
  const extraTax = centsIn(b.extra_tax_cents, 'the extra tax');
  const net = sum('net_cents');
  const commission = b.commission_cents === '' || b.commission_cents == null
    ? Math.round((net * (location.commission_bps || 0)) / 10000) : centsIn(b.commission_cents, 'the shop’s cut');
  const payout = b.payout_cents === '' || b.payout_cents == null ? net - commission : centsIn(b.payout_cents, 'the payout');
  return {
    lines,
    gross_cents: sum('gross_cents'),
    discount_cents: sum('discount_cents'),
    net_cents: net,
    tax_cents: sum('tax_cents') + extraTax,
    total_cents: sum('total_cents') + extraTax,
    commission_cents: commission,
    payout_cents: payout,
  };
}

async function loadReport(env, id) {
  const report = await env.DB.prepare(
    'SELECT r.*, l.name AS location_name FROM location_reports r LEFT JOIN locations l ON l.id = r.location_id WHERE r.id = ?'
  ).bind(id).first();
  if (!report) return null;
  report.lines = (await env.DB.prepare('SELECT * FROM location_report_lines WHERE report_id = ? ORDER BY id').bind(id).all()).results || [];
  return report;
}

async function adminLocationReports(request, env) {
  if (request.method === 'GET') {
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
      const report = await loadReport(env, id);
      return report ? json({ report }) : json({ error: 'no report with that id' }, 404);
    }
    const rows = (await env.DB.prepare(
      'SELECT r.*, l.name AS location_name FROM location_reports r LEFT JOIN locations l ON l.id = r.location_id' +
        ' ORDER BY COALESCE(r.period_end, substr(r.created_at,1,10)) DESC, r.created_at DESC LIMIT 300'
    ).all()).results || [];
    return json({ reports: rows });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const b = await request.json();
  const who = await adminIdentity(request, env);
  const now = new Date().toISOString();
  try {
    if (b.action === 'delete') {
      const report = await loadReport(env, String(b.id || ''));
      if (!report) return json({ error: 'no report with that id' }, 404);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM stock_moves WHERE kind = 'location_sale' AND ref = ?").bind(report.id),
        env.DB.prepare('DELETE FROM sales WHERE id = ?').bind('loc_' + report.id),
        env.DB.prepare('DELETE FROM location_report_lines WHERE report_id = ?').bind(report.id),
        env.DB.prepare('DELETE FROM location_reports WHERE id = ?').bind(report.id),
      ]);
      return json({ ok: true });
    }
    if (b.action === 'mark_paid') {
      const report = await loadReport(env, String(b.id || ''));
      if (!report) return json({ error: 'no report with that id' }, 404);
      if (b.paid === false) {
        await env.DB.prepare('UPDATE location_reports SET paid_at = NULL, paid_method = NULL, updated_at = ? WHERE id = ?')
          .bind(now, report.id).run();
      } else {
        await env.DB.prepare('UPDATE location_reports SET paid_at = ?, paid_method = ?, updated_at = ? WHERE id = ?')
          .bind(dateIn(b.paid_at, 'the paid date') || todayStr(), cleanText(b.method, 30) || 'check', now, report.id).run();
      }
      return json({ ok: true });
    }
    if (b.action !== 'save') return json({ error: 'unknown action' }, 400);

    const location = await env.DB.prepare('SELECT * FROM locations WHERE id = ?').bind(String(b.location_id || '')).first();
    if (!location) throw new BadRequest('choose which location this report is from');
    const label = cleanText(b.period_label, 60);
    if (!label) throw new BadRequest('give the report a name, such as “Sep 2026”');
    const start = dateIn(b.period_start, 'the start date');
    const end = dateIn(b.period_end, 'the end date');
    if (start && end && start > end) throw new BadRequest('the start date is after the end date');
    if (!Array.isArray(b.lines) || !b.lines.length) throw new BadRequest('add at least one line');
    if (b.lines.length > 80) throw new BadRequest('too many lines on one report');

    const products = new Map((await loadCatalog(env)).map((p) => [p.id, p]));
    const raw = b.lines.map((l, i) => {
      const where = 'line ' + (i + 1);
      const product = l.product_id ? products.get(String(l.product_id)) : null;
      if (l.product_id && !product) throw new BadRequest(where + ': that product no longer exists');
      const name = cleanText(l.name, 120) || (product && product.name) || '';
      if (!name) throw new BadRequest(where + ' needs a product or a description');
      return { ...l, product, name, qty: qtyIn(l.qty, where + ' quantity') };
    });
    const t = reportTotals(raw, location, b);

    let id = String(b.id || '');
    const stmts = [];
    if (id) {
      const old = await env.DB.prepare('SELECT id FROM location_reports WHERE id = ?').bind(id).first();
      if (!old) return json({ error: 'no report with that id' }, 404);
      stmts.push(env.DB.prepare(
        'UPDATE location_reports SET location_id=?, period_label=?, period_start=?, period_end=?, gross_cents=?, discount_cents=?,' +
          ' net_cents=?, tax_cents=?, total_cents=?, commission_cents=?, payout_cents=?, note=?, updated_at=? WHERE id=?'
      ).bind(location.id, label, start, end, t.gross_cents, t.discount_cents, t.net_cents, t.tax_cents, t.total_cents,
        t.commission_cents, t.payout_cents, cleanPara(b.note, 1000) || null, now, id));
      stmts.push(env.DB.prepare('DELETE FROM location_report_lines WHERE report_id = ?').bind(id));
    } else {
      id = crypto.randomUUID();
      stmts.push(env.DB.prepare(
        'INSERT INTO location_reports (id, location_id, period_label, period_start, period_end, gross_cents, discount_cents,' +
          ' net_cents, tax_cents, total_cents, commission_cents, payout_cents, note, created_at, updated_at, created_by)' +
          ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(id, location.id, label, start, end, t.gross_cents, t.discount_cents, t.net_cents, t.tax_cents, t.total_cents,
        t.commission_cents, t.payout_cents, cleanPara(b.note, 1000) || null, now, now, who));
    }
    raw.forEach((l, i) => {
      const c = t.lines[i];
      stmts.push(env.DB.prepare(
        'INSERT INTO location_report_lines (report_id, product_id, name, qty, gross_cents, discount_cents, net_cents, tax_cents, total_cents)' +
          ' VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(id, l.product ? l.product.id : null, l.name, l.qty, c.gross_cents, c.discount_cents, c.net_cents, c.tax_cents, c.total_cents));
    });

    // Stock: what the shop sold leaves the shelf. Tracked products only, as
    // with every other sale.
    const soldAt = (end || todayStr()) + 'T12:00:00.000Z';
    stmts.push(env.DB.prepare("DELETE FROM stock_moves WHERE kind = 'location_sale' AND ref = ?").bind(id));
    const want = new Map();
    raw.forEach((l) => { if (l.product) want.set(l.product.id, (want.get(l.product.id) || 0) + l.qty); });
    const tracked = want.size ? new Set(((await env.DB.prepare(
      'SELECT DISTINCT product_id FROM stock_moves WHERE product_id IN (' + marks(want.size) + ')'
    ).bind(...want.keys()).all()).results || []).map((r) => r.product_id)) : new Set();
    for (const [pid, qty] of want) {
      if (!tracked.has(pid)) continue;
      stmts.push(env.DB.prepare(
        "INSERT INTO stock_moves (product_id, location_id, qty, kind, ref, note, created_at, created_by)" +
          " VALUES (?, ?, ?, 'location_sale', ?, ?, ?, ?)"
      ).bind(pid, location.id, -qty, id, location.name + ' ' + label, soldAt, who));
    }

    // The books: one sales row for the whole report, so revenue and COGS stay
    // whole. Revenue is what the shop pays us (the payout), with the shop's
    // discounts and cut already taken off. The shop collects sales tax on its
    // own sales, so by default it is marked exempt and stays out of our Idaho
    // filing; a shop that does not collect it leaves that tax with us.
    const catOf = (name) => (/milk/i.test(name) ? 'milk' : /cheese/i.test(name) ? 'cheese' : 'feed');
    const byCat = new Map();
    const items = raw.map((l, i) => {
      const cat = catOf(l.name);
      byCat.set(cat, (byCat.get(cat) || 0) + t.lines[i].net_cents);
      const unit = l.product ? (l.product.cost_cents || 0) + (l.product.freight_cents || 0) : 0;
      return { id: l.product ? l.product.id : null, name: l.name, qty: l.qty, category: cat, ...t.lines[i], cost_cents: unit };
    });
    const category = [...byCat].sort((a, c) => c[1] - a[1])[0][0];
    const cogs = items.reduce((n, l) => n + l.cost_cents * l.qty, 0);
    const exempt = location.tax_collected_by_location ? 1 : 0;
    const tax = exempt ? 0 : t.tax_cents;
    stmts.push(env.DB.prepare(
      'INSERT OR REPLACE INTO sales (id, sold_at, channel, category, customer_name, items_json, subtotal_cents, tax_cents, total_cents,' +
        ' cogs_cents, tax_exempt, payment_method, status, fulfillment, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind('loc_' + id, soldAt, 'location', category, location.name, JSON.stringify(items), t.payout_cents, tax, t.payout_cents + tax,
      cogs, exempt, 'consignment', 'recorded', 'location:' + location.id, 'Location report ' + id));
    await env.DB.batch(stmts);
    return json({ ok: true, id, gross_cents: t.gross_cents, net_cents: t.net_cents, payout_cents: t.payout_cents });
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Alerts — what needs attention, and telling someone about it
//
// notify() posts to NOTIFY_URL (a secret). Leave it unset and nothing is
// ever sent anywhere; the admin screen's "Needs attention" box still works.
// It speaks ntfy (https://ntfy.sh — free phone push, no account: install
// the app, subscribe to a long random topic, set NOTIFY_URL to
// https://ntfy.sh/<that-topic>) and Discord/Slack-style JSON webhooks.
//
// Messages carry order totals and counts only — never a customer's name,
// email or phone — because the notification service can read them.
//
// Two cron triggers (wrangler.toml) drive the checks below:
//   every 30 min   are both websites answering? Alert when one goes down
//                  (two failures in a row) and again when it recovers.
//   daily, 7am PT  card holds about to expire, orders waiting for review,
//                  cash still to collect, checkouts Stripe never confirmed.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const HOLD_DAYS = 7;          // how long a card authorization lasts
const DIGEST_CRON = '0 14 * * *';

async function notify(env, { title, message, priority, tags, click }) {
  if (!env.NOTIFY_URL) return { sent: false, reason: 'NOTIFY_URL is not set' };
  const url = String(env.NOTIFY_URL);
  try {
    let res;
    if (/discord(app)?\.com\/api\/webhooks|hooks\.slack\.com/.test(url)) {
      const text = '**' + title + '**\n' + message + (click ? '\n' + click : '');
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(/slack/.test(url) ? { text } : { content: text }),
        signal: AbortSignal.timeout(8000),
      });
    } else {
      const headers = { title, priority: String(priority || 3) };
      if (tags) headers.tags = tags;
      if (click) headers.click = click;
      res = await fetch(url, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(8000) });
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { sent: true };
  } catch (err) {
    console.error('notify failed: ' + err);
    return { sent: false, reason: String(err.message || err) };
  }
}

const dollars = (cents) => '$' + (Math.round(Number(cents) || 0) / 100).toFixed(2);
const adminUrl = () => String(config.store_url || '').replace(/\/+$/, '') + '/admin';

/** Tell the farm a new order came in. Called once per order. */
async function notifyNewOrder(env, saleId) {
  const s = await env.DB.prepare('SELECT total_cents, payment_method, status, items_json FROM sales WHERE id = ?')
    .bind(saleId).first();
  if (!s) return;
  let items = 0;
  try { items = JSON.parse(s.items_json || '[]').reduce((n, l) => n + (Number(l.qty) || 0), 0); } catch { /* count stays 0 */ }
  const how = s.payment_method === 'cash' ? 'cash at pickup'
    : s.status === 'captured' ? 'paid by ' + (s.payment_method === 'ach' ? 'bank transfer' : 'card')
    : s.payment_method === 'ach' ? 'bank transfer, processing'
    : 'card held, not yet charged — review and capture';
  await sendFarmOrderEmail(env, saleId, how);
  return notify(env, {
    title: 'New order: ' + dollars(s.total_cents),
    message: (items ? items + (items === 1 ? ' item, ' : ' items, ') : '') + how + '.',
    tags: 'shopping_cart',
    click: adminUrl(),
  });
}

/** The farm's own copy of a new order, in plain words: who, what, how they
 *  paid, where they'll pick up, and what to do next. Sent to config
 *  email.orders_to. Unlike the phone alert, this one names the customer -
 *  it goes to our own inbox. */
async function sendFarmOrderEmail(env, saleId, how) {
  const to = config.email && config.email.orders_to;
  if (!to) return;
  const s = await env.DB.prepare('SELECT * FROM sales WHERE id = ?').bind(saleId).first();
  if (!s) return;
  const lines = JSON.parse(s.items_json || '[]');
  const ref = orderRef(s.id);
  const next = s.status === 'authorized'
    ? 'Review it in the admin, then Capture when you place the supplier order (or Cancel - free). The hold lasts 7 days.'
    : s.payment_method === 'cash' ? 'Collect cash at pickup, then press Collected in the admin.'
    : s.payment_method === 'ach' && s.status !== 'captured' ? 'Nothing to do yet - the bank transfer settles in a few business days.'
    : 'Paid. Add it to the next supplier order.';
  const rows = lines.map((l) => '<tr><td style="padding:5px 0">' + escHtml(l.qty) + ' × ' + escHtml(l.name) +
    (l.unit ? ' <span style="color:#6B6353">(' + escHtml(l.unit) + ')</span>' : '') + '</td><td style="padding:5px 0;text-align:right">' +
    dollars(l.line_total_cents) + '</td></tr>').join('');
  const html = emailShell(
    '<p style="margin:0 0 6px;font-size:20px;color:#1E1B16">Order ' + escHtml(ref) + ' · ' + dollars(s.total_cents) + '</p>' +
    '<p style="margin:0 0 14px">' + escHtml(s.customer_name || '') + ' · ' + escHtml(s.customer_email || '') +
      (s.customer_phone ? ' · ' + escHtml(s.customer_phone) : '') + '</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #E3DCCE;border-bottom:1px solid #E3DCCE;margin:0 0 12px">' + rows + '</table>' +
    '<p style="margin:0 0 6px"><strong>Payment:</strong> ' + escHtml(how) + (s.tax_exempt ? ' (tax-exempt)' : '') + '</p>' +
    '<p style="margin:0 0 6px"><strong>Pickup:</strong> ' + escHtml(pickupLabel(s.fulfillment)) + '</p>' +
    '<p style="margin:0 0 16px"><strong>Next:</strong> ' + escHtml(next) + '</p>' +
    '<p style="margin:0"><a href="' + adminUrl() + '" style="background:#59803D;color:#fff;text-decoration:none;padding:10px 18px;border-radius:2px;display:inline-block">Open the admin</a></p>');
  const text = ['Order ' + ref + ' - ' + dollars(s.total_cents),
    (s.customer_name || '') + ' <' + (s.customer_email || '') + '>' + (s.customer_phone ? ' ' + s.customer_phone : ''),
    '',
    ...lines.map((l) => l.qty + ' x ' + l.name + (l.unit ? ' (' + l.unit + ')' : '')),
    '',
    'Payment: ' + how, 'Pickup: ' + pickupLabel(s.fulfillment), 'Next: ' + next, '', adminUrl()].join('\n');
  await sendEmail(env, { to, subject: 'New order ' + ref + ' · ' + (s.customer_name || 'customer') + ' · ' + dollars(s.total_cents), text, html });
}

/** Everything that needs a person, newest problems first. Shared by the
 *  admin screen and the morning digest. */
async function attentionItems(env) {
  const now = Date.now();
  const items = [];
  const rows = (await env.DB.prepare(
    "SELECT id, sold_at, status, payment_method, total_cents, notes FROM sales" +
      " WHERE status IN ('authorized','awaiting_cash','pending','processing','failed')" +
      " OR (notes LIKE '%DISPUTE OPENED%' AND sold_at >= ?)" +
      ' ORDER BY sold_at'
  ).bind(new Date(now - 90 * DAY).toISOString()).all()).results || [];

  const held = rows.filter((r) => r.status === 'authorized' && r.payment_method === 'card');
  for (const r of held) {
    const left = HOLD_DAYS - (now - Date.parse(r.sold_at)) / DAY;
    if (left <= 2) {
      items.push({
        level: 'urgent',
        text: 'A ' + dollars(r.total_cents) + ' card hold ' +
          (left <= 0 ? 'has probably expired' : 'expires in about ' + Math.max(1, Math.round(left * 24)) + ' hours') +
          ' — capture or cancel it on the Orders tab.',
      });
    }
  }
  if (held.length) {
    items.push({
      level: 'todo',
      text: held.length + (held.length === 1 ? ' order is' : ' orders are') + ' waiting for review (card held, not charged).',
    });
  }
  const cash = rows.filter((r) => r.status === 'awaiting_cash');
  if (cash.length) {
    items.push({
      level: 'todo',
      text: cash.length + ' cash ' + (cash.length === 1 ? 'order' : 'orders') + ' to collect at pickup (' +
        dollars(cash.reduce((n, r) => n + r.total_cents, 0)) + ').',
    });
  }
  // Stripe expires an unfinished checkout after 24 hours and tells us so.
  // A 'pending' row older than two days means that message never arrived.
  const stuck = rows.filter((r) => r.status === 'pending' && now - Date.parse(r.sold_at) > 2 * DAY);
  if (stuck.length) {
    items.push({
      level: 'urgent',
      text: stuck.length + (stuck.length === 1 ? ' checkout has' : ' checkouts have') +
        ' had no word from Stripe for over two days. Stripe may not be reaching the store — check the webhook in the Stripe dashboard.',
    });
  }
  const failed = rows.filter((r) => r.status === 'failed');
  if (failed.length) {
    items.push({
      level: 'urgent',
      text: failed.length + (failed.length === 1 ? ' bank transfer has' : ' bank transfers have') +
        ' failed — contact the customer before ordering their items.',
    });
  }
  // Bank transfers normally settle in about four business days.
  const slow = rows.filter((r) => r.status === 'processing' && now - Date.parse(r.sold_at) > 7 * DAY);
  if (slow.length) {
    items.push({
      level: 'todo',
      text: slow.length + (slow.length === 1 ? ' bank transfer is' : ' bank transfers are') +
        ' still processing after a week — check them in the Stripe dashboard.',
    });
  }
  const unpaid = (await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS cents FROM sales WHERE status = 'invoiced' AND sold_at < ?"
  ).bind(new Date(now - 7 * DAY).toISOString()).first()) || { n: 0 };
  if (unpaid.n) {
    items.push({
      level: 'todo',
      text: unpaid.n + (unpaid.n === 1 ? ' invoice has' : ' invoices have') + ' been unpaid for over a week (' +
        dollars(unpaid.cents) + ') — resend or follow up.',
    });
  }
  const disputes = rows.filter((r) => /DISPUTE OPENED/.test(r.notes || ''));
  if (disputes.length) {
    items.push({
      level: 'urgent',
      text: disputes.length + (disputes.length === 1 ? ' payment dispute' : ' payment disputes') +
        ' opened in the last 90 days — answer them in the Stripe dashboard before the deadline.',
    });
  }
  const down = (await env.DB.prepare("SELECT key, value, updated_at FROM alert_state WHERE key LIKE 'site:%' AND value = 'down'")
    .all()).results || [];
  for (const d of down) {
    items.unshift({ level: 'urgent', text: d.key.slice(5) + ' is not answering (since ' + d.updated_at.slice(0, 16).replace('T', ' ') + ' UTC).' });
  }
  return items;
}

async function morningDigest(env) {
  const items = await attentionItems(env);
  if (!items.length) return;
  const urgent = items.some((i) => i.level === 'urgent');
  await notify(env, {
    title: 'Farm store: ' + items.length + (items.length === 1 ? ' thing needs' : ' things need') + ' attention',
    message: items.map((i) => '• ' + i.text).join('\n'),
    priority: urgent ? 4 : 3,
    tags: urgent ? 'warning' : 'clipboard',
    click: adminUrl(),
  });
}

/** Are both websites answering like a browser would see them? */
async function siteChecks(env) {
  const targets = [
    [String(config.farm_url || '').replace(/\/+$/, '') + '/', 'A Little Hill Farm'],
    [String(config.farm_url || '').replace(/\/+$/, '') + '/does.html', 'A Little Hill Farm'],
    [String(config.store_url || '').replace(/\/+$/, '') + '/api/catalog', '"products"'],
  ];
  const results = [];
  for (const [url, expect] of targets) {
    let ok = false;
    let why = '';
    try {
      // Browser page-load headers: the asset layer answers those differently
      // from a plain fetch, which is exactly how the home page once 404'd
      // for every visitor while command-line checks passed.
      const res = await fetch(url, {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html,application/json' },
        signal: AbortSignal.timeout(10000),
        cf: { cacheTtl: 0 },
      });
      const body = await res.text();
      ok = res.status === 200 && body.includes(expect);
      why = ok ? '' : 'HTTP ' + res.status;
    } catch (err) {
      why = String(err.message || err);
    }
    results.push({ url, ok, why });

    const key = 'site:' + url;
    const prev = await env.DB.prepare('SELECT value FROM alert_state WHERE key = ?').bind(key).first();
    const was = prev ? prev.value : 'up';
    // One failure can be a blip; two in a row (an hour apart at most) is real.
    const next = ok ? 'up' : was === 'up' ? 'failing' : 'down';
    if (next !== was) {
      await env.DB.prepare(
        'INSERT INTO alert_state (key, value, updated_at) VALUES (?,?,?)' +
          ' ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      ).bind(key, next, new Date().toISOString()).run();
      if (next === 'down') {
        await notify(env, { title: 'Website down', message: url + ' is not answering (' + why + ').', priority: 5, tags: 'rotating_light', click: url });
      } else if (next === 'up' && was === 'down') {
        await notify(env, { title: 'Website back up', message: url + ' is answering again.', tags: 'white_check_mark', click: url });
      }
    }
  }
  console.log('site checks: ' + results.map((r) => (r.ok ? 'ok ' : 'FAIL ') + r.url + (r.why ? ' (' + r.why + ')' : '')).join('; '));
  return results;
}

async function scheduled(event, env) {
  if (event.cron === DIGEST_CRON) await morningDigest(env);
  else await siteChecks(env);
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** The approved admin emails, from the ADMIN_EMAILS secret (kept out of the
 *  public repo). Comma- or space-separated. */
function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
}

/** Who is using the admin: a signed-in approved email, or 'password' for the
 *  emergency ADMIN_PASSWORD login. '' = nobody allowed. */
async function adminIdentity(request, env) {
  const who = await sessionEmail(request, env);
  if (who && adminEmails(env).includes(who)) return who;

  // Emergency fallback, if sign-in is ever broken: HTTP Basic with
  // ADMIN_PASSWORD. The browser only asks for it at /admin?password.
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ') && env.ADMIN_PASSWORD) {
    let decoded = '';
    try { decoded = atob(header.slice(6)); } catch { /* not base64 */ }
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (timingSafeEqual(password, env.ADMIN_PASSWORD)) return 'password';
  }
  return '';
}

/** null = go ahead; otherwise the response to send instead. */
async function requireAdmin(request, env, path) {
  const url = new URL(request.url);
  if (await adminIdentity(request, env)) {
    // Admin changes must come from our own pages. SameSite cookies already
    // stop other sites riding the session; this is the second lock.
    const origin = request.headers.get('origin');
    if (request.method !== 'GET' && origin && origin !== url.origin) {
      return json({ error: 'request came from another site' }, 403);
    }
    return null;
  }
  if (path === '/admin') {
    if (url.searchParams.has('password')) {
      return new Response('Authentication required', {
        status: 401, headers: { 'www-authenticate': 'Basic realm="A Little Hill Farm"' },
      });
    }
    const who = await sessionEmail(request, env);
    if (who) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">' +
          '<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.6">' +
          '<h1 style="font-weight:500">Not an admin account</h1><p>You are signed in as <strong>' + escHtml(who) +
          '</strong>, which is not on the admin list.</p><p><a href="/account">Your account</a> — log out there and sign in with an admin email.</p>',
        { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return Response.redirect(url.origin + '/account?return=' + encodeURIComponent('/admin'), 302);
  }
  // No WWW-Authenticate here: a missing session must not pop up a password box.
  return json({ error: 'Sign in with an admin account.' }, 401);
}

async function adminRoutes(path, request, env) {
  if (path === '/admin') {
    // Ask the asset layer for '/admin', not '/admin.html'. Cloudflare treats
    // the extensionless path as canonical and 307s the .html form to it, which
    // would bounce straight back into this handler. The ASSETS binding does not
    // re-enter the Worker, so there is no loop.
    const page = await env.ASSETS.fetch(new Request(new URL('/admin', request.url), request));
    // Never let the admin page sit in a shared cache. Without this it can be
    // served from the edge to someone who never passed the auth check.
    const res = new Response(page.body, page);
    res.headers.set('cache-control', 'private, no-store, max-age=0');
    res.headers.set('x-robots-tag', 'noindex, nofollow');
    res.headers.set('referrer-policy', 'no-referrer');
    return res;
  }

  if (path === '/api/admin/goats') return adminGoats(request, env);
  if (path === '/api/admin/products') return adminProducts(request, env);
  if (path === '/api/admin/purchases') return adminPurchases(request, env);
  if (path === '/api/admin/locations') return adminLocations(request, env);
  if (path === '/api/admin/location-reports') return adminLocationReports(request, env);
  if (path === '/api/admin/invoice' && request.method === 'POST') return adminInvoices(request, env);

  // Everyone we know, for the invoice form's customer picker.
  if (path === '/api/admin/customers') {
    const rows = (await env.DB.prepare(
      'SELECT email, name, phone, tax_exempt, trusted FROM customers ORDER BY name COLLATE NOCASE, email'
    ).all()).results || [];
    return json({ customers: rows });
  }

  // A customer's most recent distinct products, newest first — this store's
  // own orders plus history carried over from Shopify (purchase_history).
  if (path === '/api/admin/customer-history') {
    const email = cleanEmail(new URL(request.url).searchParams.get('email'));
    if (!email) return json({ items: [] });
    const seen = new Map();
    const take = (id, at, qty, price) => {
      if (!id) return;
      const prev = seen.get(id);
      if (!prev || at > prev.at) seen.set(id, { id, at, qty, price });
    };
    const sales = (await env.DB.prepare(
      "SELECT sold_at, items_json FROM sales WHERE customer_email = ? AND status NOT IN ('canceled','abandoned','pending','invoiced','failed')"
    ).bind(email).all()).results || [];
    for (const s of sales) {
      for (const l of JSON.parse(s.items_json || '[]')) take(l.id, s.sold_at, l.qty, l.list_price_cents);
    }
    const old = (await env.DB.prepare(
      'SELECT sold_at, product_id, qty, price_cents FROM purchase_history WHERE email = ? AND product_id IS NOT NULL'
    ).bind(email).all()).results || [];
    for (const h of old) take(h.product_id, h.sold_at.replace(' ', 'T'), h.qty, h.price_cents);

    const products = new Map((await loadCatalog(env)).map((p) => [p.id, p]));
    const items = [...seen.values()].filter((h) => products.has(h.id))
      .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 3)
      .map((h) => {
        const p = products.get(h.id);
        return { product_id: h.id, name: p.name, unit: p.unit || '', last_qty: h.qty, last_price_cents: h.price,
          price_cents: p.price_cents, last_date: h.at.slice(0, 10), active: !!p.active };
      });
    return json({ items });
  }

  if (path === '/api/admin/attention') {
    return json({ items: await attentionItems(env), alerts_configured: !!env.NOTIFY_URL });
  }

  if (path === '/api/admin/test-alert' && request.method === 'POST') {
    const r = await notify(env, {
      title: 'Test alert from the farm store',
      message: 'If you can read this on your phone, store alerts are working.',
      tags: 'white_check_mark',
      click: adminUrl(),
    });
    return json(r, r.sent ? 200 : 400);
  }

  if (path === '/api/admin/sales') {
    const status = new URL(request.url).searchParams.get('status');
    // Location (consignment) sales have their own tab; they are not orders.
    const q = status
      ? env.DB.prepare("SELECT * FROM sales WHERE status = ? AND channel != 'location' ORDER BY sold_at DESC LIMIT 500").bind(status)
      : env.DB.prepare("SELECT * FROM sales WHERE channel != 'location' ORDER BY sold_at DESC LIMIT 500");
    return json({ sales: (await q.all()).results });
  }

  // Quarterly Idaho sales tax, in one query.
  if (path === '/api/admin/report') {
    const p = new URL(request.url).searchParams;
    const from = p.get('from');
    const to = p.get('to');
    if (!from || !to) return json({ error: 'from and to required (YYYY-MM-DD)' }, 400);

    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS sales,' +
        ' COALESCE(SUM(total_cents),0)    AS gross_cents,' +
        ' COALESCE(SUM(subtotal_cents),0) AS subtotal_cents,' +
        ' COALESCE(SUM(tax_cents),0)      AS tax_collected_cents,' +
        ' COALESCE(SUM(cogs_cents),0)     AS cogs_cents,' +
        ' COALESCE(SUM(CASE WHEN tax_exempt=1 THEN total_cents ELSE 0 END),0) AS exempt_cents' +
        ' FROM sales' +
        " WHERE status IN ('captured','recorded','refunded') AND sold_at >= ? AND sold_at < ?"
    )
      .bind(from, to)
      .first();

    // Refunds count in the period they were GIVEN, not the period of the sale:
    // a September sale refunded in October reduces October's sales tax.
    // Tax on a refund is its share of that sale's tax.
    const refunds = await env.DB.prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(refunded_cents),0) AS cents,' +
        ' COALESCE(SUM(CASE WHEN total_cents > 0 THEN ROUND(refunded_cents * 1.0 * tax_cents / total_cents) ELSE 0 END),0) AS tax_cents' +
        ' FROM sales WHERE refunded_cents > 0 AND refunded_at >= ? AND refunded_at < ?'
    )
      .bind(from, to)
      .first();

    const byCategory = await env.DB.prepare(
      'SELECT category, COUNT(*) AS n,' +
        ' COALESCE(SUM(total_cents),0) AS total_cents,' +
        ' COALESCE(SUM(cogs_cents),0)  AS cogs_cents' +
        ' FROM sales' +
        " WHERE status IN ('captured','recorded','refunded') AND sold_at >= ? AND sold_at < ?" +
        ' GROUP BY category ORDER BY total_cents DESC'
    )
      .bind(from, to)
      .all();

    return json({
      period: { from, to },
      ...row,
      // Schedule F wants revenue and COGS separately. Revenue excludes the
      // sales tax we collected on the state's behalf — that is not income.
      refunds: refunds.n,
      refunds_cents: refunds.cents,
      refunded_tax_cents: refunds.tax_cents,
      // What to report: collected minus refunded in this period.
      net_gross_cents: row.gross_cents - refunds.cents,
      net_tax_cents: row.tax_collected_cents - refunds.tax_cents,
      revenue_cents: row.subtotal_cents - (refunds.cents - refunds.tax_cents),
      gross_margin_cents: row.subtotal_cents - (refunds.cents - refunds.tax_cents) - row.cogs_cents,
      by_category: byCategory.results.map((c) => ({
        ...c,
        gross_margin_cents: c.total_cents - c.cogs_cents,
      })),
    });
  }

  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Raw image bytes in the body. No multipart parsing — one file per request
  // keeps this small enough to read in one sitting.
  if (path === '/api/admin/upload') {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_UPLOAD_BYTES) {
      return json({ error: 'image must be 10 MB or smaller' }, 413);
    }

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) return json({ error: 'no file received' }, 400);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return json({ error: 'image must be 10 MB or smaller' }, 413);
    }

    const kind = sniffImage(bytes.slice(0, 16));
    if (!kind) {
      return json({ error: 'that is not a JPEG, PNG, GIF or WebP image' }, 400);
    }

    const key = 'uploads/' + crypto.randomUUID() + '.' + kind.ext;
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: kind.mime } });

    return json({
      ok: true,
      url: '/media/' + key.split('/').pop(),
      bytes: bytes.byteLength,
      type: kind.mime,
    });
  }

  if (path === '/api/admin/capture') {
    const { sale_id, amount_cents } = await request.json();
    const sale = await env.DB.prepare('SELECT * FROM sales WHERE id = ?').bind(sale_id).first();
    if (!sale) return json({ error: 'not found' }, 404);

    // Only a held card authorization can be captured. ACH has no hold to
    // capture, and cash never touched Stripe at all.
    if (sale.payment_method !== 'card' || !sale.stripe_payment_intent) {
      return json({ error: 'only card payments can be captured (this one is ' + sale.payment_method + ')' }, 400);
    }
    if (sale.status !== 'authorized') {
      return json({ error: 'cannot capture a sale that is ' + sale.status }, 400);
    }

    const form = new URLSearchParams();
    // A partial capture releases the remainder, and only one capture is allowed.
    if (amount_cents != null) {
      const amount = Math.round(Number(amount_cents));
      if (!Number.isFinite(amount) || amount < 1 || amount > sale.total_cents) {
        return json({ error: 'capture amount must be between 1 and the authorized total' }, 400);
      }
      form.set('amount_to_capture', String(amount));
    }

    try {
      await stripe(env, 'POST', '/payment_intents/' + sale.stripe_payment_intent + '/capture', form, 'cap_' + sale_id);
    } catch (err) {
      return json({ error: String(err.message || err) }, 502);
    }

    const captured = amount_cents != null ? Math.round(Number(amount_cents)) : sale.total_cents;

    // A partial capture means we took less than we authorized. The ledger has
    // to reflect what actually moved, or the quarterly report overstates both
    // revenue and the sales tax owed to Idaho.
    if (captured < sale.total_cents) {
      // Split the captured amount back into subtotal and tax at the same rate,
      // so subtotal + tax still equals what the customer was actually charged.
      const rate = sale.tax_exempt ? 0 : config.tax.idaho_rate_bps;
      const newSubtotal = Math.round((captured * 10000) / (10000 + rate));
      const newTax = captured - newSubtotal;
      const newCogs = sale.total_cents > 0
        ? Math.round((sale.cogs_cents * captured) / sale.total_cents)
        : 0;

      await env.DB.prepare(
        "UPDATE sales SET status = 'captured', subtotal_cents = ?, tax_cents = ?," +
          ' total_cents = ?, cogs_cents = ?,' +
          " notes = COALESCE(notes,'') || ' [partial capture: authorized " +
          sale.total_cents + ", captured ' || ? || ']'" +
          ' WHERE id = ?'
      )
        .bind(newSubtotal, newTax, captured, newCogs, String(captured), sale_id)
        .run();

      await recordSaleMoves(env, sale_id);
      return json({ ok: true, captured_cents: captured, adjusted: true });
    }

    await env.DB.prepare("UPDATE sales SET status = 'captured' WHERE id = ?").bind(sale_id).run();
    await recordSaleMoves(env, sale_id);
    return json({ ok: true, captured_cents: captured });
  }

  // Give money back on a paid order - all of it or part. Card and bank
  // payments are refunded through Stripe (which keeps its processing fee);
  // cash and check are just recorded, since the money is handed back by hand.
  if (path === '/api/admin/refund') {
    const { sale_id, amount_cents } = await request.json();
    const sale = await env.DB.prepare('SELECT * FROM sales WHERE id = ?').bind(sale_id).first();
    if (!sale) return json({ error: 'not found' }, 404);
    if (!['captured', 'recorded'].includes(sale.status)) {
      return json({ error: 'only a paid order can be refunded (this one is ' + sale.status + ')' }, 400);
    }
    const left = sale.total_cents - (sale.refunded_cents || 0);
    const amount = amount_cents == null ? left : Math.round(Number(amount_cents));
    if (!Number.isFinite(amount) || amount < 1 || amount > left) {
      return json({ error: 'refund must be between $0.01 and ' + dollars(left) }, 400);
    }
    if (sale.stripe_payment_intent) {
      const form = new URLSearchParams({ payment_intent: sale.stripe_payment_intent, amount: String(amount) });
      form.set('metadata[sale_id]', sale.id);
      try {
        await stripe(env, 'POST', '/refunds', form, 'rf_' + sale.id + '_' + (sale.refunded_cents || 0) + '_' + amount);
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
    }
    const total = (sale.refunded_cents || 0) + amount;
    await env.DB.prepare(
      'UPDATE sales SET refunded_cents = ?, refunded_at = ?,' +
        " status = CASE WHEN ? >= total_cents THEN 'refunded' ELSE status END WHERE id = ?"
    ).bind(total, new Date().toISOString(), total, sale.id).run();

    if (sale.customer_email) {
      const how = sale.stripe_payment_intent
        ? 'It goes back to the ' + (sale.payment_method === 'ach' ? 'bank account' : 'card') +
          ' you paid with and usually appears within 5-10 business days.'
        : 'We will hand it back to you in person.';
      await sendEmail(env, {
        to: sale.customer_email,
        subject: 'Refund from A Little Hill Farm: ' + dollars(amount),
        text: 'We have refunded ' + dollars(amount) + ' on your order ' + sale.id.slice(0, 8) + '. ' + how +
          '\n\nQuestions? Just reply to this email.',
        html: emailShell('<p style="margin:0 0 12px">We have refunded <strong>' + dollars(amount) +
          '</strong> on your order.</p><p style="margin:0 0 12px">' + escHtml(how) + '</p>' +
          '<p style="margin:0;color:#6B6353;font-size:13px">Order reference: ' + escHtml(sale.id.slice(0, 8)) + '</p>'),
      });
    }
    return json({ ok: true, refunded_cents: total, fully: total >= sale.total_cents });
  }

  if (path === '/api/admin/cancel') {
    const { sale_id } = await request.json();
    const sale = await env.DB.prepare('SELECT * FROM sales WHERE id = ?').bind(sale_id).first();
    if (!sale) return json({ error: 'not found' }, 404);

    // Once money has moved, cancelling is no longer free — that is a refund,
    // and a refund forfeits the processing fee. Refuse and make them say so.
    if (sale.status === 'captured' || sale.status === 'recorded') {
      return json({ error: 'this sale is already paid — cancelling now would be a refund, which forfeits the processing fee. Issue it in the Stripe dashboard if you mean to.' }, 400);
    }
    if (sale.status === 'canceled') return json({ ok: true, already: true });

    // Cancelling an uncaptured authorization costs nothing. A refund would not.
    if (sale.stripe_payment_intent) {
      try {
        await stripe(
          env,
          'POST',
          '/payment_intents/' + sale.stripe_payment_intent + '/cancel',
          new URLSearchParams(),
          'cxl_' + sale_id
        );
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
    }
    await env.DB.prepare("UPDATE sales SET status = 'canceled' WHERE id = ?").bind(sale_id).run();
    return json({ ok: true });
  }

  // Cash collected at pickup. Until this fires, a cash order is not revenue
  // and stays out of the tax report.
  if (path === '/api/admin/collect') {
    const { sale_id } = await request.json();
    const sale = await env.DB.prepare('SELECT * FROM sales WHERE id = ?').bind(sale_id).first();
    if (!sale) return json({ error: 'not found' }, 404);
    if (sale.status !== 'awaiting_cash') {
      return json({ error: 'not a cash order awaiting collection (it is ' + sale.status + ')' }, 400);
    }
    await env.DB.prepare("UPDATE sales SET status = 'recorded', fulfilled_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), sale_id)
      .run();
    await recordSaleMoves(env, sale_id);
    return json({ ok: true });
  }

  // Sales that never touch Stripe: cash feed, milk, cheese, goats.
  if (path === '/api/admin/record') {
    const b = await request.json();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const subtotal = Math.round(Number(b.subtotal_cents) || 0);
    const tax = Math.round(Number(b.tax_cents) || 0);

    await env.DB.prepare(
      'INSERT INTO sales (id, sold_at, channel, category, customer_email, customer_name, customer_phone,' +
        ' items_json, subtotal_cents, tax_cents, total_cents, cogs_cents, tax_exempt, exemption_ref,' +
        ' payment_method, status, fulfillment, notes)' +
        ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
      .bind(
        id,
        b.sold_at || now,
        'direct',
        b.category || 'other',
        b.customer_email || null,
        b.customer_name || null,
        b.customer_phone || null,
        JSON.stringify(b.items || []),
        subtotal,
        tax,
        subtotal + tax,
        Math.round(Number(b.cogs_cents) || 0),
        b.tax_exempt ? 1 : 0,
        b.exemption_ref || null,
        b.payment_method || 'cash',
        'recorded',
        b.fulfillment || null,
        b.notes || null
      )
      .run();

    await recordSaleMoves(env, id);
    return json({ ok: true, sale_id: id });
  }

  // Tick off a stage email. The writing stays human; this is just the checklist.
  if (path === '/api/admin/notify') {
    const { sale_id, stage } = await request.json();
    const sale = await env.DB.prepare('SELECT notified_json FROM sales WHERE id = ?').bind(sale_id).first();
    if (!sale) return json({ error: 'not found' }, 404);

    const notified = JSON.parse(sale.notified_json || '{}');
    notified[stage] = new Date().toISOString();
    await env.DB.prepare('UPDATE sales SET notified_json = ? WHERE id = ?')
      .bind(JSON.stringify(notified), sale_id)
      .run();

    return json({ ok: true, notified });
  }

  return json({ error: 'not found' }, 404);
}
