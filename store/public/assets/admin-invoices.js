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

  var state = { products: [], customers: [], pickups: [], lines: [], recent: [], recentFor: '', loaded: false, busy: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
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
    host.innerHTML = '<p class="lede">Loading…</p>';
    return Promise.all([
      getJSON('/api/admin/products'), getJSON('/api/admin/customers'), getJSON('/api/config'),
    ]).then(function (r) {
      state.products = (r[0].products || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
      state.customers = r[1].customers || [];
      state.pickups = r[2].pickup_locations || [];
      state.loaded = true;
      if (!state.lines.length) state.lines.push({ product_id: '', qty: 1, price: '' });
      render();
    }).catch(function (err) {
      host.innerHTML = '<p class="alert error">' + esc(err.message) + '</p>';
    });
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
        '<div class="field"><label for="inv-name">Name</label><input type="text" id="inv-name" list="inv-names" autocomplete="off" placeholder="Start typing a name"></div>' +
        '<div class="field"><label for="inv-email">Email</label><input type="email" id="inv-email" list="inv-customers" autocomplete="off" placeholder="or an email"></div>' +
        '<div class="field"><label for="inv-phone">Phone</label><input type="tel" id="inv-phone"></div>' +
        '<div class="field"><label for="inv-pickup">Pickup</label><select id="inv-pickup">' +
          state.pickups.map(function (l) { return '<option value="' + esc(l.id) + '">' + esc(l.label) + '</option>'; }).join('') + '</select></div>' +
      '</div><div class="hint" id="inv-cust-note"></div></fieldset>' +
      '<fieldset class="goat-set"><legend>Items</legend>' +
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
      '<div class="goat-save"><button type="button" class="btn" data-act="send">Create &amp; email invoice</button>' +
        '<button type="button" class="btn ghost" data-act="create">Create without emailing</button>' +
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
        email: document.getElementById('inv-email').value.trim(),
        name: document.getElementById('inv-name').value.trim(),
        phone: document.getElementById('inv-phone').value.trim(),
      },
      pickup: document.getElementById('inv-pickup').value,
      note: document.getElementById('inv-note').value,
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
    if (!b.lines.length || !b.customer.email || !b.customer.name) {
      box.innerHTML = '<p class="hint">Fill in the customer and at least one item to see the totals.</p>';
      return;
    }
    b.action = 'preview';
    post(b).then(function (r) {
      box.innerHTML =
        '<div class="row"><span>Subtotal</span><span>' + money(r.card.subtotal_cents) + '</span></div>' +
        '<div class="row"><span>Idaho sales tax' + (r.tax_exempt ? ' (customer is tax-exempt)' : '') + '</span><span>' + money(r.card.tax_cents) + '</span></div>' +
        '<div class="row total"><span>Total by card</span><span>' + money(r.card.total_cents) + '</span></div>' +
        '<div class="row total"><span>Total by bank transfer or cash (2% off)</span><span>' + money(r.ach.total_cents) + '</span></div>';
    }).catch(function (err) {
      box.innerHTML = '<p class="alert error">' + esc(err.message) + '</p>';
    });
  }

  function fillCustomer(from) {
    var emailBox = document.getElementById('inv-email');
    var nameBox = document.getElementById('inv-name');
    if (from === 'name') {
      var typed = nameBox.value.trim().toLowerCase();
      var byName = state.customers.filter(function (x) { return (x.name || '').toLowerCase() === typed; });
      if (byName.length === 1) { emailBox.value = byName[0].email; document.getElementById('inv-phone').value = byName[0].phone || ''; }
    }
    var email = emailBox.value.trim().toLowerCase();
    var c = state.customers.filter(function (x) { return x.email === email; })[0];
    loadRecent(c ? c.email : '');
    var note = document.getElementById('inv-cust-note');
    if (c) {
      if (!document.getElementById('inv-name').value) document.getElementById('inv-name').value = c.name || '';
      if (!document.getElementById('inv-phone').value) document.getElementById('inv-phone').value = c.phone || '';
      note.textContent = 'Known customer' + (c.tax_exempt ? ' · tax-exempt' : '') + (c.trusted ? ' · established' : '') + '.';
    } else {
      note.textContent = email ? 'New customer — they will be saved when you create the invoice.' : '';
    }
  }

  // ---- recent purchases: tick to add, untick to remove ----------------------
  function renderRecent() {
    var box = document.getElementById('inv-recent');
    if (!box) return;
    if (!state.recent.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="inv-recent"><div class="label">Recent purchases — tick to add</div>' +
      state.recent.map(function (r, i) {
        var on = state.lines.some(function (l) { return l.recent === r.product_id; });
        return '<label class="check-row"><input type="checkbox" data-recent="' + i + '"' + (on ? ' checked' : '') + '> ' +
          '<span><strong>' + esc(r.name) + '</strong>' + (r.unit ? ' (' + esc(r.unit) + ')' : '') +
          ' <span class="muted">— last ' + esc(r.last_date) + ': ' + esc(r.last_qty) + ' at ' + money(r.last_price_cents) +
          (r.price_cents !== r.last_price_cents ? ' · now ' + money(r.price_cents) : '') + (r.active ? '' : ' · hidden from store') +
          '</span></span></label>';
      }).join('') + '</div>';
  }
  function loadRecent(email) {
    if (email === state.recentFor) return;
    state.recentFor = email;
    state.recent = [];
    renderRecent();
    if (!email) return;
    getJSON('/api/admin/customer-history?email=' + encodeURIComponent(email)).then(function (r) {
      if (state.recentFor !== email) return;
      state.recent = r.items || [];
      renderRecent();
    }).catch(function () {});
  }

  function submit(send, btn) {
    if (state.busy) return;
    var b = collect();
    b.action = 'create';
    b.send = send;
    var status = document.getElementById('inv-status');
    state.busy = true;
    btn.disabled = true;
    status.textContent = send ? 'Creating and emailing…' : 'Creating…';
    post(b).then(function (r) {
      state.lines = [{ product_id: '', qty: 1, price: '' }];
      state.loaded = false;
      return load().then(function () {
        document.getElementById('inv-msg').innerHTML =
          '<p class="alert success">Invoice ' + esc(r.ref) + ' created' +
          (r.emailed ? ' and emailed.' : (send ? ' — but the email did not send (' + esc(r.email_error || '') + '). Use Resend on the Orders tab.' : '.')) +
          ' Pay link: <a href="' + esc(r.link) + '" target="_blank" rel="noopener">' + esc(r.link) + '</a></p>';
        host.scrollIntoView({ behavior: 'smooth' });
      });
    }).catch(function (err) {
      status.textContent = 'Not created: ' + err.message;
    }).then(function () { state.busy = false; btn.disabled = false; });
  }

  // ---- events ---------------------------------------------------------------
  tab.addEventListener('click', load);

  host.addEventListener('input', function (e) {
    var t = e.target;
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
    if (t.id === 'inv-email') fillCustomer('email');
    if (t.id === 'inv-name') fillCustomer('name');
    schedulePreview();
  });
  host.addEventListener('change', function (e) {
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
    if (e.target.id === 'inv-email') fillCustomer('email');
    if (e.target.id === 'inv-name') fillCustomer('name');
    schedulePreview();
  });

  host.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    var keep = collect();
    if (act === 'add') state.lines.push({ product_id: '', qty: 1, price: '' });
    else if (act === 'add-custom') state.lines.push({ custom: true, name: 'Freight', qty: 1, price: '', taxable: false });
    else if (act === 'remove') state.lines.splice(+b.getAttribute('data-i'), 1);
    else if (act === 'send') return submit(true, b);
    else if (act === 'create') return submit(false, b);
    else return;
    if (!state.lines.length) state.lines.push({ product_id: '', qty: 1, price: '' });
    rerenderKeeping(keep);
  });

  function rerenderKeeping(keep) {
    render();
    document.getElementById('inv-email').value = keep.customer.email;
    document.getElementById('inv-name').value = keep.customer.name;
    document.getElementById('inv-phone').value = keep.customer.phone;
    document.getElementById('inv-pickup').value = keep.pickup;
    document.getElementById('inv-note').value = keep.note;
    fillCustomer('email');
    renderRecent();
    schedulePreview();
  }
})();
