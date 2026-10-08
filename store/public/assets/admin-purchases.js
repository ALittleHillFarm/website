/* Admin — Purchases tab.
 * ---------------------------------------------------------------------
 * Record what was bought from a supplier: the order's header (supplier,
 * dates, order and PO numbers, shipping, fees) and its lines, all on one
 * page. Each line shows its landed cost: the supplier's price plus its share
 * of shipping and fees, split by weight. When the purchase is received it adds
 * stock and moves each product's cost to a weighted average. All of that is
 * done by the server (worker.js, adminPurchases, landedCosts); the numbers
 * shown while typing here repeat the same arithmetic so they match what is
 * saved.
 */
(function () {
  'use strict';

  var host = document.getElementById('purchases-app');
  var tab = document.getElementById('tab-purchases');
  if (!host || !tab) return;

  var state = { list: [], products: [], loaded: false, ed: null, busy: false, dirty: false, mismatch: false };

  // ---- helpers ----------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(c) { return '$' + (Math.round(Number(c) || 0) / 100).toFixed(2); }
  function dollars(c) { return (Math.round(Number(c) || 0) / 100).toFixed(2); }
  // Money box to whole cents: null when blank, NaN when it isn't an amount.
  function cents(v) {
    var s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    if (s === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
  }
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('Request failed (' + r.status + ')'));
        return d;
      });
    });
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s + 'T12:00:00');
    return isNaN(d) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function label(p) { return (p.sku ? p.sku + ' — ' : '') + p.name + (p.unit ? ' (' + p.unit + ')' : ''); }
  function byLabel(text) {
    for (var i = 0; i < state.products.length; i++) if (label(state.products[i]) === text) return state.products[i];
    return null;
  }
  function byId(id) {
    for (var i = 0; i < state.products.length; i++) if (state.products[i].id === id) return state.products[i];
    return null;
  }
  function note(text, kind) {
    var el = document.getElementById('pu-msg');
    if (el) el.innerHTML = text ? '<p class="alert ' + (kind || 'success') + '" role="status">' + esc(text) + '</p>' : '';
    if (el && text && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Same arithmetic as landedCosts() in worker.js.
  function landedCosts(lines, extra) {
    var lbs = lines.map(function (l) { return l.weight > 0 ? l.weight * l.qty : 0; });
    var byWeight = lines.length > 0 && lbs.every(function (w) { return w > 0; });
    var basis = lines.map(function (l, i) { return byWeight ? lbs[i] : l.price * l.qty; });
    var total = basis.reduce(function (a, b) { return a + b; }, 0);
    var totalLbs = lbs.reduce(function (a, b) { return a + b; }, 0);
    return {
      by: byWeight ? 'weight' : 'dollars',
      totalLbs: totalLbs,
      perLb: byWeight && totalLbs > 0 ? extra / totalLbs : null,
      landed: lines.map(function (l, i) { return Math.round(l.price + (total > 0 ? (extra * basis[i]) / total : 0) / l.qty); }),
    };
  }

  // ---- loading ----------------------------------------------------------
  function load() {
    return Promise.all([api('GET', '/api/admin/purchases'), api('GET', '/api/admin/products')]).then(function (r) {
      state.list = r[0].purchases || [];
      state.products = (r[1].products || []).filter(function (p) { return !p.archived; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      state.loaded = true;
      if (!state.ed) renderList();
    }).catch(function (err) {
      host.innerHTML = '<p class="alert error">' + esc(err.message) + '</p>';
    });
  }

  // ---- list ---------------------------------------------------------------
  function renderList() {
    state.ed = null;
    host.innerHTML = '<div id="pu-msg"></div>' +
      '<p><button type="button" class="btn" data-act="new">New purchase</button></p>' +
      (state.list.length ? '<div class="ad-list">' + state.list.map(function (p) {
        var got = !!p.received_at;
        return '<div class="ad-item">' +
          '<div class="ad-main"><strong>' + esc(p.supplier) + '</strong> ' +
            '<span class="chip' + (got ? ' done' : '') + '">' + (got ? 'Received' : 'Not arrived yet') + '</span>' +
            '<div class="meta">' + esc(fmtDate(p.ordered_at)) + (p.ref ? ' · ' + esc(p.ref) : '') + (p.po ? ' · ' + esc(p.po) : '') +
              ' · ' + p.units + ' item' + (p.units === 1 ? '' : 's') + (got && p.received_at !== p.ordered_at ? ' · arrived ' + esc(fmtDate(p.received_at)) : '') + '</div></div>' +
          '<div class="ad-amt">' + money(p.total_cents) + '</div>' +
          '<div class="acts"><button type="button" class="btn small" data-act="edit" data-id="' + esc(p.id) + '">Open</button>' +
            '<button type="button" class="btn ghost small" data-act="dup" data-id="' + esc(p.id) + '" title="Start a new purchase with the same items">Duplicate</button></div>' +
        '</div>';
      }).join('') + '</div>' : '<p class="empty-note">No purchases yet. Press New purchase to record your first supplier order.</p>');
  }

  // ---- editor ---------------------------------------------------------------
  function blankLine() { return { product_id: '', text: '', name: '', sku: '', qty: '1', price: '', weight: '' }; }

  function fromPurchase(p, asCopy) {
    return {
      id: asCopy ? null : p.id,
      supplier: p.supplier, ordered_at: asCopy ? today() : p.ordered_at,
      received: asCopy ? true : !!p.received_at, received_at: asCopy ? '' : (p.received_at || ''),
      ref: asCopy ? '' : (p.ref || ''), po: asCopy ? '' : (p.po || ''),
      shipping: asCopy ? '' : dollars(p.shipping_cents), other: asCopy ? '' : (p.other_cents ? dollars(p.other_cents) : ''),
      tax: asCopy ? '' : (p.tax_cents ? dollars(p.tax_cents) : ''), note: asCopy ? '' : (p.note || ''),
      lines: p.lines.map(function (l) {
        var prod = l.product_id && byId(l.product_id);
        return {
          product_id: l.product_id || '', text: prod ? label(prod) : l.name, name: l.name, sku: l.sku || '',
          qty: String(l.qty), price: dollars(l.unit_cost_cents), weight: l.weight_lbs == null ? '' : String(l.weight_lbs),
        };
      }),
    };
  }

  function newPurchase() {
    return { id: null, supplier: '', ordered_at: today(), received: true, received_at: '', ref: '', po: '', shipping: '', other: '', tax: '', note: '', lines: [blankLine()] };
  }

  function openEditor(ed) {
    state.ed = ed; state.dirty = false;
    renderEditor();
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function lastFor(supplier) {
    var s = String(supplier || '').trim().toLowerCase();
    if (!s) return null;
    for (var i = 0; i < state.list.length; i++) if (state.list[i].supplier.toLowerCase() === s) return state.list[i];
    return null;
  }

  function lineHtml(l, i) {
    return '<div class="ed-line pu-line" data-i="' + i + '">' +
      '<label class="ed-c what"><span class="m-lbl">Product</span><input type="text" list="pu-products" data-k="text" value="' + esc(l.text) + '" placeholder="Type a SKU or name…" autocomplete="off" autocapitalize="off"></label>' +
      '<label class="ed-c"><span class="m-lbl">Qty</span><input type="text" inputmode="numeric" data-k="qty" value="' + esc(l.qty) + '" autocomplete="off"></label>' +
      '<label class="ed-c"><span class="m-lbl">Price each $</span><input type="text" inputmode="decimal" data-k="price" value="' + esc(l.price) + '" placeholder="0.00"></label>' +
      '<label class="ed-c"><span class="m-lbl">Lb each</span><input type="text" inputmode="decimal" data-k="weight" value="' + esc(l.weight) + '" placeholder="lbs"></label>' +
      '<div class="ed-c calc"><span class="m-lbl">Cost each, with shipping</span><span data-landed>—</span></div>' +
      '<div class="ed-c calc"><span class="m-lbl">Line total</span><span data-total>—</span></div>' +
      '<button type="button" class="btn ghost small" data-act="remove" data-i="' + i + '" aria-label="Remove this line" tabindex="-1">✕</button>' +
      '<div class="ed-note" data-note' + (l.msg ? '>' + esc(l.msg) : ' hidden>') + '</div>' +
    '</div>';
  }

  function copyLastHtml(e) {
    var last = lastFor(e.supplier);
    return last && !e.id ? '<p><button type="button" class="btn ghost small" data-act="copy-last">Copy the items from the last ' + esc(last.supplier) + ' order (' + esc(fmtDate(last.ordered_at)) + ')</button></p>' : '';
  }

  function renderEditor() {
    var e = state.ed;
    var suppliers = {};
    state.list.forEach(function (p) { suppliers[p.supplier] = 1; });
    state.products.forEach(function (p) { if (p.supplier) suppliers[p.supplier] = 1; });
    host.innerHTML =
      '<datalist id="pu-products">' + state.products.map(function (p) { return '<option value="' + esc(label(p)) + '">'; }).join('') + '</datalist>' +
      '<datalist id="pu-suppliers">' + Object.keys(suppliers).sort().map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>' +
      '<p><button type="button" class="link-btn" data-act="back">← All purchases</button></p>' +
      '<div id="pu-msg"></div>' +
      '<fieldset class="goat-set"><legend>' + (e.id ? 'Purchase' : 'New purchase') + '</legend><div class="form-grid">' +
        '<div class="field span2"><label for="pu-supplier">Supplier</label><input type="text" id="pu-supplier" list="pu-suppliers" maxlength="80" value="' + esc(e.supplier) + '" placeholder="e.g. New Country Organics" autocomplete="off"></div>' +
        '<div class="field"><label for="pu-ordered">Order date</label><input type="date" id="pu-ordered" value="' + esc(e.ordered_at) + '"></div>' +
        '<div class="field"><label for="pu-ref">Supplier’s order number</label><input type="text" id="pu-ref" maxlength="60" value="' + esc(e.ref) + '" placeholder="e.g. SO343263"></div>' +
        '<div class="field"><label for="pu-po">Our PO number</label><input type="text" id="pu-po" maxlength="60" value="' + esc(e.po) + '" placeholder="e.g. PO60"></div>' +
        '<div class="field"><label for="pu-ship">Shipping $</label><input type="text" id="pu-ship" inputmode="decimal" value="' + esc(e.shipping) + '" placeholder="0.00"></div>' +
        '<div class="field"><label for="pu-other">Other fees $</label><input type="text" id="pu-other" inputmode="decimal" value="' + esc(e.other) + '" placeholder="0.00"></div>' +
        '<div class="field"><label for="pu-tax">Tax $ <span class="lbl-note">not added to item cost</span></label><input type="text" id="pu-tax" inputmode="decimal" value="' + esc(e.tax) + '" placeholder="0.00"></div>' +
        '<div class="field"><label for="pu-printed">Total on the supplier’s invoice $ <span class="lbl-note">to double-check your entries</span></label><input type="text" id="pu-printed" inputmode="decimal" value="' + esc(e.printed || '') + '" placeholder="e.g. 2052.57"></div>' +
        '<div class="field"><div class="check-row" style="margin-top:28px"><input type="checkbox" id="pu-notyet"' + (e.received ? '' : ' checked') + '><label for="pu-notyet">Not arrived yet</label></div></div>' +
        '<div class="field" id="pu-got-wrap"' + (e.received ? '' : ' hidden') + '><label for="pu-got">Arrived on <span class="lbl-note">blank = the order date</span></label><input type="date" id="pu-got" value="' + esc(e.received_at) + '"></div>' +
      '</div>' +
      '<p class="hint" style="margin:0 0 6px">Stock is added when the purchase is received. Tick “Not arrived yet” to save it now and mark it received later.</p>' +
      '<div id="pu-copylast">' + copyLastHtml(e) + '</div>' +
      '</fieldset>' +
      '<fieldset class="goat-set"><legend>Items</legend>' +
        '<div class="ed-head pu-line"><span>Product</span><span>Qty</span><span>Price each $</span><span>Lb each</span><span>Cost each + shipping</span><span>Line total</span><span></span></div>' +
        '<div id="pu-lines">' + e.lines.map(lineHtml).join('') + '</div>' +
        '<p style="margin:10px 0 14px"><button type="button" class="btn ghost small" data-act="add">Add an item</button> ' +
          '<button type="button" class="btn ghost small" data-act="new-product">Add a product that isn’t listed…</button></p>' +
        '<div id="pu-newprod"></div>' +
        '<div class="hint">“Cost each + shipping” is the price plus that item’s share of shipping and fees, shared out by weight. It becomes the product’s cost. Stock and cost are only updated for items picked from the list. Tip: type a SKU, then press Enter to move across the line.</div>' +
        '<div class="inv-totals" id="pu-totals" style="margin-top:16px"></div>' +
      '</fieldset>' +
      '<fieldset class="goat-set"><legend>Notes (optional)</legend><div class="field"><textarea id="pu-note" rows="2" maxlength="1000">' + esc(e.note) + '</textarea></div></fieldset>' +
      '<div class="goat-save"><button type="button" class="btn" data-act="save">Save purchase</button>' +
        (e.id ? '<button type="button" class="btn ghost rust-text" data-act="delete">Delete…</button>' : '') +
        '<span id="pu-status" aria-live="polite"></span></div>';
    recalc();
  }

  // Pull everything the page shows back into state.ed (before any re-render).
  function readForm() {
    var e = state.ed;
    function v(id) { var el = document.getElementById(id); return el ? el.value : ''; }
    e.supplier = v('pu-supplier'); e.ordered_at = v('pu-ordered'); e.ref = v('pu-ref'); e.po = v('pu-po');
    e.shipping = v('pu-ship'); e.other = v('pu-other'); e.tax = v('pu-tax'); e.note = v('pu-note'); e.printed = v('pu-printed');
    e.received = !document.getElementById('pu-notyet').checked; e.received_at = v('pu-got');
  }

  // Recompute the landed column and totals without touching the inputs.
  function recalc() {
    var e = state.ed;
    if (!e || !document.getElementById('pu-totals')) return;
    var ship = cents(document.getElementById('pu-ship').value) || 0;
    var other = cents(document.getElementById('pu-other').value) || 0;
    var tax = cents(document.getElementById('pu-tax').value) || 0;
    if (isNaN(ship)) ship = 0; if (isNaN(other)) other = 0; if (isNaN(tax)) tax = 0;
    var rows = [], idx = [], sub = 0, unlinked = 0;
    e.lines.forEach(function (l, i) {
      var qty = parseInt(l.qty, 10), price = cents(l.price), w = parseFloat(l.weight);
      if (!(qty > 0) || price === null || isNaN(price)) return;
      rows.push({ qty: qty, price: price, weight: w > 0 ? w : 0 });
      idx.push(i);
      sub += qty * price;
      if (!l.product_id) unlinked++;
    });
    var r = landedCosts(rows, ship + other);
    var els = document.querySelectorAll('#pu-lines .pu-line');
    for (var i = 0; i < els.length; i++) {
      var at = idx.indexOf(i);
      els[i].querySelector('[data-landed]').textContent = at < 0 ? '—' : money(r.landed[at]);
      els[i].querySelector('[data-total]').textContent = at < 0 ? '—' : money(rows[at].qty * rows[at].price);
    }
    var how = '';
    if (ship + other > 0 && rows.length) {
      how = r.by === 'weight'
        ? 'Shipping and fees ' + money(ship + other) + ' over ' + Math.round(r.totalLbs * 10) / 10 + ' lb = <strong>' + (Math.round(r.perLb * 10) / 10) + '¢ per lb</strong>'
        : 'Shipping and fees are shared by dollar amount, because some items have no weight. Fill in “Lb each” to share by weight.';
    }
    var total = sub + ship + other + tax;
    var printed = cents(document.getElementById('pu-printed').value), check = '';
    state.mismatch = printed !== null && !isNaN(printed) && printed !== total;
    if (printed !== null && !isNaN(printed)) {
      check = printed === total
        ? '<p class="alert success" role="status" style="margin:10px 0 0">Matches the supplier’s total of ' + money(printed) + '.</p>'
        : '<p class="alert error" role="status" style="margin:10px 0 0">Doesn’t match. Your lines add up to ' + money(total) + ' but the supplier’s invoice says ' + money(printed) +
          ' (' + (total > printed ? 'you are ' + money(total - printed) + ' over' : 'you are ' + money(printed - total) + ' short') +
          '). Check the quantities, prices, shipping and tax.</p>';
    }
    document.getElementById('pu-totals').innerHTML =
      '<div class="row"><span>Items</span><span>' + money(sub) + '</span></div>' +
      '<div class="row"><span>Shipping</span><span>' + money(ship) + '</span></div>' +
      (other ? '<div class="row"><span>Other fees</span><span>' + money(other) + '</span></div>' : '') +
      (tax ? '<div class="row"><span>Tax</span><span>' + money(tax) + '</span></div>' : '') +
      '<div class="row total"><span>Order total</span><span>' + money(total) + '</span></div>' + check +
      (how ? '<p class="hint" style="margin-top:8px">' + how + '</p>' : '') +
      (unlinked ? '<p class="hint">' + unlinked + ' item' + (unlinked === 1 ? ' is' : 's are') + ' not matched to a product in your list, so ' + (unlinked === 1 ? 'it' : 'they') + ' won’t change stock.</p>' : '');
  }

  function save(btn) {
    if (state.busy) return;
    readForm();
    var e = state.ed, status = document.getElementById('pu-status');
    var ship = cents(e.shipping), other = cents(e.other), tax = cents(e.tax);
    if (isNaN(ship) || isNaN(other) || isNaN(tax)) { status.className = ''; status.textContent = 'Shipping, fees and tax should be plain amounts like 368.59.'; return; }
    var lines = [];
    for (var i = 0; i < e.lines.length; i++) {
      var l = e.lines[i];
      if (!l.text.trim() && !l.price && !l.product_id) continue;   // an empty row
      var price = cents(l.price);
      if (price === null || isNaN(price)) { status.className = ''; status.textContent = 'Line ' + (i + 1) + ': enter the price each, such as 24.95.'; return; }
      lines.push({
        product_id: l.product_id || null, name: l.product_id ? '' : l.text, sku: l.sku,
        qty: parseInt(l.qty, 10), unit_cost_cents: price, weight_lbs: l.weight.trim(),
      });
    }
    if (!lines.length) { status.className = ''; status.textContent = 'Add at least one item first.'; return; }
    if (state.mismatch && !window.confirm('The total doesn’t match the supplier’s invoice. Save it anyway?')) return;
    state.busy = true; btn.disabled = true; status.className = ''; status.textContent = 'Saving…';
    api('POST', '/api/admin/purchases', {
      action: 'save', id: e.id, supplier: e.supplier, ordered_at: e.ordered_at, received: e.received, received_at: e.received_at,
      ref: e.ref, po: e.po, shipping_cents: ship || 0, other_cents: other || 0, tax_cents: tax || 0, note: e.note, lines: lines,
    }).then(function (r) {
      state.busy = false;
      state.ed = null; state.dirty = false;
      return load().then(function () {
        renderList();
        note('Saved: ' + money(r.total_cents) + '.' + (e.received ? ' Stock and costs are updated.' : ' Stock will be added when you mark it received.'));
      });
    }).catch(function (err) {
      state.busy = false; btn.disabled = false;
      status.className = ''; status.textContent = 'Not saved: ' + err.message;
    });
  }

  function newProductForm() {
    var box = document.getElementById('pu-newprod');
    if (box.innerHTML) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="inv-recent"><div class="label">New product</div><div class="form-grid">' +
      '<div class="field"><label for="npu-name">Name</label><input type="text" id="npu-name" maxlength="120"></div>' +
      '<div class="field"><label for="npu-unit">Size</label><input type="text" id="npu-unit" maxlength="40" placeholder="e.g. 50 lbs"></div>' +
      '<div class="field"><label for="npu-sku">SKU</label><input type="text" id="npu-sku" maxlength="40"></div>' +
      '<div class="field"><label for="npu-weight">Weight each (lbs)</label><input type="text" id="npu-weight" inputmode="decimal" placeholder="from the size if blank"></div>' +
      '</div><p class="hint">The supplier is filled in from this order. It starts switched off in the store; set its price and switch it on in the Products tab.</p>' +
      '<p><button type="button" class="btn small" data-act="make-product">Create and add</button> <span id="npu-status"></span></p></div>';
    var open = state.ed.lines.filter(function (l) { return l.text.trim() && !l.product_id; })[0];
    if (open) {
      var guess = open.text.trim();
      if (/^\S+$/.test(guess) && /\d/.test(guess)) document.getElementById('npu-sku').value = guess.toUpperCase();
      else document.getElementById('npu-name').value = guess;
      if (open.weight) document.getElementById('npu-weight').value = open.weight;
    }
    document.getElementById('npu-name').focus();
  }

  function makeProduct(btn) {
    var st = document.getElementById('npu-status');
    readForm();
    var fields = {
      name: document.getElementById('npu-name').value, unit: document.getElementById('npu-unit').value,
      sku: document.getElementById('npu-sku').value, weight_lbs: document.getElementById('npu-weight').value.trim(),
      supplier: state.ed.supplier,
    };
    btn.disabled = true; st.textContent = 'Creating…';
    api('POST', '/api/admin/products', { action: 'create', fields: fields }).then(function (r) {
      return api('GET', '/api/admin/products').then(function (d) {
        state.products = (d.products || []).filter(function (p) { return !p.archived; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
        document.dispatchEvent(new CustomEvent('products-changed'));
        var p = byId(r.id);
        var empty = state.ed.lines.length === 1 && !state.ed.lines[0].text && !state.ed.lines[0].product_id;
        var line = { product_id: p.id, text: label(p), name: p.name, sku: p.sku, qty: '1', price: '', weight: p.weight_lbs == null ? '' : String(p.weight_lbs) };
        var open = state.ed.lines.filter(function (l) { return l.text.trim() && !l.product_id; })[0];
        if (open) { open.product_id = p.id; open.text = line.text; open.name = p.name; open.sku = p.sku; if (!open.weight) open.weight = line.weight; }
        else if (empty) state.ed.lines = [line]; else state.ed.lines.push(line);
        renderEditor();
        note('Created “' + p.name + '” and used it on the line. Enter its price.');
      });
    }).catch(function (err) { st.textContent = 'Not created: ' + err.message; btn.disabled = false; });
  }

  // ---- events -------------------------------------------------------------
  tab.addEventListener('click', function () {
    if (state.ed && document.getElementById('pu-lines')) return;         // don't throw away a purchase being typed
    host.innerHTML = '<p class="lede">Loading…</p>';
    state.ed = null;
    load().then(renderList);
  });

  function markDirty() {
    if (state.dirty) return;
    state.dirty = true;
    var st = document.getElementById('pu-status');
    if (st && !st.textContent) { st.textContent = 'Not saved yet'; st.className = 'muted'; }
  }
  AdminUI.guardLeaving(function () { return !!(state.ed && state.dirty); });
  AdminUI.lineKeys(host, '.pu-line', 'weight', function () {
    readForm(); state.ed.lines.push(blankLine()); renderEditor();
    var all = document.querySelectorAll('#pu-lines [data-k="text"]'); all[all.length - 1].focus();
  });

  host.addEventListener('input', function (e) {
    var t = e.target, ed = state.ed;
    if (!ed) return;
    markDirty();
    var row = t.closest('.pu-line');
    if (row && row.parentNode.id === 'pu-lines') {
      var l = ed.lines[+row.getAttribute('data-i')], k = t.getAttribute('data-k');
      l[k] = t.value;
      if (k === 'text') {
        var p = byLabel(t.value);
        l.product_id = p ? p.id : '';
        l.name = p ? p.name : t.value; l.sku = p ? p.sku : '';
        if (p && !l.weight && p.weight_lbs != null) { l.weight = String(p.weight_lbs); row.querySelector('[data-k="weight"]').value = l.weight; }
      }
    }
    recalc();
  });
  // Typed text that isn't a list entry word for word: match it on SKU, name or
  // words, and say so when it can't be matched.
  function resolveLine(row, input) {
    var l = state.ed.lines[+row.getAttribute('data-i')];
    var note = row.querySelector('[data-note]');
    l.msg = '';
    if (!input.value.trim()) { l.product_id = ''; l.name = ''; l.sku = ''; }
    else {
      var hit = AdminUI.findProduct(state.products, input.value, label);
      if (hit.product) {
        var p = hit.product;
        l.product_id = p.id; l.name = p.name; l.sku = p.sku; l.text = label(p);
        input.value = l.text;
        if (!l.weight && p.weight_lbs != null) { l.weight = String(p.weight_lbs); row.querySelector('[data-k="weight"]').value = l.weight; }
      } else {
        l.product_id = ''; l.name = input.value; l.sku = '';
        l.msg = hit.many > 1
          ? hit.many + ' products match. Pick one from the list, or type more of the name.'
          : 'Not in your product list, so this line won’t change stock. Use “Add a product that isn’t listed” below to create it.';
      }
    }
    note.hidden = !l.msg; note.textContent = l.msg;
    recalc();
  }

  host.addEventListener('change', function (e) {
    var t = e.target;
    if (!state.ed) return;
    var row = t.closest && t.closest('.pu-line');
    if (row && t.getAttribute('data-k') === 'text' && row.parentNode.id === 'pu-lines') return resolveLine(row, t);
    if (t.id === 'pu-notyet') { document.getElementById('pu-got-wrap').hidden = t.checked; }
    if (t.id === 'pu-supplier') { readForm(); document.getElementById('pu-copylast').innerHTML = copyLastHtml(state.ed); }
  });

  host.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (act === 'new') return openEditor(newPurchase());
    if (act === 'back') {
      if (state.ed && !window.confirm('Leave without saving this purchase?')) return;
      return load().then(renderList);
    }
    if (act === 'edit' || act === 'dup') {
      b.disabled = true;
      api('GET', '/api/admin/purchases?id=' + encodeURIComponent(id)).then(function (d) {
        openEditor(fromPurchase(d.purchase, act === 'dup'));
      }).catch(function (err) { note(err.message, 'error'); b.disabled = false; });
      return;
    }
    if (!state.ed) return;
    if (act === 'add') { readForm(); state.ed.lines.push(blankLine()); renderEditor(); var all = document.querySelectorAll('#pu-lines [data-k="text"]'); all[all.length - 1].focus(); return; }
    if (act === 'remove') {
      readForm();
      state.ed.lines.splice(+b.getAttribute('data-i'), 1);
      if (!state.ed.lines.length) state.ed.lines.push(blankLine());
      return renderEditor();
    }
    if (act === 'new-product') return newProductForm();
    if (act === 'make-product') return makeProduct(b);
    if (act === 'copy-last') {
      var last = lastFor(document.getElementById('pu-supplier').value);
      if (!last) return;
      b.disabled = true;
      api('GET', '/api/admin/purchases?id=' + encodeURIComponent(last.id)).then(function (d) {
        readForm();
        var copy = fromPurchase(d.purchase, true);
        state.ed.supplier = copy.supplier;
        state.ed.lines = copy.lines;
        renderEditor();
        note('Copied the items. Check the quantities and prices, then add shipping.');
      }).catch(function (err) { note(err.message, 'error'); b.disabled = false; });
      return;
    }
    if (act === 'save') return save(b);
    if (act === 'delete') {
      if (!window.confirm('Delete this purchase? The stock it added is taken back out and the costs are worked out again.')) return;
      b.disabled = true;
      api('POST', '/api/admin/purchases', { action: 'delete', id: state.ed.id }).then(function () {
        state.ed = null;
        return load().then(function () { renderList(); note('Purchase deleted. Stock and costs are updated.'); });
      }).catch(function (err) { note(err.message, 'error'); b.disabled = false; });
    }
  });
})();
