/* Admin — Location sales tab.
 * ---------------------------------------------------------------------
 * A shop that sells your goods sends a statement, such as the monthly
 * Shopify report from Johnson's Heritage Farmstead. Enter it here the way it
 * is printed: product, qty, gross, discounts, net, taxes, total. Net and
 * total work themselves out but can be typed over, and anything sold outside
 * the report (a milk sale you wrote down) is just another line. The payout is
 * what the shop owes you; it starts as net less the shop's cut and can be
 * typed over too.
 *
 * Saving takes the sold items out of stock and adds one entry to your sales
 * books (worker.js, adminLocationReports). The sums shown while typing repeat
 * reportTotals() there so they match what is saved.
 */
(function () {
  'use strict';

  var host = document.getElementById('location-sales-app');
  var tab = document.getElementById('tab-location-sales');
  if (!host || !tab) return;

  var state = { list: [], locations: [], products: [], loaded: false, ed: null, busy: false, dirty: false };

  // ---- helpers ----------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(c) { return '$' + (Math.round(Number(c) || 0) / 100).toFixed(2); }
  function dollars(c) { return (Math.round(Number(c) || 0) / 100).toFixed(2); }
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
  function locById(id) {
    for (var i = 0; i < state.locations.length; i++) if (state.locations[i].id === id) return state.locations[i];
    return null;
  }
  function note(text, kind) {
    var el = document.getElementById('ls-msg');
    if (el) el.innerHTML = text ? '<p class="alert ' + (kind || 'success') + '" role="status">' + esc(text) + '</p>' : '';
    if (el && text && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---- loading ----------------------------------------------------------
  function load() {
    return Promise.all([
      api('GET', '/api/admin/location-reports'), api('GET', '/api/admin/locations'), api('GET', '/api/admin/products'),
    ]).then(function (r) {
      state.list = r[0].reports || [];
      state.locations = (r[1].locations || []);
      state.products = (r[2].products || []).filter(function (p) { return !p.archived; })
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
    host.innerHTML = '<div id="ls-msg"></div>' +
      '<p><button type="button" class="btn" data-act="new">New report</button></p>' +
      (state.list.length ? '<div class="ad-list">' + state.list.map(function (r) {
        return '<div class="ad-item">' +
          '<div class="ad-main"><strong>' + esc(r.location_name || r.location_id) + '</strong> · ' + esc(r.period_label) + ' ' +
            (r.paid_at ? '<span class="chip done">Paid ' + esc(fmtDate(r.paid_at)) + '</span>' : '<span class="chip pr-low">Owed to us</span>') +
            '<div class="meta">Sold ' + money(r.net_cents) + (r.commission_cents ? ' · shop’s cut ' + money(r.commission_cents) : '') +
              (r.paid_at && r.paid_method ? ' · paid by ' + esc(r.paid_method) : '') + '</div></div>' +
          '<div class="ad-amt" title="What the shop pays us">' + money(r.payout_cents) + '</div>' +
          '<div class="acts"><button type="button" class="btn small" data-act="edit" data-id="' + esc(r.id) + '">Open</button>' +
            '<button type="button" class="btn ghost small" data-act="dup" data-id="' + esc(r.id) + '" title="Start the next report with the same products">Duplicate</button></div>' +
        '</div>';
      }).join('') + '</div>' : '<p class="empty-note">No reports yet. When a shop sends you its sales statement, press New report and enter it.</p>');
  }

  // ---- editor ---------------------------------------------------------------
  function blankLine() { return { product_id: '', text: '', name: '', qty: '', gross: '', discount: '', net: '', tax: '', total: '' }; }

  function monthLabel(d) { return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); }

  function newReport() {
    var now = new Date();
    var prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var end = new Date(now.getFullYear(), now.getMonth(), 0);
    function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    var shops = state.locations.filter(function (l) { return l.active && l.kind !== 'farm'; });
    return {
      id: null, location_id: shops.length ? shops[0].id : '', period_label: monthLabel(prev), period_start: ymd(prev), period_end: ymd(end),
      extra_tax: '', commission: '', payout: '', note: '', paid_at: null, paid_method: null, lines: [blankLine()],
    };
  }

  // Turn a saved report back into form values. A figure that equals what the
  // page would have worked out is left blank, so it keeps following the other
  // boxes; one that differs was typed over, so it stays typed.
  function fromReport(r, asCopy) {
    var loc = locById(r.location_id) || { commission_bps: 0 };
    var lineTax = 0;
    var lines = r.lines.map(function (l) {
      lineTax += l.tax_cents;
      var autoNet = Math.max(0, l.gross_cents - l.discount_cents);
      var autoTotal = l.net_cents + l.tax_cents;
      var prod = l.product_id && byId(l.product_id);
      var base = { product_id: l.product_id || '', text: prod ? label(prod) : l.name, name: l.name };
      if (asCopy) return Object.assign(base, { qty: '', gross: '', discount: '', net: '', tax: '', total: '' });
      return Object.assign(base, {
        qty: String(l.qty), gross: dollars(l.gross_cents), discount: l.discount_cents ? dollars(l.discount_cents) : '',
        net: l.net_cents === autoNet ? '' : dollars(l.net_cents), tax: l.tax_cents ? dollars(l.tax_cents) : '',
        total: l.total_cents === autoTotal ? '' : dollars(l.total_cents),
      });
    });
    var autoCut = Math.round((r.net_cents * (loc.commission_bps || 0)) / 10000);
    var extra = r.tax_cents - lineTax;
    var ed = {
      id: asCopy ? null : r.id, location_id: r.location_id, period_label: asCopy ? '' : r.period_label,
      period_start: asCopy ? '' : (r.period_start || ''), period_end: asCopy ? '' : (r.period_end || ''),
      extra_tax: asCopy || !extra ? '' : dollars(extra),
      commission: asCopy || r.commission_cents === autoCut ? '' : dollars(r.commission_cents),
      payout: asCopy || r.payout_cents === r.net_cents - r.commission_cents ? '' : dollars(r.payout_cents),
      note: asCopy ? '' : (r.note || ''), paid_at: asCopy ? null : r.paid_at, paid_method: asCopy ? null : r.paid_method, lines: lines,
    };
    if (asCopy) {
      var next = newReport();
      ed.period_label = next.period_label; ed.period_start = next.period_start; ed.period_end = next.period_end;
    }
    return ed;
  }

  function openEditor(ed) {
    state.ed = ed; state.dirty = false;
    renderEditor();
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function lineHtml(l, i) {
    function box(k, lbl, extra) {
      return '<label class="ed-c"><span class="m-lbl">' + lbl + '</span><input type="text" inputmode="' + (k === 'qty' ? 'numeric' : 'decimal') + '" data-k="' + k + '" value="' + esc(l[k]) + '"' + (extra || '') + '></label>';
    }
    return '<div class="ed-line ls-line" data-i="' + i + '">' +
      '<label class="ed-c what"><span class="m-lbl">Product</span><input type="text" list="ls-products" data-k="text" value="' + esc(l.text) + '" placeholder="Type a name or SKU…" autocomplete="off" autocapitalize="off"></label>' +
      box('qty', 'Qty') + box('gross', 'Gross $', ' placeholder="0.00"') + box('discount', 'Discounts $', ' placeholder="0.00"') +
      box('net', 'Net $', ' placeholder="auto"') + box('tax', 'Taxes $', ' placeholder="0.00"') + box('total', 'Total $', ' placeholder="auto"') +
      '<button type="button" class="btn ghost small" data-act="remove" data-i="' + i + '" aria-label="Remove this line" tabindex="-1">✕</button>' +
      '<div class="ed-note" data-note' + (l.msg ? ' data-kind="match">' + esc(l.msg) : ' hidden>') + '</div>' +
    '</div>';
  }

  function renderEditor() {
    var e = state.ed;
    var shops = state.locations.filter(function (l) { return (l.active || l.id === e.location_id) && l.kind !== 'farm'; });
    var paidBox = '';
    if (e.id) {
      paidBox = e.paid_at
        ? '<p>Paid on <strong>' + esc(fmtDate(e.paid_at)) + '</strong>' + (e.paid_method ? ' by ' + esc(e.paid_method) : '') +
          ' <button type="button" class="link-btn" data-act="unpaid">Mark as not paid</button></p>'
        : '<div class="ls-paid"><span>Has the shop paid you?</span> <input type="date" id="ls-paid-at" value="' + today() + '" aria-label="Date paid">' +
          '<select id="ls-paid-method" aria-label="How paid"><option>check</option><option>cash</option><option>bank transfer</option><option>Venmo</option><option>other</option></select>' +
          '<button type="button" class="btn small" data-act="paid">Mark paid</button></div>';
    }
    host.innerHTML =
      '<datalist id="ls-products">' + state.products.map(function (p) { return '<option value="' + esc(label(p)) + '">'; }).join('') + '</datalist>' +
      '<p><button type="button" class="link-btn" data-act="back">← All reports</button></p>' +
      '<div id="ls-msg"></div>' +
      '<fieldset class="goat-set"><legend>' + (e.id ? 'Report' : 'New report') + '</legend><div class="form-grid">' +
        '<div class="field"><label for="ls-loc">Location</label><select id="ls-loc">' +
          (shops.length ? '' : '<option value="">Add a location first (Locations tab)</option>') +
          shops.map(function (l) { return '<option value="' + esc(l.id) + '"' + (e.location_id === l.id ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="ls-label">Report name</label><input type="text" id="ls-label" maxlength="60" value="' + esc(e.period_label) + '" placeholder="e.g. Sep 2026"></div>' +
        '<div class="field"><label for="ls-start">From</label><input type="date" id="ls-start" value="' + esc(e.period_start) + '"></div>' +
        '<div class="field"><label for="ls-end">To <span class="lbl-note">counts as the sale date</span></label><input type="date" id="ls-end" value="' + esc(e.period_end) + '"></div>' +
      '</div></fieldset>' +
      '<fieldset class="goat-set"><legend>What sold</legend>' +
        '<div class="ed-head ls-line"><span>Product</span><span>Qty</span><span>Gross</span><span>Discounts</span><span>Net</span><span>Taxes</span><span>Total</span><span></span></div>' +
        '<div id="ls-lines">' + e.lines.map(lineHtml).join('') + '</div>' +
        '<p style="margin:10px 0 14px"><button type="button" class="btn ghost small" data-act="add">Add a line</button></p>' +
        '<div class="hint">Copy the report’s columns. If the report got a discount wrong, just fix the <strong>Discounts</strong> box; Net follows it. ' +
          'Leave Net and Total empty unless you really need to override them. ' +
          'Something sold outside the report, such as 2 quarts of milk you wrote down, is just another line. Press Enter to move across a line.</div>' +
        '<div class="inv-totals" id="ls-totals" style="margin-top:16px"></div>' +
      '</fieldset>' +
      '<fieldset class="goat-set"><legend>What the shop owes you</legend><p class="hint" style="margin:0 0 12px">This is worked out for you from the lines above, so you can usually leave all three boxes empty.</p><div class="form-grid">' +
        '<div class="field"><label for="ls-xtax">Tax shown once for the whole report $ <span class="lbl-note">only if the lines have no tax</span></label><input type="text" id="ls-xtax" inputmode="decimal" value="' + esc(e.extra_tax) + '" placeholder="0.00"></div>' +
        '<div class="field"><label for="ls-cut">Shop’s cut $ <span class="lbl-note">blank = the location’s usual percentage</span></label><input type="text" id="ls-cut" inputmode="decimal" value="' + esc(e.commission) + '" placeholder="auto"></div>' +
        '<div class="field span2"><label for="ls-payout">Payout $ <span class="lbl-note">blank = net sales less the shop’s cut. Type your own figure if you worked out something different.</span></label><input type="text" id="ls-payout" inputmode="decimal" value="' + esc(e.payout) + '" placeholder="auto"></div>' +
      '</div>' + paidBox + '</fieldset>' +
      '<fieldset class="goat-set"><legend>Notes (optional)</legend><div class="field"><textarea id="ls-note" rows="2" maxlength="1000">' + esc(e.note) + '</textarea></div></fieldset>' +
      '<div class="goat-save"><button type="button" class="btn" data-act="save">Save report</button>' +
        '<strong class="ls-owed" id="ls-owed" aria-live="polite"></strong>' +
        (e.id ? '<button type="button" class="btn ghost rust-text" data-act="delete">Delete…</button>' : '') +
        '<span id="ls-status" aria-live="polite"></span></div>';
    recalc();
  }

  function readForm() {
    var e = state.ed;
    function v(id) { var el = document.getElementById(id); return el ? el.value : ''; }
    e.location_id = v('ls-loc'); e.period_label = v('ls-label'); e.period_start = v('ls-start'); e.period_end = v('ls-end');
    e.extra_tax = v('ls-xtax'); e.commission = v('ls-cut'); e.payout = v('ls-payout'); e.note = v('ls-note');
  }

  // The same sums as reportTotals() in worker.js. n(x) is a money box as
  // cents, 0 when blank or not a number; over(x) is null when blank.
  function n(x) { var c = cents(x); return c === null || isNaN(c) ? 0 : c; }
  function over(x) { var c = cents(x); return c === null || isNaN(c) ? null : c; }
  function totals() {
    var e = state.ed, t = { gross: 0, discount: 0, net: 0, tax: 0, total: 0, lines: [] };
    e.lines.forEach(function (l) {
      var gross = n(l.gross), disc = n(l.discount), tax = n(l.tax);
      var net = over(l.net); if (net === null) net = Math.max(0, gross - disc);
      var tot = over(l.total); if (tot === null) tot = net + tax;
      t.lines.push({ net: net, total: tot });
      t.gross += gross; t.discount += disc; t.net += net; t.tax += tax; t.total += tot;
    });
    var x = n(document.getElementById('ls-xtax').value);
    t.tax += x; t.total += x;
    var loc = locById(document.getElementById('ls-loc').value) || { commission_bps: 0 };
    var cut = over(document.getElementById('ls-cut').value);
    t.cutAuto = Math.round((t.net * (loc.commission_bps || 0)) / 10000);
    t.cut = cut === null ? t.cutAuto : cut;
    var pay = over(document.getElementById('ls-payout').value);
    t.payoutAuto = t.net - t.cut;
    t.payout = pay === null ? t.payoutAuto : pay;
    return t;
  }

  function recalc() {
    if (!state.ed || !document.getElementById('ls-totals')) return;
    var t = totals();
    var els = document.querySelectorAll('#ls-lines .ls-line');
    for (var i = 0; i < els.length; i++) {
      els[i].querySelector('[data-k="net"]').placeholder = dollars(t.lines[i].net);
      els[i].querySelector('[data-k="total"]').placeholder = dollars(t.lines[i].total);
      var l = state.ed.lines[i], bits = [], note = els[i].querySelector('[data-note]');
      var gross = n(l.gross) - n(l.discount), typedNet = over(l.net);
      if (typedNet !== null && typedNet !== Math.max(0, gross)) {
        bits.push('Net is typed in as ' + money(typedNet) + ' but gross less discounts is ' + money(Math.max(0, gross)) +
          '. <button type="button" class="link-btn" data-act="clear-net" data-i="' + i + '">Use ' + money(Math.max(0, gross)) + '</button>');
      }
      var typedTot = over(l.total);
      if (typedTot !== null && typedTot !== t.lines[i].net + n(l.tax)) {
        bits.push('Total is typed in as ' + money(typedTot) + ' but net plus taxes is ' + money(t.lines[i].net + n(l.tax)) +
          '. <button type="button" class="link-btn" data-act="clear-total" data-i="' + i + '">Use ' + money(t.lines[i].net + n(l.tax)) + '</button>');
      }
      if (l.msg) bits.unshift(esc(l.msg));
      note.hidden = !bits.length;
      note.innerHTML = bits.join('<br>');
    }
    document.getElementById('ls-cut').placeholder = dollars(t.cutAuto);
    document.getElementById('ls-payout').placeholder = dollars(t.payoutAuto);
    document.getElementById('ls-totals').innerHTML =
      '<div class="row"><span>Gross sales</span><span>' + money(t.gross) + '</span></div>' +
      '<div class="row"><span>Discounts</span><span>−' + money(t.discount) + '</span></div>' +
      '<div class="row"><span>Net sales</span><span>' + money(t.net) + '</span></div>' +
      '<div class="row"><span>Taxes on the report</span><span>' + money(t.tax) + '</span></div>' +
      '<div class="row"><span>Total on the report</span><span>' + money(t.total) + '</span></div>' +
      (t.cut ? '<div class="row"><span>Shop’s cut</span><span>−' + money(t.cut) + '</span></div>' : '') +
      '<div class="row total"><span>' + esc(shopName()) + ' owes you</span><span>' + money(t.payout) + '</span></div>' +
      (t.payout !== t.payoutAuto
        ? '<p class="alert error" role="status" style="margin:10px 0 0">You typed your own payout of ' + money(t.payout) + '. The lines above work out to ' + money(t.payoutAuto) +
          ' (a ' + money(Math.abs(t.payout - t.payoutAuto)) + (t.payout > t.payoutAuto ? ' difference in your favor' : ' difference against you') +
          '). Empty the Payout box to follow the lines.</p>' : '');
    var owed = document.getElementById('ls-owed');
    if (owed) owed.textContent = 'Owed to us: ' + money(t.payout);
  }

  function shopName() {
    var el = document.getElementById('ls-loc'), loc = el && locById(el.value);
    return loc ? loc.name : 'The shop';
  }

  function save(btn) {
    if (state.busy) return;
    readForm();
    var e = state.ed, status = document.getElementById('ls-status');
    var lines = [];
    for (var i = 0; i < e.lines.length; i++) {
      var l = e.lines[i];
      if (!l.text.trim() && !l.qty && !l.gross) continue;            // an empty row
      var bad = ['gross', 'discount', 'net', 'tax', 'total'].filter(function (k) { return isNaN(cents(l[k])); })[0];
      if (bad) { status.textContent = 'Line ' + (i + 1) + ': the ' + bad + ' box should be an amount like 21.00.'; return; }
      if (!(parseInt(l.qty, 10) > 0)) { status.textContent = 'Line ' + (i + 1) + ': enter how many were sold (Qty).'; return; }
      if (!l.product_id && !l.text.trim()) { status.textContent = 'Line ' + (i + 1) + ': choose or describe the product.'; return; }
      lines.push({
        product_id: l.product_id || null, name: l.product_id ? '' : l.text, qty: parseInt(l.qty, 10),
        gross_cents: cents(l.gross) || 0, discount_cents: cents(l.discount) || 0, net_cents: over(l.net), tax_cents: cents(l.tax) || 0, total_cents: over(l.total),
      });
    }
    var xt = cents(e.extra_tax), cut = cents(e.commission), pay = cents(e.payout);
    if (isNaN(xt) || isNaN(cut) || isNaN(pay)) { status.textContent = 'Tax, the shop’s cut and the payout should be plain amounts like 162.00.'; return; }
    state.busy = true; btn.disabled = true; status.textContent = 'Saving…';
    api('POST', '/api/admin/location-reports', {
      action: 'save', id: e.id, location_id: e.location_id, period_label: e.period_label, period_start: e.period_start, period_end: e.period_end,
      extra_tax_cents: xt || 0, commission_cents: cut, payout_cents: pay, note: e.note, lines: lines,
    }).then(function (r) {
      state.busy = false; state.ed = null; state.dirty = false;
      return load().then(function () {
        renderList();
        note('Saved. The shop pays you ' + money(r.payout_cents) + '. Stock and your sales books are updated.');
      });
    }).catch(function (err) {
      state.busy = false; btn.disabled = false;
      status.textContent = 'Not saved: ' + err.message;
    });
  }

  // ---- events -------------------------------------------------------------
  tab.addEventListener('click', function () {
    if (state.ed && document.getElementById('ls-lines')) return;
    host.innerHTML = '<p class="lede">Loading…</p>';
    state.ed = null;
    load().then(renderList);
  });
  document.addEventListener('locations-changed', function () { state.loaded = false; });

  function markDirty() {
    if (state.dirty) return;
    state.dirty = true;
    var st = document.getElementById('ls-status');
    if (st && !st.textContent) st.textContent = 'Not saved yet';
  }
  AdminUI.guardLeaving(function () { return !!(state.ed && state.dirty); });
  AdminUI.lineKeys(host, '.ls-line', 'total', function () {
    readForm(); state.ed.lines.push(blankLine()); renderEditor();
    var all = document.querySelectorAll('#ls-lines [data-k="text"]'); all[all.length - 1].focus();
  });

  // The store price for the quantity, as a starting point for Gross. It keeps
  // following Qty until the gross is typed over.
  function suggestGross(row, l) {
    var p = l.product_id && byId(l.product_id), q = parseInt(l.qty, 10);
    if (!p || !(q > 0) || (l.gross && !l.grossAuto)) return;
    l.gross = dollars(p.price_cents * q); l.grossAuto = true;
    row.querySelector('[data-k="gross"]').value = l.gross;
  }

  host.addEventListener('input', function (ev) {
    var t = ev.target, ed = state.ed;
    if (!ed) return;
    markDirty();
    var row = t.closest('.ls-line');
    if (row && row.parentNode.id === 'ls-lines') {
      var l = ed.lines[+row.getAttribute('data-i')], k = t.getAttribute('data-k');
      l[k] = t.value;
      if (k === 'gross') l.grossAuto = false;
      if (k === 'text') {
        var p = byLabel(t.value);
        l.product_id = p ? p.id : '';
        l.name = p ? p.name : t.value;
        suggestGross(row, l);
      }
      if (k === 'qty') suggestGross(row, l);
    }
    recalc();
  });

  // Typed text that isn't a list entry word for word: match it on SKU, name or
  // words, and say so when it can't be matched.
  function resolveLine(row, input) {
    var l = state.ed.lines[+row.getAttribute('data-i')];
    var note = row.querySelector('[data-note]');
    l.msg = '';
    if (!input.value.trim()) { l.product_id = ''; l.name = ''; }
    else {
      var hit = AdminUI.findProduct(state.products, input.value, label);
      if (hit.product) {
        var p = hit.product;
        l.product_id = p.id; l.name = p.name; l.text = label(p);
        input.value = l.text;
        suggestGross(row, l);
      } else {
        l.product_id = ''; l.name = input.value;
        if (hit.many > 1) l.msg = hit.many + ' products match. Pick one from the list, or type more of the name.';
        else if (input.value.trim().length > 2) l.msg = 'Not in your product list. That is fine for something one-off, but it won’t take anything out of stock.';
      }
    }
    note.removeAttribute('data-kind'); note.hidden = !l.msg; note.textContent = l.msg;
    if (l.msg) note.setAttribute('data-kind', 'match');
    recalc();
  }

  host.addEventListener('change', function (ev) {
    if (!state.ed) return;
    if (ev.target.id === 'ls-loc') { recalc(); return; }
    var row = ev.target.closest && ev.target.closest('.ls-line');
    if (row && row.parentNode.id === 'ls-lines' && ev.target.getAttribute('data-k') === 'text') resolveLine(row, ev.target);
  });

  host.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (act === 'new') return openEditor(newReport());
    if (act === 'back') {
      if (state.ed && !window.confirm('Leave without saving this report?')) return;
      return load().then(renderList);
    }
    if (act === 'edit' || act === 'dup') {
      b.disabled = true;
      api('GET', '/api/admin/location-reports?id=' + encodeURIComponent(id)).then(function (d) {
        openEditor(fromReport(d.report, act === 'dup'));
      }).catch(function (err) { note(err.message, 'error'); b.disabled = false; });
      return;
    }
    if (!state.ed) return;
    if (act === 'add') { readForm(); state.ed.lines.push(blankLine()); renderEditor(); var all = document.querySelectorAll('#ls-lines [data-k="text"]'); all[all.length - 1].focus(); return; }
    if (act === 'remove') {
      readForm();
      state.ed.lines.splice(+b.getAttribute('data-i'), 1);
      if (!state.ed.lines.length) state.ed.lines.push(blankLine());
      return renderEditor();
    }
    if (act === 'clear-net' || act === 'clear-total') {
      var li = +b.getAttribute('data-i');
      state.ed.lines[li][act === 'clear-net' ? 'net' : 'total'] = '';
      var box = document.querySelector('#ls-lines .ls-line[data-i="' + li + '"] [data-k="' + (act === 'clear-net' ? 'net' : 'total') + '"]');
      if (box) box.value = '';
      return recalc();
    }
    if (act === 'save') return save(b);
    if (act === 'paid' || act === 'unpaid') {
      b.disabled = true;
      api('POST', '/api/admin/location-reports', act === 'paid'
        ? { action: 'mark_paid', id: state.ed.id, paid_at: document.getElementById('ls-paid-at').value, method: document.getElementById('ls-paid-method').value }
        : { action: 'mark_paid', id: state.ed.id, paid: false }
      ).then(function () {
        readForm();
        return api('GET', '/api/admin/location-reports?id=' + encodeURIComponent(state.ed.id));
      }).then(function (d) {
        state.ed.paid_at = d.report.paid_at; state.ed.paid_method = d.report.paid_method;
        renderEditor();
        note(act === 'paid' ? 'Marked as paid.' : 'Marked as not paid.');
      }).catch(function (err) { note(err.message, 'error'); b.disabled = false; });
      return;
    }
    if (act === 'delete') {
      if (!window.confirm('Delete this report? The stock it took out is put back and its entry in your sales books is removed.')) return;
      b.disabled = true;
      api('POST', '/api/admin/location-reports', { action: 'delete', id: state.ed.id }).then(function () {
        state.ed = null;
        return load().then(function () { renderList(); note('Report deleted.'); });
      }).catch(function (err) { note(err.message, 'error'); b.disabled = false; });
    }
  });
})();
