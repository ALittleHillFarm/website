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
 *   ADMIN_PASSWORD         secret
 */

import catalog from './products.json';
import config from './config.json';

const STRIPE = 'https://api.stripe.com/v1';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    try {
      if (path === '/api/config') return apiConfig();
      if (path === '/api/catalog') return apiCatalog(env);
      if (path === '/api/quote' && request.method === 'POST') return apiQuote(request, env);
      if (path === '/api/checkout' && request.method === 'POST') return apiCheckout(request, env);
      if (path === '/api/webhook' && request.method === 'POST') return apiWebhook(request, env);
      if (path.startsWith('/media/')) return serveMedia(path, env);

      if (path === '/admin' || path.startsWith('/api/admin/')) {
        const denied = requireAdmin(request, env);
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
};

// ---------------------------------------------------------------------------
// Catalog + config (public)
// ---------------------------------------------------------------------------

/**
 * The effective catalog: products.json overlaid with whatever has been edited
 * from /admin. products.json owns what a product IS; product_settings owns
 * whether it is for sale and what it costs. A NULL column falls back.
 */
async function loadCatalog(env) {
  let overrides = new Map();
  try {
    const rows = (await env.DB.prepare('SELECT * FROM product_settings').all()).results || [];
    overrides = new Map(rows.map((r) => [r.product_id, r]));
  } catch (err) {
    // A settings-table problem must not take the storefront down. Fall back to
    // the committed catalog, which is always a safe, known-good state.
    console.error('product_settings unavailable, using products.json: ' + err);
  }

  return catalog.products.map((p) => {
    const o = overrides.get(p.id);
    if (!o) return p;
    return {
      ...p,
      active: o.active == null ? p.active : !!o.active,
      image: o.image || p.image,
      price_cents: o.price_cents == null ? p.price_cents : o.price_cents,
      cost_cents: o.cost_cents == null ? p.cost_cents : o.cost_cents,
      freight_cents: o.freight_cents == null ? p.freight_cents : o.freight_cents,
      note: o.note || null,
    };
  });
}

const activeFrom = (products) => products.filter((p) => p.active);

function apiConfig() {
  return json({
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

async function apiCatalog(env) {
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
    })),
  });
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
    const customer = body.email ? await getCustomer(env, body.email) : null;
    return json(publicQuote(priceCart(body.items, method, customer, await loadCatalog(env))));
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

