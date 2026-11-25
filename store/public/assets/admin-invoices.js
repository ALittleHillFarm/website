/* Admin — New invoice tab.
 * ---------------------------------------------------------------------
 * For phone and bulk orders: pick the customer, add items (any product,
 * including ones hidden from the storefront such as totes; change a price;
 * or add a free-text line like freight), choose pickup, and send. The
 * customer gets an email with a "Pay invoice" link (worker.js, Invoices).
 * Totals shown here come from the server, so they always match the bill.
 */
(function () {
  'use strict';

  var host = document.getElementById('invoice-app');
  var tab = document.getElementById('tab-invoice');
  if (!host || !tab) return;

  var state = { products: [], customers: [], pastOnly: [], pickups: [], lines: [], recent: [], other: [], newItem: null, recentFor: '', noEmailKey: '', loaded: false, loading: null, busy: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // A customer with no email is kept under a made-up address (see lib/customers.js). It rides along
  // as a hidden key so the invoice goes to the right customer, and is never shown or typed.
  var NO_EMAIL = /@no-email\.invalid$/i;
  function isKey(e) { return NO_EMAIL.test(String(e || '')); }
  function digitsOf(v) { return String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function money(c) { return '$' + (Math.round(Number(c) || 0) / 100).toFixed(2); }
  function cents(v) {
    var s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    if (s === '') return null;
    var n = Math.round(parseFloat(s) * 100);
    return isFinite(n) ? n : NaN;
  }
  function getJSON(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('Request failed (' + r.status + ')'));
        return d;
      });
    });
  }
  function post(body) {
    return getJSON('/api/admin/invoice', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }
  function productLabel(p) {
    return p.name + (p.unit ? ' (' + p.unit + ')' : '') + ' — ' + money(p.price_cents) + (p.active ? '' : ' · hidden from store');
  }

  function load() {
    if (state.loaded) return Promise.resolve();
    if (state.loading) return state.loading;
    host.innerHTML = '<p class="lede">Loading…</p>';
    state.loading = Promise.all([
      getJSON('/api/admin/products'), getJSON('/api/admin/customers?detail=1'), getJSON('/api/config'),
    ]).then(function (r) {
      state.products = (r[0].products || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
      state.customers = r[1].customers || [];
      state.pastOnly = r[1].history_only || [];
      state.pickups = r[2].pickup_locations || [];
      state.loaded = true;
      if (!state.lines.length) state.lines.push({ product_id: '', qty: 1, price: '' });
      render();
    }).catch(function (err) {
      host.innerHTML = '<p class="alert error">' + esc(err.message) + '</p>';
    }).then(function () { state.loading = null; });
    return state.loading;
  }

  function lineRow(l, i) {
    var custom = l.custom;
    var p = !custom && state.products.filter(function (x) { return x.id === l.product_id; })[0];
    var what = custom
      ? '<input type="text" data-i="' + i + '" data-k="name" value="' + esc(l.name || '') + '" placeholder="e.g. Freight from Reno" aria-label="Description">'
      : '<input type="text" list="inv-products" data-i="' + i + '" data-k="pick" value="' + esc(p ? productLabel(p) : '') + '" placeholder="Type to find a product…" aria-label="Product">';
    return '<div class="inv-line">' +
      '<div class="field what">' + what + '</div>' +
      '<div class="field inv-qty"><input type="number" min="1" step="1" data-i="' + i + '" data-k="qty" value="' + esc(l.qty) + '" aria-label="Quantity"></div>' +
      '<div class="field price"><input type="text" inputmode="decimal" data-i="' + i + '" data-k="price" value="' + esc(l.price) + '" placeholder="' +
        (custom ? 'Price each' : (p ? (p.price_cents / 100).toFixed(2) : 'Price')) + '" aria-label="Price each"></div>' +
      (custom ? '<label class="tax"><input type="checkbox" data-i="' + i + '" data-k="taxable"' + (l.taxable ? ' checked' : '') + '> Taxable</label>' : '<span class="tax"></span>') +
      '<button type="button" class="btn ghost small" data-act="remove" data-i="' + i + '" aria-label="Remove line">✕</button>' +
    '</div>';
  }

  function render() {
    host.innerHTML =
      '<datalist id="inv-products">' + state.products.map(function (p) { return '<option value="' + esc(productLabel(p)) + '">'; }).join('') + '</datalist>' +
      '<datalist id="inv-customers">' + state.customers.map(function (c) { return '<option value="' + esc(c.email) + '">' + esc(c.name || '') + '</option>'; }).join('') + '</datalist>' +
      '<datalist id="inv-names">' + state.customers.filter(function (c) { return c.name; }).map(function (c) { return '<option value="' + esc(c.name) + '">' + esc(c.email) + '</option>'; }).join('') + '</datalist>' +
      '<div id="inv-msg"></div>' +
      '<fieldset class="goat-set"><legend>Customer</legend><div class="form-grid">' +
        '<div class="field span2 inv-find"><label for="inv-find">Find a customer</label>' +
          '<input type="text" id="inv-find" autocomplete="off" placeholder="Type part of a name, email or phone" role="combobox" aria-expanded="false" aria-controls="inv-find-results">' +
          '<div id="inv-find-results" class="find-results" role="listbox" hidden></div></div>' +
        '<div class="field"><label for="inv-name">Name</label><input type="text" id="inv-name" list="inv-names" autocomplete="off" placeholder="Start typing a name"></div>' +
        '<div class="field"><label for="inv-email">Email</label><input type="email" id="inv-email" list="inv-customers" autocomplete="off" placeholder="or an email — leave empty if they have none"></div>' +
        '<div class="field"><label for="inv-phone">Phone</label><input type="tel" id="inv-phone"></div>' +
        '<div class="field"><label for="inv-pickup">Pickup</label><select id="inv-pickup">' +
          state.pickups.map(function (l) { return '<option value="' + esc(l.id) + '">' + esc(l.label) + '</option>'; }).join('') + '</select></div>' +
      '</div><div class="hint" id="inv-cust-note"></div></fieldset>' +
      '<fieldset class="goat-set"><legend>Items</legend>' +
        '<div class="field inv-find"><label for="inv-item-find">Find an item to add</label>' +
          '<input type="text" id="inv-item-find" autocomplete="off" placeholder="Type part of a name, size or SKU — items hidden from the store are included" role="combobox" aria-expanded="false" aria-controls="inv-item-results">' +
          '<div id="inv-item-results" class="find-results" role="listbox" hidden></div></div>' +
        '<div id="inv-newitem"></div>' +
        '<div id="inv-recent"></div>' +
        '<div class="inv-head"><span>Product or description</span><span>Qty</span><span>Price each</span><span></span><span></span></div>' +
        state.lines.map(lineRow).join('') +
        '<p style="margin:10px 0 14px"><button type="button" class="btn ghost small" data-act="add">Add a product</button> ' +
        '<button type="button" class="btn ghost small" data-act="add-custom">Add freight or other charge</button></p>' +
        '<div class="hint">Leave “Price each” empty to use the store price. Products marked “hidden from store” (like totes) can only be ordered this way.</div>' +
      '</fieldset>' +
      '<fieldset class="goat-set"><legend>Note to the customer (optional)</legend>' +
        '<div class="field"><textarea id="inv-note" rows="2" placeholder="e.g. Tote arrives the week of Oct 20 — we will call to set up pickup."></textarea></div></fieldset>' +
      '<div class="inv-totals" id="inv-totals"><p class="hint">Add items to see the totals.</p></div>' +
      '<label class="send-now-row"><input type="checkbox" id="inv-sendnow" checked> ' +
        '<span><strong>Email it to the customer now</strong> <span class="muted">— untick to save it without sending; you can send it later from the Orders tab.</span></span></label>' +
      '<div class="goat-save"><button type="button" class="btn" data-act="create" id="inv-create">Create invoice</button>' +
        '<span id="inv-status" aria-live="polite"></span></div>';
  }

  function collect() {
    var lines = state.lines.map(function (l) {
      var price = cents(l.price);
      if (l.custom) return { name: l.name, qty: Number(l.qty), price_cents: price, taxable: !!l.taxable };
      return { product_id: l.product_id, qty: Number(l.qty), price_cents: price };
    }).filter(function (l) { return l.product_id || l.name; });
    return {
      customer: {
        email: document.getElementById('inv-email').value.trim() || state.noEmailKey || '',
        name: document.getElementById('inv-name').value.trim(),
        phone: document.getElementById('inv-phone').value.trim(),
      },
      pickup: document.getElementById('inv-pickup').value,
      note: document.getElementById('inv-note').value,
      send: document.getElementById('inv-sendnow') ? document.getElementById('inv-sendnow').checked : true,
      lines: lines,
    };
  }

  var previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 350);
  }
  function preview() {
    var b = collect();
    var box = document.getElementById('inv-totals');
    if (!box) return;
    if (!b.lines.length || !b.customer.name) {
      box.innerHTML = '<p class="hint">Fill in the customer and at least one item to see the totals.</p>';
      return;
    }
    b.action = 'preview';
    post(b).then(function (r) {
      box.innerHTML =
        '<div class="row"><span>Subtotal</span><span>' + money(r.card.subtotal_cents) + '</span></div>' +
        '<div class="row"><span>Idaho sales tax' + (r.tax_exempt ? ' (customer is tax-exempt)' : '') + '</span><span>' + money(r.card.tax_cents) + '</span></div>' +
        '<div class="row total"><span>Total</span><span>' + money(r.card.total_cents) + '</span></div>';
    }).catch(function (err) {
      box.innerHTML = '<p class="alert error">' + esc(err.message) + '</p>';
    });
  }

  var EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  // `settled` = they finished typing (left the box), so an email we have never
  // heard of is worth looking up in the purchase history too.
  function fillCustomer(from, settled) {
    var emailBox = document.getElementById('inv-email');
    var nameBox = document.getElementById('inv-name');
    if (from === 'name') {
      var typed = nameBox.value.trim().toLowerCase();
      var byName = state.customers.filter(function (x) { return (x.name || '').toLowerCase() === typed; });
      if (byName.length === 1) {
        state.noEmailKey = isKey(byName[0].email) ? byName[0].email : '';
        emailBox.value = state.noEmailKey ? '' : byName[0].email;
        document.getElementById('inv-phone').value = byName[0].phone || '';
      }
    }
    var email = emailBox.value.trim().toLowerCase() || state.noEmailKey;
    var c = state.customers.filter(function (x) { return x.email === email; })[0];
    var past = !c && state.pastOnly.filter(function (x) { return String(x.email).toLowerCase() === email; })[0];
    loadRecent(c || past || (settled && EMAIL.test(email)) ? email : '');
    var note = document.getElementById('inv-cust-note');
    if (c) {
      if (!document.getElementById('inv-name').value) document.getElementById('inv-name').value = c.name || '';
      if (!document.getElementById('inv-phone').value) document.getElementById('inv-phone').value = c.phone || '';
      note.textContent = 'Known customer' + (c.tax_exempt ? ' · tax-exempt' : '') + (c.trusted ? ' · established' : '') +
        (isKey(c.email) ? ' · no email on file, so the invoice is saved and you copy the pay link to text it.' : '.');
    } else if (past) {
      note.textContent = 'Bought on Shopify before (' + past.lines + (past.lines === 1 ? ' line' : ' lines') + '). Their name is not on file — old purchases keep only the email — so type it above; ' +
        'they will be saved as a customer when you create the invoice. (Importing your Shopify customer list in the Customers tab fills names in for everyone.)';
    } else if (email) {
      note.textContent = 'New customer — they will be saved when you create the invoice.';
    } else {
      var named = document.getElementById('inv-name').value.trim(), phoned = digitsOf(document.getElementById('inv-phone').value).length >= 10;
      note.textContent = named ? (phoned ? 'No email: they will be saved by name and phone, and you copy the pay link to text it.'
        : 'No email: add their phone number so they can be saved and told apart.') : '';
    }
    // "Email it now" means nothing for someone with no email: grey it out rather than leave it ticked.
    var sendBox = document.getElementById('inv-sendnow');
    if (sendBox) {
      var none = !emailBox.value.trim() && (!!state.noEmailKey || !!document.getElementById('inv-name').value.trim());
      sendBox.disabled = none;
      if (sendBox.parentNode) sendBox.parentNode.style.opacity = none ? '0.55' : '';
    }
  }

  // ---- finding a customer: any part of a name, email or phone ----------------
  var digitsOf = function (v) { return String(v || '').replace(/\D/g, ''); };
  function people() {
    return state.customers.map(function (c) {
      return { email: c.email, name: c.name || '', phone: c.phone || '', orders: c.paid_orders || 0, lines: c.history_lines || 0, saved: true, noEmail: isKey(c.email) };
    }).concat(state.pastOnly.map(function (h) {
      return { email: String(h.email).toLowerCase(), name: '', phone: '', orders: 0, lines: h.lines || 0, saved: false };
    }));
  }
  function findPeople(q) {
    var words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return people().filter(function (p) {
      var hay = (p.name + ' ' + (p.noEmail ? '' : p.email) + ' ' + p.phone).toLowerCase(), ph = digitsOf(p.phone);
      return words.every(function (w) { return hay.indexOf(w) !== -1 || (digitsOf(w).length >= 3 && ph.indexOf(digitsOf(w)) !== -1); });
    }).sort(function (a, b) {
      var sa = (a.name + ' ' + a.email).toLowerCase().indexOf(words[0]) === 0 ? 0 : 1;
      var sb = (b.name + ' ' + b.email).toLowerCase().indexOf(words[0]) === 0 ? 0 : 1;
      return sa - sb || (a.name || a.email).toLowerCase().localeCompare((b.name || b.email).toLowerCase());
    });
  }
  function showFound(q) {
    var box = document.getElementById('inv-find-results'), input = document.getElementById('inv-find');
    if (!box) return;
    var all = findPeople(q), hits = all.slice(0, 8);
    if (!String(q || '').trim()) { box.hidden = true; box.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); return; }
    box.innerHTML = hits.length ? hits.map(function (p) {
      var bits = [p.name && !p.noEmail ? p.email : '', p.noEmail ? 'no email' : '', p.phone, p.orders ? p.orders + (p.orders === 1 ? ' paid order' : ' paid orders') : '',
        p.lines ? p.lines + ' old Shopify ' + (p.lines === 1 ? 'line' : 'lines') : '', p.saved ? '' : 'Shopify purchases only · name not on file'].filter(Boolean);
      return '<button type="button" class="find-hit" role="option" data-pick="' + esc(p.email) + '"><strong>' + esc(p.name || (p.noEmail ? '(no name)' : p.email)) + '</strong>' +
        '<span class="muted">' + esc(bits.join(' · ')) + '</span></button>';
    }).join('') + (all.length > hits.length ? '<div class="find-more muted">' + (all.length - hits.length) + ' more — keep typing to narrow it down</div>' : '')
      : '<div class="find-more muted">No one matches. Type their name and email below to add a new customer.</div>';
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function pickPerson(email) {
    var p = people().filter(function (x) { return x.email === email; })[0];
    if (!p) return;
    state.noEmailKey = p.noEmail ? p.email : '';
    document.getElementById('inv-name').value = p.name;
    document.getElementById('inv-email').value = p.noEmail ? '' : p.email;
    document.getElementById('inv-phone').value = p.phone;
    document.getElementById('inv-find').value = '';
    showFound('');
    fillCustomer('email', true);
    schedulePreview();
    var next = !p.name ? document.getElementById('inv-name') : host.querySelector('input[data-k="pick"]');
    if (next) next.focus();
  }

  // ---- finding an item, or creating one that is not there yet ---------------------
  function findItems(q) {
    var words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return state.products.filter(function (p) {
      var hay = ((p.name || '') + ' ' + (p.unit || '') + ' ' + (p.sku || '')).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    }).sort(function (a, b) {
      var sa = (a.name || '').toLowerCase().indexOf(words[0]) === 0 ? 0 : 1, sb = (b.name || '').toLowerCase().indexOf(words[0]) === 0 ? 0 : 1;
      return sa - sb || (a.name || '').localeCompare(b.name || '');
    });
  }
  function showItems(q) {
    var box = document.getElementById('inv-item-results'), input = document.getElementById('inv-item-find');
    if (!box) return;
    var typed = String(q || '').trim();
    if (!typed) { box.hidden = true; box.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); return; }
    var all = findItems(typed), hits = all.slice(0, 8);
    box.innerHTML = hits.map(function (p) {
      var bits = [money(p.price_cents), p.sku || '', p.archived ? 'archived' : (p.active ? '' : 'hidden from the store')].filter(Boolean);
      return '<button type="button" class="find-hit" role="option" data-item="' + esc(p.id) + '"><strong>' + esc(p.name + (p.unit ? ' (' + p.unit + ')' : '')) + '</strong>' +
        '<span class="muted">' + esc(bits.join(' · ')) + '</span></button>';
    }).join('') + (all.length > hits.length ? '<div class="find-more muted">' + (all.length - hits.length) + ' more — keep typing to narrow it down</div>' : '') +
      '<button type="button" class="find-hit find-new" data-newitem="' + esc(typed) + '"><strong>+ Create “' + esc(typed) + '” as a new item…</strong>' +
        '<span class="muted">for something you sell that is not in the list</span></button>';
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function pickItem(id) {
    var keep = collect();
    // Drop the empty starter line before adding the first real one.
    state.lines = state.lines.filter(function (l) { return l.product_id || l.name || l.custom; });
    state.lines.push({ product_id: id, qty: 1, price: '' });
    rerenderKeeping(keep);
    var qtys = host.querySelectorAll('input[data-k="qty"]');
    var last = qtys[qtys.length - 1];
    if (last) { last.focus(); last.select(); }
  }

  function newItemFields() {
    var n = state.newItem;
    return '<fieldset class="goat-set"><legend>New item</legend><div class="form-grid">' +
      '<div class="field"><label for="ni-name">Name</label><input type="text" id="ni-name" maxlength="120" value="' + esc(n.name) + '" placeholder="e.g. Organic Olive Oil Layer Feed"></div>' +
      '<div class="field"><label for="ni-unit">Size</label><input type="text" id="ni-unit" maxlength="40" value="' + esc(n.unit) + '" placeholder="e.g. 1000 lb tote"></div>' +
      '<div class="field"><label for="ni-price">Price ($)</label><input type="text" id="ni-price" inputmode="decimal" value="' + esc(n.price) + '" placeholder="0.00"></div>' +
      '<div class="field"><label for="ni-cost">Cost ($) <span class="lbl-note">optional</span></label><input type="text" id="ni-cost" inputmode="decimal" value="' + esc(n.cost) + '" placeholder="0.00"></div>' +
      '</div>' +
      '<div class="check-row" style="margin-bottom:10px"><input type="checkbox" id="ni-taxable"' + (n.taxable ? ' checked' : '') + '><label for="ni-taxable">Charge Idaho sales tax on it</label></div>' +
      '<div class="check-row" style="margin-bottom:8px"><input type="checkbox" id="ni-show"' + (n.show ? ' checked' : '') + '><label for="ni-show">Show it on the store website <span class="lbl-note">needs a price</span></label></div>' +
      '<p class="hint" style="margin:0 0 12px">Left unticked, it stays off the website. Every item, shown or hidden, can go on any invoice. You can change this later in the Products tab.</p>' +
      '<p><button type="button" class="btn" data-act="newitem-save">Create item and add it to this invoice</button> ' +
        '<button type="button" class="btn ghost" data-act="newitem-cancel">Cancel</button> <span id="ni-status" aria-live="polite"></span></p></fieldset>';
  }
  function renderNewItem() {
    var box = document.getElementById('inv-newitem');
    if (box) box.innerHTML = state.newItem ? newItemFields() : '';
  }
  function openNewItem(start) {
    var f = document.getElementById('inv-item-find');
    if (f) f.value = '';
    showItems('');
    state.newItem = { name: start.name || '', unit: start.unit || '', price: start.price || '', cost: '', taxable: true, show: false, qty: start.qty || 1, other: start.other || '' };
    renderNewItem();
    var first = document.getElementById(start.name ? 'ni-price' : 'ni-name');
    if (first) { first.focus(); if (first.select) first.select(); }
  }
  function saveNewItemField(t) {
    if (!state.newItem) return;
    var map = { 'ni-name': 'name', 'ni-unit': 'unit', 'ni-price': 'price', 'ni-cost': 'cost' };
    if (map[t.id]) state.newItem[map[t.id]] = t.value;
    if (t.id === 'ni-taxable') state.newItem.taxable = t.checked;
    if (t.id === 'ni-show') state.newItem.show = t.checked;
  }
  function createItem(btn) {
    var n = state.newItem, st = document.getElementById('ni-status');
    if (!n || state.busy) return;
    var price = cents(n.price), cost = cents(n.cost);
    if (!String(n.name).trim()) { st.textContent = 'Give it a name first.'; return; }
    if (price === null || isNaN(price) || isNaN(cost)) { st.textContent = 'Enter the price as a plain amount like 12.50 (cost is optional).'; return; }
    if (n.show && !(price > 0)) { st.textContent = 'Enter a price above $0 before showing it on the website, or untick that box.'; return; }
    state.busy = true; btn.disabled = true; st.textContent = 'Creating…';
    var made = null;
    getJSON('/api/admin/products', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', fields: { name: n.name, unit: n.unit, price_cents: price, cost_cents: cost || 0, taxable: !!n.taxable, active: !!n.show } }),
    }).then(function (r) {
      made = r;
      return getJSON('/api/admin/products');
    }).then(function (r) {
      state.products = (r.products || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
      var keep = collect();
      state.lines = state.lines.filter(function (l) { return (l.product_id || l.name || l.custom) && !(n.other && l.other === n.other); });
      state.lines.push({ product_id: made.id, qty: n.qty || 1, price: '' });
      var shown = !!n.show, label = n.name + (n.unit ? ' (' + n.unit + ')' : '');
      state.newItem = null;
      rerenderKeeping(keep);
      document.getElementById('inv-msg').innerHTML = '<p class="alert success">Created “' + esc(label) + '” and added it to this invoice. ' +
        (shown ? 'It is on the store website now.' : 'It is hidden from the store website, so it only appears on invoices. Tick “Show in store” in the Products tab to put it on the website.') + '</p>';
    }).catch(function (err) {
      st.textContent = 'Not created: ' + err.message;
    }).then(function () { state.busy = false; btn.disabled = false; });
  }

  // ---- recent purchases: tick to add, untick to remove ----------------------
  function renderRecent() {
    var box = document.getElementById('inv-recent');
    if (!box) return;
    if (!state.recent.length && !state.other.length) { box.innerHTML = ''; return; }
    var html = '';
    if (state.recent.length) {
      html += '<div class="inv-recent"><div class="label">Recent purchases — tick to add</div>' +
        state.recent.map(function (r, i) {
          var on = state.lines.some(function (l) { return l.recent === r.product_id; });
          return '<label class="check-row"><input type="checkbox" data-recent="' + i + '"' + (on ? ' checked' : '') + '> ' +
            '<span><strong>' + esc(r.name) + '</strong>' + (r.unit ? ' (' + esc(r.unit) + ')' : '') +
            ' <span class="muted">— last ' + esc(r.last_date) + ': ' + esc(r.last_qty) + ' at ' + money(r.last_price_cents) +
            (r.price_cents !== r.last_price_cents ? ' · now ' + money(r.price_cents) : '') + (r.active ? '' : ' · hidden from store') +
            '</span></span></label>';
        }).join('') + '</div>';
    }
    if (state.other.length) {
      html += '<div class="inv-recent"><div class="label">Bought before, but not in your item list — tick to add as a typed-in line</div>' +
        state.other.map(function (o, i) {
          var on = state.lines.some(function (l) { return l.other === otherKey(o); });
          return '<label class="check-row"><input type="checkbox" data-other="' + i + '"' + (on ? ' checked' : '') + '> ' +
            '<span><strong>' + esc(o.name) + '</strong>' + (o.unit ? ' (' + esc(o.unit) + ')' : '') +
            ' <span class="muted">— last ' + esc(o.last_date) + ': ' + esc(o.last_qty) + ' at ' + money(o.last_price_cents) + '</span> ' +
            '<button type="button" class="link-btn" data-act="newitem-from" data-other-i="' + i + '">Add it to your items</button></span></label>';
        }).join('') + '</div>';
    }
    box.innerHTML = html;
  }
  function otherKey(o) { return (o.name + '|' + (o.unit || '')).toLowerCase(); }
  function loadRecent(email) {
    if (email === state.recentFor) return;
    state.recentFor = email;
    state.recent = []; state.other = [];
    renderRecent();
    if (!email) return;
    getJSON('/api/admin/customer-history?email=' + encodeURIComponent(email)).then(function (r) {
      if (state.recentFor !== email) return;
      state.recent = r.items || [];
      state.other = r.other || [];
      renderRecent();
    }).catch(function () {});
  }

  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // The result of creating an invoice, in words: was it emailed or not, and
  // what to do about it.
  function resultPanel(r) {
    var linkRow = '<div class="link-row"><code>' + esc(r.link) + '</code> ' +
      '<button type="button" class="btn small ghost" data-act="copylink" data-link="' + esc(r.link) + '">Copy pay link</button></div>';
    if (r.no_email) {
      return '<div class="inv-result warn"><div class="t">Invoice ' + esc(r.ref) + ' saved — no email on file</div>' +
        'Nothing was emailed. Copy the pay link below and text it to them, or hand it over at pickup. If you get their email later, press ' +
        '<strong>Add email &amp; send</strong> on the <strong>Orders</strong> tab.' + linkRow + '</div>';
    }
    if (r.emailed) {
      return '<div class="inv-result"><div class="t">Invoice ' + esc(r.ref) + ' emailed</div>' +
        'Emailed to <strong>' + esc(r.to) + '</strong> at ' + esc(when(r.sent_at)) + '. ' +
        'If they say it did not arrive, ask them to check their junk/spam folder, or copy the pay link and text it.' + linkRow + '</div>';
    }
    if (r.email_requested) {
      return '<div class="inv-result bad"><div class="t">Invoice ' + esc(r.ref) + ' saved, but the email did NOT go out</div>' +
        'The customer has not received it (' + esc(r.email_error || 'unknown error') + '). ' +
        'Nothing is lost: on the <strong>Orders</strong> tab it is marked “Email failed” with a <strong>Send now</strong> button to try again. ' +
        'Or copy the pay link below and text it to them.' + linkRow + '</div>';
    }
    return '<div class="inv-result warn"><div class="t">Invoice ' + esc(r.ref) + ' saved — NOT sent</div>' +
      'The customer does not know about this invoice yet. When you are ready, open the <strong>Orders</strong> tab and press <strong>Send now</strong>, ' +
      'or copy the pay link and text it.' + linkRow + '</div>';
  }

  function submit(btn) {
    if (state.busy) return;
    var b = collect();
    var noEmail = !b.customer.email || isKey(b.customer.email);
    var send = document.getElementById('inv-sendnow').checked && !noEmail;
    var status = document.getElementById('inv-status');
    if (!b.customer.email && digitsOf(b.customer.phone).length < 10) {
      status.textContent = 'Enter their email, or their phone number if they have no email.';
      return;
    }
    b.action = 'create';
    b.send = send;
    if (send && !window.confirm('Create this invoice and email it to ' + (b.customer && b.customer.email ? b.customer.email : 'the customer') + ' now?')) return;
    state.busy = true;
    btn.disabled = true;
    status.textContent = send ? 'Creating and emailing…' : 'Creating…';
    post(b).then(function (r) {
      state.lines = [{ product_id: '', qty: 1, price: '' }];
      state.loaded = false;
      state.noEmailKey = '';
      state.newItem = null;
      return load().then(function () {
        document.getElementById('inv-msg').innerHTML = resultPanel(r);
        host.scrollIntoView({ behavior: 'smooth' });
      });
    }).catch(function (err) {
      status.textContent = 'Not created: ' + err.message;
    }).then(function () { state.busy = false; btn.disabled = false; });
  }

  // ---- events ---------------------------------------------------------------
  tab.addEventListener('click', load);
  // The Customers tab added, changed or removed someone: fetch the list again next time.
  document.addEventListener('customers-changed', function () { state.loaded = false; });

  // Both finders (customer, item) share one keyboard behaviour: arrows move through the results,
  // Enter takes the first, Escape clears.
  function clearFinder(wrap) {
    var input = wrap.querySelector('input[type="text"]');
    if (input) input.value = '';
    if (input && input.id === 'inv-find') showFound(''); else showItems('');
  }
  host.addEventListener('keydown', function (e) {
    var wrap = e.target.closest && e.target.closest('.inv-find');
    if (!wrap) return;
    var box = wrap.querySelector('.find-results');
    if (!box || box.hidden) return;
    var input = wrap.querySelector('input[type="text"]');
    var hits = Array.prototype.slice.call(box.querySelectorAll('.find-hit'));
    var at = hits.indexOf(e.target);
    if (e.target === input) {
      if (e.key === 'ArrowDown' && hits[0]) { e.preventDefault(); hits[0].focus(); }
      else if (e.key === 'Enter' && hits[0]) { e.preventDefault(); hits[0].click(); }
      else if (e.key === 'Escape') clearFinder(wrap);
    } else if (at >= 0) {
      if (e.key === 'ArrowDown' && hits[at + 1]) { e.preventDefault(); hits[at + 1].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (hits[at - 1] || input).focus(); }
      else if (e.key === 'Escape') { input.focus(); clearFinder(wrap); }
    }
  });
  document.addEventListener('click', function (e) {
    Array.prototype.forEach.call(document.querySelectorAll('.inv-find .find-results'), function (box) {
      var wrap = box.closest('.inv-find');
      if (!box.hidden && !(e.target.closest && e.target.closest('.inv-find') === wrap)) clearFinder(wrap);
    });
  });

  // "Create invoice" on a customer's page: open this tab with them filled in.
  document.addEventListener('invoice-for', function (ev) {
    var who = ev.detail || {};
    var writing = false;
    try { writing = state.loaded && !!document.getElementById('inv-email') && collect().lines.length > 0; } catch (err) { writing = false; }
    if (writing && !window.confirm('Start a new invoice for ' + (who.name || who.email) + '? The invoice you were writing here will be cleared.')) return;
    state.loaded = false;                       // fresh customers, fresh form
    state.noEmailKey = '';
    state.newItem = null;
    state.lines = [{ product_id: '', qty: 1, price: '' }];
    state.recent = []; state.recentFor = '';
    tab.click();
    load().then(function () {
      if (!state.loaded) return;
      state.noEmailKey = isKey(who.email) ? who.email : '';
      document.getElementById('inv-name').value = who.name || '';
      document.getElementById('inv-email').value = state.noEmailKey ? '' : (who.email || '');
      document.getElementById('inv-phone').value = who.phone || '';
      fillCustomer('email', true);
      schedulePreview();
      var next = who.name ? host.querySelector('input[data-k="pick"]') : document.getElementById('inv-name');
      if (next) next.focus();
      host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  host.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'inv-find') return showFound(t.value);
    if (t.id === 'inv-item-find') return showItems(t.value);
    if (t.id && t.id.indexOf('ni-') === 0) return saveNewItemField(t);
    var i = t.getAttribute('data-i');
    if (i != null) {
      var l = state.lines[+i];
      var k = t.getAttribute('data-k');
      if (k === 'pick') {
        var p = state.products.filter(function (x) { return productLabel(x) === t.value; })[0];
        l.product_id = p ? p.id : '';
        if (p) {
          var priceBox = host.querySelector('input[data-i="' + i + '"][data-k="price"]');
          if (priceBox) priceBox.placeholder = (p.price_cents / 100).toFixed(2);
        }
      } else if (k === 'taxable') {
        l.taxable = t.checked;
      } else {
        l[k] = t.value;
      }
    }
    if (t.id === 'inv-email') { state.noEmailKey = ''; fillCustomer('email'); }
    if (t.id === 'inv-name') fillCustomer('name');
    schedulePreview();
  });
  host.addEventListener('change', function (e) {
    // A SKU or part of a name, not the exact list entry: match it and show the full name.
    if (e.target.getAttribute('data-k') === 'pick' && e.target.value.trim() && window.AdminUI) {
      var hit = AdminUI.findProduct(state.products, e.target.value, productLabel);
      if (hit.product) {
        e.target.value = productLabel(hit.product);
        var line = state.lines[+e.target.getAttribute('data-i')];
        line.product_id = hit.product.id;
        var pb = host.querySelector('input[data-i="' + e.target.getAttribute('data-i') + '"][data-k="price"]');
        if (pb) pb.placeholder = (hit.product.price_cents / 100).toFixed(2);
        schedulePreview();
      }
    }
    var oi = e.target.getAttribute('data-other');
    if (oi != null) {
      var old = state.other[+oi], oneKey = otherKey(old), keepO = collect();
      state.lines = state.lines.filter(function (l) { return l.product_id || l.name || l.custom; });
      if (e.target.checked) {
        state.lines.push({ custom: true, name: old.name + (old.unit ? ' (' + old.unit + ')' : ''), qty: old.last_qty || 1,
          price: (old.last_price_cents / 100).toFixed(2), taxable: true, other: oneKey });
      } else state.lines = state.lines.filter(function (l) { return l.other !== oneKey; });
      if (!state.lines.length) state.lines.push({ product_id: '', qty: 1, price: '' });
      rerenderKeeping(keepO);
      return;
    }
    if (e.target.id && e.target.id.indexOf('ni-') === 0) return saveNewItemField(e.target);
    var ri = e.target.getAttribute('data-recent');
    if (ri != null) {
      var r = state.recent[+ri];
      var keep = collect();
      // Drop the empty starter line before adding the first real one.
      state.lines = state.lines.filter(function (l) { return l.product_id || l.name || l.custom; });
      if (e.target.checked) state.lines.push({ product_id: r.product_id, qty: r.last_qty || 1, price: '', recent: r.product_id });
      else state.lines = state.lines.filter(function (l) { return l.recent !== r.product_id; });
      if (!state.lines.length) state.lines.push({ product_id: '', qty: 1, price: '' });
      rerenderKeeping(keep);
      return;
    }
    if (e.target.getAttribute('data-k') === 'taxable') { state.lines[+e.target.getAttribute('data-i')].taxable = e.target.checked; }
    if (e.target.id === 'inv-email') fillCustomer('email', true);
    if (e.target.id === 'inv-name') fillCustomer('name', true);
    schedulePreview();
  });

  host.addEventListener('click', function (e) {
    var pick = e.target.closest && e.target.closest('[data-pick]');
    if (pick) return pickPerson(pick.getAttribute('data-pick'));
    var item = e.target.closest && e.target.closest('[data-item]');
    if (item) return pickItem(item.getAttribute('data-item'));
    var fresh = e.target.closest && e.target.closest('[data-newitem]');
    if (fresh) return openNewItem({ name: fresh.getAttribute('data-newitem') });
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'newitem-save') return createItem(b);
    if (act === 'newitem-cancel') { state.newItem = null; return renderNewItem(); }
    if (act === 'newitem-from') {
      var o = state.other[+b.getAttribute('data-other-i')];
      if (o) openNewItem({ name: o.name, unit: o.unit, price: (o.last_price_cents / 100).toFixed(2), qty: o.last_qty || 1, other: otherKey(o) });
      return;
    }
    var keep = collect();
    if (act === 'add') state.lines.push({ product_id: '', qty: 1, price: '' });
    else if (act === 'add-custom') state.lines.push({ custom: true, name: 'Freight', qty: 1, price: '', taxable: false });
    else if (act === 'remove') state.lines.splice(+b.getAttribute('data-i'), 1);
    else if (act === 'create') return submit(b);
    else if (act === 'copylink') {
      var link = b.getAttribute('data-link');
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () {
        b.textContent = 'Copied ✓';
      }).catch(function () { window.prompt('Copy this pay link:', link); });
      return;
    }
    else return;
    if (!state.lines.length) state.lines.push({ product_id: '', qty: 1, price: '' });
    rerenderKeeping(keep);
  });

  function rerenderKeeping(keep) {
    render();
    document.getElementById('inv-email').value = isKey(keep.customer.email) ? '' : keep.customer.email;
    document.getElementById('inv-name').value = keep.customer.name;
    document.getElementById('inv-phone').value = keep.customer.phone;
    document.getElementById('inv-pickup').value = keep.pickup;
    document.getElementById('inv-note').value = keep.note;
    document.getElementById('inv-sendnow').checked = keep.send;
    fillCustomer('email');
    renderRecent();
    renderNewItem();
    schedulePreview();
  }
})();
