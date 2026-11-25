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

  var state = { products: [], customers: [], pastOnly: [], pickups: [], lines: [], recent: [], recentFor: '', loaded: false, loading: null, busy: false };

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
        email: document.getElementById('inv-email').value.trim(),
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
    if (!b.lines.length || !b.customer.email || !b.customer.name) {
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
      if (byName.length === 1) { emailBox.value = byName[0].email; document.getElementById('inv-phone').value = byName[0].phone || ''; }
    }
    var email = emailBox.value.trim().toLowerCase();
    var c = state.customers.filter(function (x) { return x.email === email; })[0];
    var past = !c && state.pastOnly.filter(function (x) { return String(x.email).toLowerCase() === email; })[0];
    loadRecent(c || past || (settled && EMAIL.test(email)) ? email : '');
    var note = document.getElementById('inv-cust-note');
    if (c) {
      if (!document.getElementById('inv-name').value) document.getElementById('inv-name').value = c.name || '';
      if (!document.getElementById('inv-phone').value) document.getElementById('inv-phone').value = c.phone || '';
      note.textContent = 'Known customer' + (c.tax_exempt ? ' · tax-exempt' : '') + (c.trusted ? ' · established' : '') + '.';
    } else if (past) {
      note.textContent = 'Bought on Shopify before (' + past.lines + (past.lines === 1 ? ' line' : ' lines') + ') — they will be saved as a customer when you create the invoice.';
    } else {
      note.textContent = email ? 'New customer — they will be saved when you create the invoice.' : '';
    }
  }

  // ---- finding a customer: any part of a name, email or phone ----------------
  var digitsOf = function (v) { return String(v || '').replace(/\D/g, ''); };
  function people() {
    return state.customers.map(function (c) {
      return { email: c.email, name: c.name || '', phone: c.phone || '', orders: c.paid_orders || 0, lines: c.history_lines || 0, saved: true };
    }).concat(state.pastOnly.map(function (h) {
      return { email: String(h.email).toLowerCase(), name: '', phone: '', orders: 0, lines: h.lines || 0, saved: false };
    }));
  }
  function findPeople(q) {
    var words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return people().filter(function (p) {
      var hay = (p.name + ' ' + p.email + ' ' + p.phone).toLowerCase(), ph = digitsOf(p.phone);
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
      var bits = [p.name ? p.email : '', p.phone, p.orders ? p.orders + (p.orders === 1 ? ' paid order' : ' paid orders') : '',
        p.lines ? p.lines + ' old Shopify ' + (p.lines === 1 ? 'line' : 'lines') : '', p.saved ? '' : 'Shopify purchases only'].filter(Boolean);
      return '<button type="button" class="find-hit" role="option" data-pick="' + esc(p.email) + '"><strong>' + esc(p.name || p.email) + '</strong>' +
        '<span class="muted">' + esc(bits.join(' · ')) + '</span></button>';
    }).join('') + (all.length > hits.length ? '<div class="find-more muted">' + (all.length - hits.length) + ' more — keep typing to narrow it down</div>' : '')
      : '<div class="find-more muted">No one matches. Type their name and email below to add a new customer.</div>';
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function pickPerson(email) {
    var p = people().filter(function (x) { return x.email === email; })[0];
    if (!p) return;
    document.getElementById('inv-name').value = p.name;
    document.getElementById('inv-email').value = p.email;
    document.getElementById('inv-phone').value = p.phone;
    document.getElementById('inv-find').value = '';
    showFound('');
    fillCustomer('email', true);
    schedulePreview();
    var next = !p.name ? document.getElementById('inv-name') : host.querySelector('input[data-k="pick"]');
    if (next) next.focus();
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

  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // The result of creating an invoice, in words: was it emailed or not, and
  // what to do about it.
  function resultPanel(r) {
    var linkRow = '<div class="link-row"><code>' + esc(r.link) + '</code> ' +
      '<button type="button" class="btn small ghost" data-act="copylink" data-link="' + esc(r.link) + '">Copy pay link</button></div>';
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
    var send = document.getElementById('inv-sendnow').checked;
    var b = collect();
    b.action = 'create';
    b.send = send;
    var status = document.getElementById('inv-status');
    if (send && !window.confirm('Create this invoice and email it to ' + (b.customer && b.customer.email ? b.customer.email : 'the customer') + ' now?')) return;
    state.busy = true;
    btn.disabled = true;
    status.textContent = send ? 'Creating and emailing…' : 'Creating…';
    post(b).then(function (r) {
      state.lines = [{ product_id: '', qty: 1, price: '' }];
      state.loaded = false;
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

  host.addEventListener('keydown', function (e) {
    var t = e.target, box = document.getElementById('inv-find-results');
    if (!box || box.hidden) return;
    var hits = Array.prototype.slice.call(box.querySelectorAll('.find-hit'));
    var at = hits.indexOf(t);
    if (t.id === 'inv-find') {
      if (e.key === 'ArrowDown' && hits[0]) { e.preventDefault(); hits[0].focus(); }
      else if (e.key === 'Enter' && hits[0]) { e.preventDefault(); pickPerson(hits[0].getAttribute('data-pick')); }
      else if (e.key === 'Escape') { t.value = ''; showFound(''); }
    } else if (at >= 0) {
      if (e.key === 'ArrowDown' && hits[at + 1]) { e.preventDefault(); hits[at + 1].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (hits[at - 1] || document.getElementById('inv-find')).focus(); }
      else if (e.key === 'Escape') { document.getElementById('inv-find').focus(); showFound(''); }
    }
  });
  document.addEventListener('click', function (e) {
    var box = document.getElementById('inv-find-results');
    if (box && !box.hidden && !(e.target.closest && e.target.closest('.inv-find'))) { document.getElementById('inv-find').value = ''; showFound(''); }
  });

  // "Create invoice" on a customer's page: open this tab with them filled in.
  document.addEventListener('invoice-for', function (ev) {
    var who = ev.detail || {};
    var writing = false;
    try { writing = state.loaded && !!document.getElementById('inv-email') && collect().lines.length > 0; } catch (err) { writing = false; }
    if (writing && !window.confirm('Start a new invoice for ' + (who.name || who.email) + '? The invoice you were writing here will be cleared.')) return;
    state.loaded = false;                       // fresh customers, fresh form
    state.lines = [{ product_id: '', qty: 1, price: '' }];
    state.recent = []; state.recentFor = '';
    tab.click();
    load().then(function () {
      if (!state.loaded) return;
      document.getElementById('inv-name').value = who.name || '';
      document.getElementById('inv-email').value = who.email || '';
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
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
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
    document.getElementById('inv-email').value = keep.customer.email;
    document.getElementById('inv-name').value = keep.customer.name;
    document.getElementById('inv-phone').value = keep.customer.phone;
    document.getElementById('inv-pickup').value = keep.pickup;
    document.getElementById('inv-note').value = keep.note;
    document.getElementById('inv-sendnow').checked = keep.send;
    fillCustomer('email');
    renderRecent();
    schedulePreview();
  }
})();