async function apiCheckout(request, env) {
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

  const customer = await getCustomer(env, email);

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

  // Cash never touches Stripe.
  if (method === 'cash') {
    return json({ sale_id: saleId, redirect_url: null, total_cents: quote.total_cents });
  }

  const origin = new URL(request.url).origin;
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('customer_email', email);
  form.set('success_url', origin + '/thanks?sale=' + saleId);
  // The cart lives on the storefront index, not a separate page.
  form.set('cancel_url', origin + '/?cart=1');
  form.set('client_reference_id', saleId);
  form.set('metadata[sale_id]', saleId);
  form.set('metadata[pickup]', pickup);
  form.set('metadata[terms_version]', config.terms.version);

  if (method === 'ach') {
    // ACH cannot authorize-then-capture, so review happens before the debit.
    form.set('payment_method_types[0]', 'us_bank_account');
  } else {
    form.set('payment_method_types[0]', 'card');
    if (!autoCapture) form.set('payment_intent_data[capture_method]', 'manual');
  }

  quote.lines.forEach((line, i) => {
    form.set('line_items[' + i + '][quantity]', String(line.qty));
    form.set('line_items[' + i + '][price_data][currency]', 'usd');
    form.set('line_items[' + i + '][price_data][unit_amount]', String(line.unit_price_cents));
    form.set(
      'line_items[' + i + '][price_data][product_data][name]',
      line.unit ? line.name + ' (' + line.unit + ')' : line.name
    );
  });

  if (quote.tax_cents > 0) {
    const i = quote.lines.length;
    form.set('line_items[' + i + '][quantity]', '1');
    form.set('line_items[' + i + '][price_data][currency]', 'usd');
    form.set('line_items[' + i + '][price_data][unit_amount]', String(quote.tax_cents));
    form.set('line_items[' + i + '][price_data][product_data][name]', 'Idaho sales tax');
  }

  // The idempotency key is the sale id, so a retry can never double-authorize.
  const session = await stripe(env, 'POST', '/checkout/sessions', form, saleId);

  // Stripe does not create the PaymentIntent until the customer completes the
  // session, so payment_intent is usually null here. Store the session id as
  // well — before completion it is the only link back to Stripe, and it is what
  // lets us reconcile by hand if a webhook is ever missed.
  await env.DB.prepare('UPDATE sales SET stripe_session_id = ?, stripe_payment_intent = ? WHERE id = ?')
    .bind(session.id || null, session.payment_intent || null, saleId)
    .run();

  return json({ sale_id: saleId, redirect_url: session.url, total_cents: quote.total_cents });
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

async function apiWebhook(request, env) {
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
        // 'paid' means it settled; otherwise we are holding an authorization.
        const status = obj.payment_status === 'paid' ? 'captured' : 'authorized';
        await env.DB.prepare(
          "UPDATE sales SET status = ?," +
            ' stripe_payment_intent = COALESCE(?, stripe_payment_intent)' +
            " WHERE id = ? AND status = 'pending'"
        )
          .bind(status, obj.payment_intent || null, saleId)
          .run();
      }
      break;
    }

    case 'payment_intent.amount_capturable_updated':
      await setStatusByIntent(env, obj.id, 'authorized');
      break;

    case 'payment_intent.succeeded':
      await setStatusByIntent(env, obj.id, 'captured');
      break;

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

    case 'charge.dispute.created':
      await env.DB.prepare(
        "UPDATE sales SET notes = COALESCE(notes,'') || ' [DISPUTE OPENED ' || ? || ']'" +
          ' WHERE stripe_payment_intent = ?'
      )
        .bind(new Date().toISOString(), obj.payment_intent)
        .run();
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
// Admin
// ---------------------------------------------------------------------------

