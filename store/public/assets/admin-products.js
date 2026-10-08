/* Admin — Products tab.
 * ---------------------------------------------------------------------
 * Every product in one quick table: search and filter, change price, cost,
 * on-hand count or active right in the row, and open a row for the full form
 * (name, SKU, supplier, size, weight, description, photo, animals, stock
 * adjustments, delete). Saves go to /api/admin/products (worker.js,
 * adminProducts), which re-checks every field. The store reads the same
 * table, so a save is live on the next page load.
 *
 * On hand is a count: type what is on the shelf and press Save, and the
 * server records the difference as a stock take. A blank box means the
 * product is not tracked (milk, say); the first count starts tracking it.
 * Cost is the moving average of what purchases landed at (see Purchases).
 */
(function () {
  'use strict';

  var host = document.getElementById('products-app');
  var tab = document.getElementById('tab-products');
  if (!host || !tab) return;

  var state = {
    products: [], byId: {}, low: 3, loaded: false, open: null, creating: false, busy: false, counting: false, newImage: '',
    f: { q: '', category: '', supplier: '', status: 'active', stock: '', sort: 'name' },
  };

  // ---- helpers ----------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(c) { return '$' + (Math.round(Number(c) || 0) / 100).toFixed(2); }
  function dollars(c) { return (Math.round(Number(c) || 0) / 100).toFixed(2); }
  // A money box into whole cents. Blank is null; anything odd is NaN.
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
        if (!r.ok) { var e = new Error(d.message || d.error || ('Request failed (' + r.status + ')')); e.status = r.status; e.body = d; throw e; }
        return d;
      });
    });
  }
  function post(body) { return api('POST', '/api/admin/products', body); }
  function msg(text, kind) {
    var el = document.getElementById('pr-msg');
    if (el) el.innerHTML = text ? '<p class="alert ' + (kind || 'success') + '">' + esc(text) + '</p>' : '';
  }
  function uniq(list) {
    var seen = {};
    return list.filter(function (x) { if (!x || seen[x]) return false; seen[x] = true; return true; }).sort();
  }

  // ---- loading ----------------------------------------------------------
  function apply(d) {
    state.products = d.products || [];
    state.low = d.low_stock || 3;
    state.byId = {};
    state.products.forEach(function (p) { state.byId[p.id] = p; });
    state.loaded = true;
  }
  function load() {
    return api('GET', '/api/admin/products').then(function (d) {
      apply(d);
      render();
    }).catch(function (err) {
      host.innerHTML = '<div id="pr-msg"></div>';
      msg(err.message, 'error');
    });
  }

  function dirtyCount() { return host.querySelectorAll('.pr-item.dirty').length; }

  // ---- filtering --------------------------------------------------------
  function stockState(p) {
    if (p.on_hand == null) return 'untracked';
    if (p.on_hand <= 0) return 'out';
    if (p.on_hand <= state.low) return 'low';
    return 'in';
  }
  function visible() {
    var f = state.f;
    var words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    var list = state.products.filter(function (p) {
      if (f.status === 'active' && (!p.active)) return false;
      if (f.status === 'inactive' && (p.active || p.archived)) return false;
      if (f.status === 'archived' && !p.archived) return false;
      if (f.status !== 'archived' && f.status !== 'all' && p.archived) return false;
      if (f.category && p.category !== f.category) return false;
      if (f.supplier && p.supplier !== f.supplier) return false;
      if (f.stock) {
        var s = stockState(p);
        if (f.stock === 'attention' ? (s !== 'out' && s !== 'low') : s !== f.stock) return false;
      }
      if (words.length) {
        var hay = (p.name + ' ' + p.sku + ' ' + p.supplier + ' ' + p.unit + ' ' + p.category).toLowerCase();
        for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) === -1) return false;
      }
      return true;
    });
    if (f.sort === 'name') list.sort(function (a, b) { return a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit); });
    if (f.sort === 'stock') list.sort(function (a, b) {
      var x = a.on_hand == null ? 1e9 : a.on_hand, y = b.on_hand == null ? 1e9 : b.on_hand;
      return x - y || a.name.localeCompare(b.name);
    });
    if (f.sort === 'margin') list.sort(function (a, b) { return a.margin_cents - b.margin_cents || a.name.localeCompare(b.name); });
    return list;
  }

  // ---- rendering --------------------------------------------------------
  function select(id, label, value, options) {
    return '<div class="field flt"><label for="' + id + '">' + label + '</label><select id="' + id + '">' +
      options.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></div>';
  }

  function render() {
    var f = state.f;
    var cats = uniq(state.products.map(function (p) { return p.category; }));
    var sups = uniq(state.products.map(function (p) { return p.supplier; }));
    host.innerHTML =
      '<datalist id="pr-suppliers">' + sups.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>' +
      '<datalist id="pr-cats">' + cats.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>' +
      '<div id="pr-msg"></div>' +
      '<div class="pr-bar' + (state.counting ? ' counting' : '') + '">' +
        '<div class="field grow"><label for="pr-q">Search</label><input type="text" id="pr-q" value="' + esc(f.q) + '" placeholder="Name, SKU or supplier" autocomplete="off"></div>' +
        select('pr-status', 'Show', f.status, [['active', 'Active (in the store)'], ['inactive', 'Switched off'], ['archived', 'Archived'], ['all', 'Everything']]) +
        select('pr-category', 'Category', f.category, [['', 'All']].concat(cats.map(function (c) { return [c, c]; }))) +
        select('pr-supplier', 'Supplier', f.supplier, [['', 'All']].concat(sups.map(function (c) { return [c, c]; }))) +
        select('pr-stock', 'Stock', f.stock, [['', 'Any'], ['attention', 'Low or out'], ['out', 'Out of stock'], ['low', 'Low (' + state.low + ' or fewer)'],
          ['in', 'In stock'], ['untracked', 'Not tracked']]) +
        select('pr-sort', 'Sort by', f.sort, [['name', 'Name'], ['stock', 'Least stock first'], ['margin', 'Lowest margin first']]) +
        '<div class="field"><button type="button" class="btn" data-act="new">New product</button></div>' +
        '<div class="field"><button type="button" class="btn ghost" data-act="count-mode" aria-pressed="' + state.counting + '">' + (state.counting ? 'Done counting' : 'Count stock') + '</button></div>' +
      '</div>' +
      (state.counting ? '<p class="alert success" style="margin:0 0 12px">Counting. Type what is on the shelf for each product and press <strong>Enter</strong> to save it and move to the next. Leave a box empty to skip that product.</p>' : '') +
      '<div id="pr-new"></div>' +
      '<div id="pr-list"></div>' +
      '<div class="goat-save" id="pr-bulk" hidden></div>';
    renderNew();
    renderList();
  }

  function renderNew() {
    var box = document.getElementById('pr-new');
    if (!box) return;
    if (!state.creating) { box.innerHTML = ''; return; }
    box.innerHTML =
      '<fieldset class="goat-set"><legend>New product</legend><div class="form-grid">' +
        '<div class="field"><label for="np-name">Name</label><input type="text" id="np-name" maxlength="120" placeholder="e.g. Thorvin Kelp"></div>' +
        '<div class="field"><label for="np-unit">Size</label><input type="text" id="np-unit" maxlength="40" placeholder="e.g. 50 lbs"></div>' +
        '<div class="field"><label for="np-supplier">Supplier</label><input type="text" id="np-supplier" list="pr-suppliers" maxlength="80"></div>' +
        '<div class="field"><label for="np-sku">SKU</label><input type="text" id="np-sku" maxlength="40"></div>' +
        '<div class="field"><label for="np-price">Price ($)</label><input type="text" id="np-price" inputmode="decimal" placeholder="0.00"></div>' +
        '<div class="field"><label for="np-cost">Cost ($)</label><input type="text" id="np-cost" inputmode="decimal" placeholder="0.00"></div>' +
        '<div class="field"><label for="np-weight">Weight each (lbs)</label><input type="text" id="np-weight" inputmode="decimal" placeholder="from the size if blank"></div>' +
        '<div class="field span2"><label for="np-description">Description <span class="lbl-note">shown on the product page</span></label><textarea id="np-description" rows="3"></textarea></div>' +
        '<div class="field span2"><label>Photo</label><div class="pr-photo"><div class="shot empty" id="np-shot">no photo</div>' +
          '<label class="photo-btn" for="np-file">Choose a photo…</label>' +
          '<input type="file" class="visually-hidden" id="np-file" accept="image/jpeg,image/png,image/gif,image/webp">' +
          '<div class="upload-status" id="np-upload" hidden></div></div></div>' +
      '</div><div class="check-row" style="margin-bottom:14px"><input type="checkbox" id="np-active"><label for="np-active">Put it in the store right away <span class="lbl-note">needs a price</span></label></div>' +
      '<p class="hint" style="margin:0 0 14px">Left unticked it stays switched off, so nothing half-finished reaches the store. You can switch it on later with the Active tick.</p>' +
      '<p><button type="button" class="btn" data-act="create">Create product</button> <button type="button" class="btn ghost" data-act="new-cancel">Cancel</button>' +
      ' <span id="np-status" aria-live="polite"></span></p></fieldset>';
    state.newImage = '';
    document.getElementById('np-name').focus();
  }

  function chips(p) {
    var s = stockState(p), out = '';
    if (p.archived) out += '<span class="chip">Archived</span>';
    if (s === 'out') out += '<span class="chip pr-out">Out</span>';
    if (s === 'low') out += '<span class="chip pr-low">Low</span>';
    return out;
  }

  function rowHtml(p) {
    var id = esc(p.id);
    var neg = p.margin_cents < 0;
    var pct = p.price_cents > 0 ? Math.round((p.margin_cents / p.price_cents) * 100) + '%' : '';
    return '<div class="pr-item' + (state.open === p.id ? ' open' : '') + (p.active ? '' : ' off') + '" data-id="' + id + '">' +
      '<div class="pr-row">' +
        '<div class="pr-name"><button type="button" class="pr-title" data-act="more" aria-expanded="' + (state.open === p.id) + '">' + esc(p.name) + '</button> ' + chips(p) +
          '<div class="pr-meta">' + esc([p.unit, p.supplier, p.sku ? 'SKU ' + p.sku : ''].filter(Boolean).join(' · ')) + '</div></div>' +
        '<label class="pr-c"><span class="pr-l">Price $</span><input class="pr-in" data-k="price" inputmode="decimal" autocomplete="off" value="' + dollars(p.price_cents) + '" aria-label="Price"></label>' +
        '<label class="pr-c"><span class="pr-l">Cost $</span><input class="pr-in" data-k="cost" inputmode="decimal" autocomplete="off" value="' + dollars(p.cost_cents + p.freight_cents) + '" aria-label="Cost"></label>' +
        '<div class="pr-c pr-margin' + (neg ? ' neg' : '') + '" title="Price less cost"><span class="pr-l">Margin</span><span data-margin>' + (neg ? '−' : '') + money(Math.abs(p.margin_cents)) +
          (pct ? ' <small>' + pct + '</small>' : '') + '</span></div>' +
        '<label class="pr-c"><span class="pr-l">On hand</span><input class="pr-in" data-k="onhand" inputmode="numeric" autocomplete="off" placeholder="not tracked" value="' + (p.on_hand == null ? '' : p.on_hand) + '" aria-label="On hand"></label>' +
        '<label class="pr-c pr-act"><input type="checkbox" data-k="active"' + (p.active ? ' checked' : '') + ' aria-label="Active"><span class="pr-l">Active</span></label>' +
        '<button type="button" class="pr-more" data-act="more" aria-label="Open all details for ' + esc(p.name) + '">' + (state.open === p.id ? '▴' : '▾') + '</button>' +
      '</div>' +
      '<div class="pr-save" hidden></div>' +
      (state.open === p.id ? detailHtml(p) : '') +
    '</div>';
  }

  function renderList() {
    var box = document.getElementById('pr-list');
    if (!box) return;
    var list = visible();
    box.className = state.counting ? 'counting' : '';
    box.innerHTML =
      '<p class="pr-sum" id="pr-sum"></p>' +
      (list.length
        ? '<div class="pr-table"><div class="pr-head"><span>Product</span><span>Price</span><span>Cost</span><span>Margin</span><span>On hand</span><span>Active</span><span></span></div>' +
          list.map(rowHtml).join('') + '</div>'
        : '<p class="empty-note">No products match. Try a different search or filter.</p>');
    renderSummary();
    updateBulk();
  }

  // The bar at the bottom of the screen while there is unsaved work.
  function updateBulk() {
    var bar = document.getElementById('pr-bulk');
    if (!bar) return;
    var n = dirtyCount();
    if (!n) { bar.hidden = true; bar.innerHTML = ''; return; }
    if (state.busy) return;
    bar.hidden = false;
    bar.innerHTML = '<button type="button" class="btn" data-act="save-all">Save all ' + n + (n === 1 ? ' change' : ' changes') + '</button>' +
      '<button type="button" class="btn ghost" data-act="undo-all">Undo all</button>' +
      '<span class="pr-status" id="pr-bulk-status">' + n + (n === 1 ? ' row has' : ' rows have') + ' unsaved changes</span>';
  }

  // A short result in the bottom bar, since the message box is far above on a long list.
  function flash(text, bad) {
    var bar = document.getElementById('pr-bulk');
    if (!bar || dirtyCount()) return;
    bar.hidden = false;
    bar.innerHTML = '<span class="pr-status pr-flash ' + (bad ? 'err' : 'ok') + '" role="status">' + esc(text) + '</span>';
    clearTimeout(flash.t);
    flash.t = setTimeout(function () { if (!dirtyCount()) updateBulk(); }, 4000);
  }

  // The line above the table: counts, stock value, and a shortcut to what needs ordering.
  function renderSummary() {
    var box = document.getElementById('pr-sum');
    if (!box) return;
    var tracked = state.products.filter(function (p) { return p.on_hand != null && p.on_hand > 0; });
    var value = tracked.reduce(function (n, p) { return n + p.on_hand * (p.cost_cents + p.freight_cents); }, 0);
    var attention = state.products.filter(function (p) { var s = stockState(p); return p.active && (s === 'out' || s === 'low'); }).length;
    box.innerHTML = visible().length + ' of ' + state.products.length + ' products' +
      (tracked.length ? ' · stock on hand is worth ' + money(value) + ' at cost' : '') +
      (attention ? ' · <button type="button" class="link-btn" data-act="show-attention">' + attention + ' low or out</button>' : '');
  }

  // Re-read the products and redraw one row (and the summary), leaving
  // unsaved edits in every other row alone.
  function replaceRow(id, note) {
    var el = itemEl(id), fresh = state.byId[id];
    if (!el) return;
    if (fresh && visible().indexOf(fresh) !== -1) {
      var holder = document.createElement('div');
      holder.innerHTML = rowHtml(fresh);
      el.replaceWith(holder.firstChild);
      if (note) status(itemEl(id), note);
    } else {
      el.remove();
      msg('Saved. “' + (fresh ? fresh.name : 'That product') + '” is hidden by the current filters.', 'success');
    }
  }
  function refreshRow(id, note) {
    return api('GET', '/api/admin/products').then(function (d) {
      apply(d);
      replaceRow(id, note);
      renderSummary();
      updateBulk();
    });
  }

  // A row that did not save: say why, and keep Save and Undo within reach.
  function failBar(el, text) {
    var bar = el.querySelector('.pr-save');
    bar.hidden = false; bar.removeAttribute('data-confirm');
    bar.innerHTML = '<span class="pr-status err">' + esc(text) + '</span>' +
      '<button type="button" class="btn small" data-act="save">Save</button> <button type="button" class="btn ghost small" data-act="undo">Undo</button>';
  }

  // Save every changed row in one go. A price that moved a lot still has to be
  // confirmed on its own row.
  function saveAll() {
    if (state.busy) return;
    var jobs = [].slice.call(host.querySelectorAll('.pr-item.dirty')).map(function (el) {
      var id = el.getAttribute('data-id');
      return { el: el, id: id, c: changes(el, state.byId[id]) };
    });
    if (!jobs.length) return;
    state.busy = true;
    var bar = document.getElementById('pr-bulk');
    bar.innerHTML = '<span class="pr-status" id="pr-bulk-status">Saving ' + jobs.length + '…</span>';
    var saved = [], failed = 0, chain = Promise.resolve();
    jobs.forEach(function (j) {
      chain = chain.then(function () {
        if (j.c.errors.length) { failed++; failBar(j.el, j.c.errors[0]); return; }
        var step = Object.keys(j.c.fields).length ? post({ action: 'save', id: j.id, fields: j.c.fields, confirm: false }) : Promise.resolve();
        return step.then(function () {
          if (j.c.count !== null) return post({ action: 'stock', id: j.id, mode: 'count', counted: j.c.count, note: 'Counted' });
        }).then(function () { saved.push(j.id); }).catch(function (err) {
          failed++;
          failBar(j.el, err.status === 409 ? 'That price changed a lot. Press Save here to confirm it.' : 'Not saved: ' + err.message);
        });
      });
    });
    chain.then(function () { return api('GET', '/api/admin/products'); }).then(function (d) {
      apply(d);
      saved.forEach(function (id) { replaceRow(id, 'Saved ✓'); });
      state.busy = false;
      renderSummary(); updateBulk();
      flash('Saved ' + saved.length + (saved.length === 1 ? ' product ✓' : ' products ✓') + (failed ? ' · ' + failed + ' need attention' : ''), !!failed);
      msg('Saved ' + saved.length + (saved.length === 1 ? ' product' : ' products') + '.' + (failed ? ' ' + failed + ' could not be saved. They are marked below.' : ''), failed ? 'error' : 'success');
    }).catch(function (err) { state.busy = false; msg(err.message, 'error'); updateBulk(); });
  }

  function detailHtml(p) {
    function f(label, key, val, extra) {
      return '<div class="field"><label for="pd-' + key + '">' + label + '</label><input type="text" id="pd-' + key + '" data-d="' + key + '" value="' + esc(val == null ? '' : val) + '"' + (extra || '') + '></div>';
    }
    return '<div class="pr-detail" data-detail>' +
      '<div class="pr-photo"><div class="shot' + (p.image ? '' : ' empty') + '" data-shot>' + (p.image ? '<img src="' + esc(p.image) + '" alt="">' : 'no photo') + '</div>' +
        '<label class="photo-btn" for="pd-file">Replace photo…</label>' +
        '<input type="file" class="visually-hidden" id="pd-file" accept="image/jpeg,image/png,image/gif,image/webp">' +
        '<div class="upload-status" data-upload hidden></div></div>' +
      '<div class="pr-form">' +
        '<div class="form-grid">' +
          f('Name', 'name', p.name, ' maxlength="120"') +
          f('Size', 'unit', p.unit, ' maxlength="40" placeholder="e.g. 50 lbs"') +
          f('Supplier', 'supplier', p.supplier, ' list="pr-suppliers" maxlength="80"') +
          f('SKU', 'sku', p.sku, ' maxlength="40"') +
          f('Weight each (lbs)', 'weight_lbs', p.weight_lbs == null ? '' : p.weight_lbs, ' inputmode="decimal" placeholder="used to share shipping"') +
          f('Category', 'category', p.category, ' list="pr-cats" maxlength="30"') +
          f('Freight added to cost ($)', 'freight', p.freight_cents ? dollars(p.freight_cents) : '', ' inputmode="decimal" placeholder="usually empty"') +
          f('Animals (comma separated)', 'animals', (p.animals || []).join(', '), ' placeholder="Goats, Sheep"') +
          f('Popular rank', 'popular', p.popular || '', ' inputmode="numeric" placeholder="0 = not in Popular"') +
          f('Note (not shown in the store)', 'note', p.note, ' maxlength="200" placeholder="e.g. out until spring"') +
          '<div class="field span2"><label for="pd-description">Description</label><textarea id="pd-description" data-d="description" rows="4">' + esc(p.description) + '</textarea></div>' +
        '</div>' +
        '<div class="check-row" style="margin-bottom:14px"><input type="checkbox" id="pd-taxable" data-d="taxable"' + (p.taxable ? ' checked' : '') + '><label for="pd-taxable">Charge Idaho sales tax on this</label></div>' +
        '<fieldset class="goat-set"><legend>Stock</legend>' +
          '<p class="hint" style="margin:0 0 10px">' + (p.on_hand == null ? 'Not tracked yet. Type a count in the table and save, or receive a purchase, to start.' :
            'On hand: <strong>' + p.on_hand + '</strong>. To fix the number, change the On hand box in the table and press Save (a stock take). To add or remove some, such as spoiled bags, use this:') + '</p>' +
          '<div class="pr-adjust"><input type="text" class="pr-in" id="pd-delta" inputmode="numeric" placeholder="+5 or −2" aria-label="Add or remove">' +
            '<input type="text" class="pr-in" id="pd-delta-note" placeholder="Why? (optional)" maxlength="120" aria-label="Reason">' +
            '<button type="button" class="btn ghost small" data-act="adjust">Apply</button></div>' +
          '<p><button type="button" class="link-btn" data-act="history">Show stock history</button></p><div data-history></div>' +
        '</fieldset>' +
        '<div class="pr-save-bar"><button type="button" class="btn" data-act="save">Save product</button> ' +
          (p.archived ? '<button type="button" class="btn ghost" data-act="restore">Restore</button> ' : '') +
          '<button type="button" class="btn ghost rust-text" data-act="delete">' + (p.archived ? 'Delete…' : 'Delete or archive…') + '</button></div>' +
      '</div></div>';
  }

  // ---- row editing --------------------------------------------------------
  function itemEl(id) {
    var all = host.querySelectorAll('.pr-item');
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-id') === id) return all[i];
    return null;
  }
  function field(el, k) { return el.querySelector('[data-k="' + k + '"]'); }

  // What the row's boxes say now versus what the server last sent.
  function changes(el, p) {
    var c = { fields: {}, errors: [], count: null };
    var price = cents(field(el, 'price').value), cost = cents(field(el, 'cost').value);
    if (price !== null && isNaN(price)) c.errors.push('Price: enter a plain amount like 53.00.');
    if (cost !== null && isNaN(cost)) c.errors.push('Cost: enter a plain amount like 41.50.');
    if (price === null) c.errors.push('Price can’t be blank. Use 0.00 if you mean zero.');
    if (price !== null && !isNaN(price) && price !== p.price_cents) c.fields.price_cents = price;
    if (cost !== null && !isNaN(cost) && cost !== p.cost_cents + p.freight_cents) {
      c.fields.cost_cents = cost; c.fields.freight_cents = 0;
    }
    var act = field(el, 'active').checked;
    if (act !== p.active) c.fields.active = act;
    var oh = field(el, 'onhand').value.trim();
    if (oh !== '' && String(p.on_hand) !== oh) {
      if (!/^\d+$/.test(oh)) c.errors.push('On hand: type a whole number, such as 12.');
      else c.count = parseInt(oh, 10);
    }
    var det = el.querySelector('[data-detail]');
    if (det) {
      var d = function (k) { return det.querySelector('[data-d="' + k + '"]'); };
      var text = { name: 'name', unit: 'unit', supplier: 'supplier', sku: 'sku', category: 'category', note: 'note', description: 'description' };
      Object.keys(text).forEach(function (k) { if (d(k).value !== (p[k] == null ? '' : String(p[k]))) c.fields[k] = d(k).value; });
      var w = d('weight_lbs').value.trim();
      if (w !== (p.weight_lbs == null ? '' : String(p.weight_lbs))) {
        if (w !== '' && !/^\d+(\.\d+)?$/.test(w)) c.errors.push('Weight: enter pounds, such as 40 or 0.75.');
        else c.fields.weight_lbs = w === '' ? null : parseFloat(w);
      }
      var fr = cents(d('freight').value);
      if (isNaN(fr)) c.errors.push('Freight: enter a plain amount like 2.00, or leave it empty.');
      else if ((fr || 0) !== p.freight_cents && !('cost_cents' in c.fields)) { c.fields.freight_cents = fr || 0; }
      var pop = d('popular').value.trim();
      if (pop !== (p.popular ? String(p.popular) : '')) c.fields.popular = pop === '' ? 0 : parseInt(pop, 10) || 0;
      if (d('animals').value !== (p.animals || []).join(', ')) c.fields.animals = d('animals').value;
      if (d('taxable').checked !== p.taxable) c.fields.taxable = d('taxable').checked;
      var staged = el.getAttribute('data-staged-image');
      if (staged) c.fields.image = staged;
    }
    return c;
  }

  function markDirty(el) {
    var p = state.byId[el.getAttribute('data-id')];
    if (!p) return;
    var c = changes(el, p);
    var dirty = c.count !== null || Object.keys(c.fields).length > 0 || c.errors.length > 0;
    el.classList.toggle('dirty', dirty);
    var bar = el.querySelector('.pr-save');
    if (!dirty) { bar.hidden = true; bar.innerHTML = ''; updateBulk(); return; }
    if (bar.getAttribute('data-confirm')) return;      // a price confirmation is showing
    bar.hidden = false;
    bar.innerHTML = '<span class="pr-status">' + (c.errors.length ? esc(c.errors[0]) : 'Unsaved changes') + '</span>' +
      '<button type="button" class="btn small" data-act="save"' + (c.errors.length ? ' disabled' : '') + '>Save</button> ' +
      '<button type="button" class="btn ghost small" data-act="undo">Undo</button>';
    // Live margin while typing.
    var price = cents(field(el, 'price').value), cost = cents(field(el, 'cost').value);
    var m = el.querySelector('[data-margin]');
    if (m && price !== null && cost !== null && !isNaN(price) && !isNaN(cost)) {
      var mc = price - cost;
      m.parentNode.classList.toggle('neg', mc < 0);
      m.innerHTML = (mc < 0 ? '−' : '') + money(Math.abs(mc)) + (price > 0 ? ' <small>' + Math.round((mc / price) * 100) + '%</small>' : '');
    }
    updateBulk();
  }

  function status(el, text, bad) {
    var bar = el.querySelector('.pr-save');
    bar.hidden = false;
    bar.removeAttribute('data-confirm');
    bar.innerHTML = '<span class="pr-status' + (bad ? ' err' : ' ok') + '">' + esc(text) + '</span>';
  }

  // Save a row: fields first, then the stock count. confirmed = she has
  // already said yes to an unusual price.
  function saveRow(id, confirmed) {
    var el = itemEl(id), p = state.byId[id];
    if (!el || !p || state.busy) return;
    var c = changes(el, p);
    if (c.errors.length) { status(el, c.errors[0], true); return; }
    state.busy = true;
    status(el, 'Saving…');
    var job = Promise.resolve();
    if (Object.keys(c.fields).length) {
      job = post({ action: 'save', id: id, fields: c.fields, confirm: !!confirmed });
    }
    return job.then(function () {
      if (c.count !== null) return post({ action: 'stock', id: id, mode: 'count', counted: c.count, note: 'Counted' });
    }).then(function () {
      state.busy = false;
      return refreshRow(id, 'Saved ✓');
    }).catch(function (err) {
      state.busy = false;
      if (err.status === 409 && err.body && err.body.error === 'price_change_needs_confirmation') {
        var bar = el.querySelector('.pr-save');
        bar.hidden = false;
        bar.setAttribute('data-confirm', '1');
        bar.innerHTML = '<div class="alert error confirm-price"><p>' + esc(err.body.message) + '</p>' +
          '<button type="button" class="btn ghost small" data-act="cancel-price">Cancel, let me fix it</button> ' +
          '<button type="button" class="btn rust small" data-act="confirm-price">Yes, save this price</button></div>';
        return;
      }
      failBar(el, 'Not saved: ' + err.message);
    });
  }

  function undoRow(id) {
    var el = itemEl(id), p = state.byId[id];
    if (!el || !p) return;
    var open = state.open === id;
    var fresh = document.createElement('div');
    fresh.innerHTML = rowHtml(p);
    el.replaceWith(fresh.firstChild);
    if (open) state.open = id;
    updateBulk();
  }

  // ---- photo upload -------------------------------------------------------
  function uploadPhoto(el, file) {
    var note = el.querySelector('[data-upload]');
    function say(text, cls) { note.hidden = false; note.textContent = text; note.className = 'upload-status' + (cls ? ' ' + cls : ''); }
    if (file.size > 10 * 1024 * 1024) { say('That photo is larger than 10 MB.', 'bad'); return; }
    say('Uploading…');
    (window.shrinkPhoto ? window.shrinkPhoto(file, 1200, 0.85) : Promise.resolve(file)).then(function (blob) {
      return fetch('/api/admin/upload', { method: 'POST', body: blob, headers: { 'content-type': blob.type || 'application/octet-stream' } });
    }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Upload failed.'); return d; });
    }).then(function (d) {
      el.setAttribute('data-staged-image', d.url);
      var shot = el.querySelector('[data-shot]');
      shot.classList.remove('empty');
      shot.innerHTML = '<img src="' + esc(d.url) + '" alt="">';
      say('Uploaded. Press Save product to use it.', 'ok');
      markDirty(el);
    }).catch(function (err) { say(err.message || 'Upload failed. Check your connection.', 'bad'); });
  }

  function uploadNewPhoto(file) {
    var note = document.getElementById('np-upload'), shot = document.getElementById('np-shot');
    function say(text, cls) { note.hidden = false; note.textContent = text; note.className = 'upload-status' + (cls ? ' ' + cls : ''); }
    if (file.size > 10 * 1024 * 1024) { say('That photo is larger than 10 MB.', 'bad'); return; }
    say('Uploading…');
    (window.shrinkPhoto ? window.shrinkPhoto(file, 1200, 0.85) : Promise.resolve(file)).then(function (blob) {
      return fetch('/api/admin/upload', { method: 'POST', body: blob, headers: { 'content-type': blob.type || 'application/octet-stream' } });
    }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Upload failed.'); return d; });
    }).then(function (d) {
      state.newImage = d.url;
      shot.classList.remove('empty'); shot.innerHTML = '<img src="' + esc(d.url) + '" alt="">';
      say('Photo ready.', 'ok');
    }).catch(function (err) { say(err.message || 'Upload failed. Check your connection.', 'bad'); });
  }

  // ---- stock history ------------------------------------------------------
  var KIND = { purchase: 'Purchase', sale: 'Sale', location_sale: 'Sold at a location', adjust: 'Adjustment', count: 'Stock take' };
  function showHistory(el, id) {
    var box = el.querySelector('[data-history]');
    box.innerHTML = '<p class="hint">Loading…</p>';
    api('GET', '/api/admin/products?moves=' + encodeURIComponent(id)).then(function (d) {
      var rows = d.moves || [];
      box.innerHTML = rows.length ? '<div class="by-category">' + rows.map(function (m) {
        return '<div class="row"><span>' + esc(m.created_at.slice(0, 10)) + ' · ' + esc(KIND[m.kind] || m.kind) +
          (m.location_name ? ' · ' + esc(m.location_name) : '') + (m.note ? ' <span class="n">' + esc(m.note) + '</span>' : '') + '</span>' +
          '<span>' + (m.qty > 0 ? '+' : '−') + Math.abs(m.qty) + '</span></div>';
      }).join('') + '</div>' : '<p class="hint">No stock movement yet.</p>';
    }).catch(function (err) { box.innerHTML = '<p class="alert error">' + esc(err.message) + '</p>'; });
  }

  // ---- events -------------------------------------------------------------
  tab.addEventListener('click', function () {
    if (!state.loaded) { host.innerHTML = '<p class="lede">Loading…</p>'; load(); }
    else if (!dirtyCount()) load();
  });

  host.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'pr-q') { state.f.q = t.value; renderList(); return; }
    var el = t.closest && t.closest('.pr-item');
    if (el) {
      var bar = el.querySelector('.pr-save');
      if (bar.getAttribute('data-confirm')) { bar.removeAttribute('data-confirm'); }
      markDirty(el);
    }
  });
  host.addEventListener('change', function (e) {
    var t = e.target, map = { 'pr-status': 'status', 'pr-category': 'category', 'pr-supplier': 'supplier', 'pr-stock': 'stock', 'pr-sort': 'sort' };
    if (map[t.id]) { state.f[map[t.id]] = t.value; renderList(); return; }
    if (t.id === 'np-file' && t.files && t.files[0]) { uploadNewPhoto(t.files[0]); t.value = ''; return; }
    if (t.id === 'pd-file' && t.files && t.files[0]) { uploadPhoto(t.closest('.pr-item'), t.files[0]); t.value = ''; return; }
    var el = t.closest && t.closest('.pr-item');
    if (el) markDirty(el);
  });
  // Enter saves the row (if it changed) and moves down to the same box in the
  // next row, which is the quick way to count a shelf.
  host.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !e.target.classList.contains('pr-in') || e.target.id === 'pd-delta' || e.target.id === 'pd-delta-note') return;
    e.preventDefault();
    var el = e.target.closest('.pr-item'), key = e.target.getAttribute('data-k');
    var nextEl = el.nextElementSibling, nextId = nextEl && nextEl.getAttribute('data-id');
    var go = function () {
      var n = nextId ? itemEl(nextId) : null, box = n && n.querySelector('[data-k="' + key + '"]');
      if (box) { box.focus(); box.select(); box.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    };
    if (el.classList.contains('dirty')) {
      var p = saveRow(el.getAttribute('data-id'));
      Promise.resolve(p).then(function () { var cur = itemEl(el.getAttribute('data-id')); if (!cur || !cur.classList.contains('dirty')) go(); });
    } else go();
  });

  host.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    var el = b.closest('.pr-item');
    var id = el && el.getAttribute('data-id');
    var p = id && state.byId[id];

    if (act === 'save-all') return saveAll();
    if (act === 'undo-all') { host.querySelectorAll('.pr-item.dirty').forEach(function (d) { undoRow(d.getAttribute('data-id')); }); updateBulk(); return; }
    if (act === 'count-mode') {
      if (dirtyCount() && !window.confirm('You have unsaved changes. Switch anyway? They will be lost.')) return;
      state.counting = !state.counting; state.open = null; state.creating = false;
      if (state.counting) { state.f.status = 'active'; }
      render(); return;
    }
    if (act === 'new') { state.creating = !state.creating; renderNew(); return; }
    if (act === 'new-cancel') { state.creating = false; renderNew(); return; }
    if (act === 'show-attention') { state.f.stock = 'attention'; state.f.status = 'active'; render(); return; }
    if (act === 'create') {
      var st = document.getElementById('np-status');
      var price = cents(document.getElementById('np-price').value), cost = cents(document.getElementById('np-cost').value);
      if (isNaN(price) || isNaN(cost)) { st.textContent = 'Price and cost should be plain amounts like 12.50.'; return; }
      var fields = {
        name: document.getElementById('np-name').value, unit: document.getElementById('np-unit').value,
        supplier: document.getElementById('np-supplier').value, sku: document.getElementById('np-sku').value,
        price_cents: price || 0, cost_cents: cost || 0,
        weight_lbs: document.getElementById('np-weight').value.trim(),
        description: document.getElementById('np-description').value, image: state.newImage,
        active: document.getElementById('np-active').checked,
      };
      if (!fields.name.trim()) { st.textContent = 'Give it a name first.'; document.getElementById('np-name').focus(); return; }
      if (fields.active && !price) { st.textContent = 'Enter a price before putting it in the store, or untick “Put it in the store right away”.'; return; }
      b.disabled = true; st.textContent = 'Creating…';
      post({ action: 'create', fields: fields }).then(function (r) {
        state.creating = false; state.open = r.id;
        state.f.status = 'all'; state.f.q = fields.name;
        return load().then(function () {
          msg(fields.active ? 'Created and in the store.' : 'Created. It is switched off until you tick Active.', 'success');
          var made = itemEl(r.id); if (made) made.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }).catch(function (err) { st.textContent = 'Not created: ' + err.message; b.disabled = false; });
      return;
    }
    if (!el || !p) return;

    if (act === 'more') {
      var det = el.querySelector('[data-detail]');
      // Nothing unsaved anywhere: redraw. Otherwise open or close just this
      // row so edits in other rows are not lost.
      if (!dirtyCount()) {
        state.open = state.open === id ? null : id;
        renderList();
        var shown = itemEl(id);
        if (shown && state.open) shown.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      if (det) { det.remove(); el.classList.remove('open'); if (state.open === id) state.open = null; }
      else { var holder = document.createElement('div'); holder.innerHTML = detailHtml(p); el.appendChild(holder.firstChild); el.classList.add('open'); state.open = id; }
      return;
    }
    if (act === 'save') return saveRow(id, false);
    if (act === 'confirm-price') return saveRow(id, true);
    if (act === 'cancel-price') { el.querySelector('.pr-save').removeAttribute('data-confirm'); markDirty(el); return; }
    if (act === 'undo') return undoRow(id);
    if (act === 'history') return showHistory(el, id);
    if (act === 'adjust') {
      var delta = document.getElementById('pd-delta').value.replace(/[−–]/g, '-').replace(/^\+/, '').trim();
      if (!/^-?\d+$/.test(delta) || +delta === 0) { window.alert('Type how many to add or take off, such as 5 or -2.'); return; }
      b.disabled = true;
      post({ action: 'stock', id: id, mode: 'adjust', delta: parseInt(delta, 10), note: document.getElementById('pd-delta-note').value }).then(function () {
        return refreshRow(id, 'Stock adjusted ✓');
      }).catch(function (err) { window.alert(err.message); b.disabled = false; });
      return;
    }
    if (act === 'restore') {
      post({ action: 'save', id: id, fields: { archived: false } }).then(function () { return load(); })
        .then(function () { msg('Restored. It is still switched off. Tick Active to sell it.', 'success'); })
        .catch(function (err) { msg(err.message, 'error'); });
      return;
    }
    if (act === 'delete') {
      if (!window.confirm('Delete “' + p.name + '”?\n\nIf it has ever been sold, bought or counted it is hidden (archived) instead of erased, so old orders still make sense. Otherwise it is removed for good.')) return;
      post({ action: 'delete', id: id }).then(function (r) {
        state.open = null;
        return load().then(function () { msg(r.archived ? '“' + p.name + '” has history, so it was archived instead of deleted.' : 'Deleted.', 'success'); });
      }).catch(function (err) { msg(err.message, 'error'); });
      return;
    }
  });

  // The Purchases tab can add products; keep this list fresh when it does.
  document.addEventListener('products-changed', function () { state.loaded = false; });
})();