function requireAdmin(request, env) {
  const header = request.headers.get('authorization') || '';
  const unauthorized = new Response('Authentication required', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="A Little Hill Farm"' },
  });

  if (!header.startsWith('Basic ')) return unauthorized;

  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized;
  }

  const password = decoded.slice(decoded.indexOf(':') + 1);
  if (!env.ADMIN_PASSWORD || !timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    return unauthorized;
  }
  return null;
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

  if (path === '/api/admin/sales') {
    const status = new URL(request.url).searchParams.get('status');
    const q = status
      ? env.DB.prepare('SELECT * FROM sales WHERE status = ? ORDER BY sold_at DESC LIMIT 500').bind(status)
      : env.DB.prepare('SELECT * FROM sales ORDER BY sold_at DESC LIMIT 500');
    return json({ sales: (await q.all()).results });
  }

  // Everything we sell, with the values actually in effect right now.
  if (path === '/api/admin/products') {
    if (request.method === 'GET') {
      const products = await loadCatalog(env);
      const defaults = new Map(catalog.products.map((p) => [p.id, p]));
      return json({
        products: products.map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          supplier: p.supplier,
          unit: p.unit,
          category: p.category,
          image: p.image || '',
          active: !!p.active,
          price_cents: p.price_cents,
          cost_cents: p.cost_cents,
          freight_cents: p.freight_cents,
          // The committed products.json values, so the form can show what
          // clearing a field would actually fall back to.
          default_active: !!(defaults.get(p.id) || {}).active,
          default_price_cents: (defaults.get(p.id) || {}).price_cents,
          default_cost_cents: (defaults.get(p.id) || {}).cost_cents,
          default_freight_cents: (defaults.get(p.id) || {}).freight_cents,
          // What is left after cost and freight. Negative means we lose money.
          margin_cents: p.price_cents - (p.cost_cents || 0) - (p.freight_cents || 0),
          note: p.note || '',
        })),
      });
    }

    const b = await request.json();
    const known = catalog.products.some((p) => p.id === b.product_id);
    if (!known) return json({ error: 'unknown product: ' + b.product_id }, 400);

    // Money must be a whole number of cents and never negative. A stray
    // decimal or minus sign here would follow straight through to a charge.
    const money = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100000000) {
        throw new BadRequest('amounts must be a whole number of cents, zero or more');
      }
      return n;
    };

    let price, cost, freight;
    try {
      price = money(b.price_cents);
      cost = money(b.cost_cents);
      freight = money(b.freight_cents);
    } catch (err) {
      return json({ error: err.message }, 400);
    }

    // A misplaced decimal point is the most expensive mistake this form can
    // make. Typing 5300 for 53.00 is merely embarrassing — nobody buys it. But
    // 0.53 for 53.00 sells $53 feed for 53 cents, and those orders are binding.
    // The negative-margin warning does not catch it while costs are still zero,
    // so guard on the size of the change instead.
    if (price != null) {
      const current = (await loadCatalog(env)).find((p) => p.id === b.product_id);
      const before = current ? current.price_cents : null;
      const wild = before > 0 && price > 0 && (price > before * 5 || price * 5 < before);
      if (wild && b.confirm !== true) {
        return json(
          {
            error:
              'price_change_needs_confirmation',
            message:
              'That changes the price from $' + (before / 100).toFixed(2) +
              ' to $' + (price / 100).toFixed(2) +
              '. Check the decimal point, then confirm to save.',
            before_cents: before,
            after_cents: price,
          },
          409
        );
      }
    }

    // Only a path we issued from /api/admin/upload is accepted. Anything else
    // would let the admin form point a product at an arbitrary URL.
    let image = null;
    if (b.image) {
      if (!/^\/media\/[a-f0-9-]{8,}\.(jpg|png|gif|webp)$/.test(String(b.image))) {
        return json({ error: 'image must be an uploaded file path' }, 400);
      }
      image = String(b.image);
    }

    await env.DB.prepare(
      'INSERT INTO product_settings (product_id, active, price_cents, cost_cents, freight_cents, image, note, updated_at)' +
        ' VALUES (?,?,?,?,?,?,?,?)' +
        ' ON CONFLICT(product_id) DO UPDATE SET' +
        ' active=excluded.active, price_cents=excluded.price_cents,' +
        ' cost_cents=excluded.cost_cents, freight_cents=excluded.freight_cents,' +
        ' image=excluded.image, note=excluded.note, updated_at=excluded.updated_at'
    )
      .bind(
        b.product_id,
        b.active === null || b.active === undefined ? null : b.active ? 1 : 0,
        price,
        cost,
        freight,
        image,
        b.note ? String(b.note).slice(0, 200) : null,
        new Date().toISOString()
      )
      .run();

    return json({ ok: true });
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
        " WHERE status IN ('captured','recorded') AND sold_at >= ? AND sold_at < ?"
    )
      .bind(from, to)
      .first();

    const byCategory = await env.DB.prepare(
      'SELECT category, COUNT(*) AS n,' +
        ' COALESCE(SUM(total_cents),0) AS total_cents,' +
        ' COALESCE(SUM(cogs_cents),0)  AS cogs_cents' +
        ' FROM sales' +
        " WHERE status IN ('captured','recorded') AND sold_at >= ? AND sold_at < ?" +
        ' GROUP BY category ORDER BY total_cents DESC'
    )
      .bind(from, to)
      .all();

    return json({
      period: { from, to },
      ...row,
      // Schedule F wants revenue and COGS separately. Revenue excludes the
      // sales tax we collected on the state's behalf — that is not income.
      revenue_cents: row.subtotal_cents,
      gross_margin_cents: row.subtotal_cents - row.cogs_cents,
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

      return json({ ok: true, captured_cents: captured, adjusted: true });
    }

    await env.DB.prepare("UPDATE sales SET status = 'captured' WHERE id = ?").bind(sale_id).run();
    return json({ ok: true, captured_cents: captured });
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
