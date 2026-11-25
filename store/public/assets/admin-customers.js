/* Admin — Customers tab.
 * ---------------------------------------------------------------------
 * Everyone the store knows: see them all, add someone, change their details
 * and their two special settings (tax-exempt, trusted), or remove them.
 * Saves go to /api/admin/customers (worker.js, adminCustomers). A customer's
 * orders and old Shopify purchases are never touched from here.
 *
 * The email is who a customer is — their orders, purchase history and
 * sign-in are all matched by it — so it can be typed when adding but is
 * fixed afterwards. A different email is a different customer.
 */
(function () {
  'use strict';

  var host = document.getElementById('customers-app');
  var tab = document.getElementById('tab-customers');
  if (!host || !tab) return;

  var state = { list: [], historyOnly: [], filter: '', editing: null, isNew: false, dirty: false, busy: false, csv: '', previewId: 0, viewing: null, cameFrom: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, body) {
    return fetch('/api/admin/customers' + (method === 'GET' ? '?detail=1' : ''), {
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
  function profileApi(email) {
    return fetch('/api/admin/customers?email=' + encodeURIComponent(email)).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('Request failed (' + r.status + ')'));
        return d;
      });
    });
  }
  function note(text, kind) {
    var el = document.getElementById('cu-msg');
    if (el) el.innerHTML = text ? '<p class="alert ' + (kind || 'success') + '">' + esc(text) + '</p>' : '';
  }
  function money(c) { return '$' + (Math.round(Number(c) || 0) / 100).toFixed(2); }
  var STATUS = { captured: 'Paid', recorded: 'Paid', authorized: 'Card on hold', pending: 'Pending', processing: 'Bank transfer on its way',
    awaiting_cash: 'Cash at pickup', invoiced: 'Invoice not paid yet', canceled: 'Canceled', refunded: 'Refunded', failed: 'Failed', abandoned: 'Abandoned' };
  function statusName(s) { return STATUS[s] || s; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function val(id) { return document.getElementById(id).value; }
  function checked(id) { return document.getElementById(id).checked; }
  function isoDay(s) { return String(s || '').slice(0, 10); }

  function load() {
    return api('GET').then(function (d) {
      state.list = d.customers || [];
      state.historyOnly = d.history_only || [];
      // The invoice form keeps its own copy of this list; have it fetch again.
      document.dispatchEvent(new CustomEvent('customers-changed'));
    }).catch(function (err) {
      host.innerHTML = '<div id="cu-msg"></div>';
      note(err.message, 'error');
      throw err;
    });
  }

  // ---- the list ---------------------------------------------------------------
  function matches(c, q) {
    if (!q) return true;
    var hay = [c.name, c.email, c.phone, c.notes].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }

  function rowHtml(c) {
    var chips = (c.tax_exempt ? ' <span class="chip">Tax-exempt</span>' : '') + (c.trusted ? ' <span class="chip done">Trusted</span>' : '');
    var bits = [c.name ? c.email : '', c.phone || ''].filter(Boolean);
    var orders = plural(c.paid_orders || 0, 'paid order', 'paid orders');
    var old = c.history_lines ? plural(c.history_lines, 'old Shopify line', 'old Shopify lines') : 'no Shopify history';
    bits.push(orders, old);
    return '<div class="ad-item">' +
      '<div class="ad-main"><strong>' + esc(c.name || c.email) + '</strong>' + chips +
        '<div class="meta">' + esc(bits.join(' · ')) + '</div>' +
        (c.notes ? '<div class="meta">' + esc(c.notes.length > 120 ? c.notes.slice(0, 117) + '…' : c.notes) + '</div>' : '') + '</div>' +
      '<div class="ad-amt"></div>' +
      '<div class="acts"><button type="button" class="btn small" data-act="open" data-email="' + esc(c.email) + '">Open</button>' +
        '<button type="button" class="btn small ghost" data-act="invoice" data-email="' + esc(c.email) + '">Invoice</button></div>' +
    '</div>';
  }

  // People who only appear in old Shopify purchases (no customer record yet).
  function historyRow(h) {
    return '<div class="ad-item">' +
      '<div class="ad-main"><strong>' + esc(h.email) + '</strong>' +
        '<div class="meta">' + esc(plural(h.lines, 'old Shopify line', 'old Shopify lines') + ' · last bought ' + isoDay(h.last_purchase)) + '</div></div>' +
      '<div class="ad-amt"></div>' +
      '<div class="acts"><button type="button" class="btn small" data-act="open" data-email="' + esc(h.email) + '">Open</button>' +
        '<button type="button" class="btn small ghost" data-act="invoice" data-email="' + esc(h.email) + '">Invoice</button>' +
        '<button type="button" class="btn small ghost" data-act="add-from-history" data-email="' + esc(h.email) + '">Add as customer</button></div>' +
    '</div>';
  }

  function listHtml() {
    var shown = state.list.filter(function (c) { return matches(c, state.filter); });
    var oldOnes = state.filter ? state.historyOnly.filter(function (h) { return matches({ email: h.email }, state.filter); }) : [];
    if (!state.list.length && !oldOnes.length) return '<p class="empty-note">No customers yet. They are added when someone orders, or press <strong>Add a customer</strong>.</p>';
    if (!shown.length && !oldOnes.length) return '<p class="empty-note">No customer matches “' + esc(state.filter) + '”.</p>';
    return (shown.length ? '<div class="ad-list">' + shown.map(rowHtml).join('') + '</div>' : '') +
      (oldOnes.length ? '<p class="hint" style="margin:18px 0 8px">Also in old Shopify purchases (no customer record yet)</p><div class="ad-list">' + oldOnes.map(historyRow).join('') + '</div>' : '');
  }

  function historyOnlyHtml() {
    if (!state.historyOnly.length) return '';
    return '<details class="how" style="margin-top:22px"><summary>' +
      esc(plural(state.historyOnly.length, 'email', 'emails')) + ' with Shopify purchases but no customer record</summary>' +
      '<p class="hint" style="margin:12px 0">Their purchases already count (cash at pickup, “recent purchases” on an invoice). ' +
      'Add them as customers to give them a name here and in the invoice form. Searching above also finds them.</p>' +
      '<div class="ad-list">' + state.historyOnly.map(historyRow).join('') + '</div></details>';
  }

  function renderList() {
    state.editing = null; state.viewing = null; state.cameFrom = ''; state.dirty = false;
    host.innerHTML = '<div id="cu-msg"></div>' +
      '<p><button type="button" class="btn" data-act="new">Add a customer</button> ' +
        '<span class="muted" id="cu-count" style="margin-left:12px"></span></p>' +
      '<div class="field" style="max-width:420px"><label for="cu-search">Find a customer</label>' +
        '<input type="text" id="cu-search" autocomplete="off" placeholder="Name, email or phone" value="' + esc(state.filter) + '"></div>' +
      '<div id="cu-list"></div>' + historyOnlyHtml() + importHtml();
    paintList();
  }
  function paintList() {
    var shown = state.list.filter(function (c) { return matches(c, state.filter); }).length;
    document.getElementById('cu-list').innerHTML = listHtml();
    document.getElementById('cu-count').textContent = state.filter
      ? shown + ' of ' + plural(state.list.length, 'customer', 'customers')
      : plural(state.list.length, 'customer', 'customers');
  }


  // ---- bringing customers over from Shopify ------------------------------------------
  function importHtml() {
    return '<details class="how" style="margin-top:22px"><summary>Import customers from Shopify</summary>' +
      '<div style="margin-top:12px">' +
        '<p class="hint" style="margin-bottom:12px">In Shopify: <strong>Customers → Export → All customers</strong>, as a CSV file, then choose it below. ' +
          'You see what would happen before anything is saved. It is safe to do again: it only adds people who are missing and fills in blank names and phones. ' +
          'It never changes anyone’s trusted or tax-exempt setting.</p>' +
        '<div class="field"><label for="cu-file">Shopify customer export (.csv)</label><input type="file" id="cu-file" accept=".csv,text/csv"></div>' +
        '<div class="check-row" style="margin-bottom:14px"><input type="checkbox" id="cu-never">' +
          '<label for="cu-never">Also include people who never ordered (newsletter sign-ups and “Login with Shop” accounts)</label></div>' +
        '<div id="cu-import-out" aria-live="polite"></div>' +
      '</div></details>';
  }

  function namesList(items, line) {
    return '<ul style="margin:8px 0 0 18px;font-size:13.5px;line-height:1.7">' + items.map(function (x) { return '<li>' + line(x) + '</li>'; }).join('') + '</ul>';
  }

  function previewHtml(r) {
    var out = '<div class="alert" style="margin:0 0 14px"><strong>' + esc(plural(r.file_rows, 'row', 'rows')) + '</strong> in the file.</div>';
    out += '<p><strong>' + esc(plural(r.add.length, 'person', 'people')) + ' would be added.</strong>' +
      (r.add.length ? '</p><details><summary class="link-btn">Who</summary>' +
        namesList(r.add, function (a) { return esc(a.name || '(no name)') + ' <span class="muted">· ' + esc(a.email) + ' · ' + esc(plural(a.orders, 'order', 'orders')) + '</span>'; }) + '</details>' : '</p>');
    out += '<p>' + esc(plural(r.already, 'person is', 'people are')) + ' already customers' +
      (r.filled ? ', and ' + esc(plural(r.filled, 'of them has', 'of them have')) + ' a blank name or phone that would be filled in' : '') + '.</p>';
    if (r.no_email.length) {
      out += '<p><strong>' + esc(plural(r.no_email.length, 'customer', 'customers')) + ' ordered but ' + (r.no_email.length === 1 ? 'has' : 'have') + ' no email in Shopify</strong>, ' +
        'so they cannot be added (the email is how the store knows someone). Add them with <em>Add a customer</em> when you have their email.</p>' +
        '<details><summary class="link-btn">Who</summary>' + namesList(r.no_email, function (n) { return esc(n.name) + ' <span class="muted">· ' + esc(plural(n.orders, 'order', 'orders')) + (n.phone ? ' · ' + esc(n.phone) : ' · no phone either') + '</span>'; }) + '</details>';
    }
    if (r.never_ordered) out += '<p class="muted">' + esc(plural(r.never_ordered, 'person', 'people')) + ' who never ordered ' + (r.never_ordered === 1 ? 'was' : 'were') + ' left out (tick the box above to include them).</p>';
    if (r.tax_exempt.length) {
      out += '<p><strong>Marked tax-exempt in Shopify:</strong> ' + esc(r.tax_exempt.map(function (t) { return t.name + ' (' + t.email + ')'; }).join('; ')) +
        '. This is <strong>not</strong> carried over. Open their record and tick tax-exempt once you have confirmed their ST-101.</p>';
    }
    var todo = r.add.length + r.filled;
    out += '<div class="goat-save"><button type="button" class="btn" data-act="import-apply"' + (todo ? '' : ' disabled') + '>' +
      (r.add.length ? 'Add ' + esc(plural(r.add.length, 'customer', 'customers')) : 'Fill in blanks') + '</button>' +
      '<span id="cu-import-status" aria-live="polite">' + (todo ? '' : 'Nothing to do — everyone in the file is already here.') + '</span></div>';
    return out;
  }

  function runPreview() {
    var out = document.getElementById('cu-import-out');
    var file = document.getElementById('cu-file').files[0];
    if (!file) { state.csv = ''; out.innerHTML = ''; return; }
    var id = ++state.previewId;
    out.innerHTML = '<p class="muted">Reading the file…</p>';
    file.text().then(function (text) {
      state.csv = text;
      return api('POST', { action: 'import', csv: text, dry_run: true, include_never_ordered: checked('cu-never') });
    }).then(function (r) {
      if (id === state.previewId) out.innerHTML = previewHtml(r);
    }).catch(function (err) {
      state.csv = '';
      if (id === state.previewId) out.innerHTML = '<p class="alert error">' + esc(err.message) + '</p>';
    });
  }

  function applyImport(btn) {
    if (state.busy || !state.csv) return;
    state.busy = true; btn.disabled = true;
    var st = document.getElementById('cu-import-status');
    st.textContent = 'Saving…';
    api('POST', { action: 'import', csv: state.csv, dry_run: false, include_never_ordered: checked('cu-never') }).then(function (r) {
      state.busy = false; state.csv = '';
      var parts = [];
      if (r.add.length) parts.push('Added ' + plural(r.add.length, 'customer', 'customers'));
      if (r.filled) parts.push('filled in blanks for ' + r.filled);
      return load().then(function () { renderList(); note(parts.join(', ') + '.'); });
    }).catch(function (err) {
      state.busy = false; btn.disabled = false;
      st.textContent = 'Not saved: ' + err.message;
    });
  }


  // ---- one customer: who they are, what they bought, and a way to invoice them ----
  function renderProfile() {
    var p = state.viewing, c = p.customer;
    var who = (c && c.name) || p.email;
    var chips = c ? (c.tax_exempt ? ' <span class="chip">Tax-exempt</span>' : '') + (c.trusted ? ' <span class="chip done">Trusted</span>' : '') : '';
    var paid = p.orders.filter(function (o) { return (o.status === 'captured' || o.status === 'recorded') && o.total_cents > o.refunded_cents; });
    var spent = paid.reduce(function (n, o) { return n + o.total_cents - o.refunded_cents; }, 0);
    var orders = p.orders.length ? '<div class="ad-list">' + p.orders.map(function (o) {
      return '<div class="ad-item"><div class="ad-main"><strong>' + esc(o.items || 'Order ' + o.ref) + '</strong>' +
        '<div class="meta">' + esc(isoDay(o.sold_at) + ' · order ' + o.ref + ' · ' + (o.channel === 'invoice' ? 'invoice' : o.channel === 'direct' ? 'recorded sale' : 'online') +
          ' · ' + statusName(o.status) + (o.refunded_cents ? ' · refunded ' + money(o.refunded_cents) : '')) + '</div></div>' +
        '<div class="ad-amt">' + esc(money(o.total_cents)) + '</div><div class="acts"></div></div>';
    }).join('') + '</div>' : '<p class="empty-note" style="padding:8px 0">No orders in this store yet.</p>';
    var old = p.history.length ? '<div class="ad-list">' + p.history.map(function (h) {
      return '<div class="ad-item"><div class="ad-main"><strong>' + esc(h.name) + '</strong>' + (h.unit ? ' <span class="muted">(' + esc(h.unit) + ')</span>' : '') +
        '<div class="meta">' + esc(isoDay(h.sold_at) + ' · ' + h.qty + ' × ' + money(h.price_cents)) + '</div></div>' +
        '<div class="ad-amt">' + esc(money(h.qty * h.price_cents)) + '</div><div class="acts"></div></div>';
    }).join('') + '</div>' : '<p class="empty-note" style="padding:8px 0">No purchases from before this store are on file.</p>';
    host.innerHTML =
      '<p><button type="button" class="link-btn" data-act="back">← All customers</button></p>' +
      '<div id="cu-msg"></div>' +
      '<h3 class="serif" style="font-size:26px;margin:0 0 4px">' + esc(who) + chips + '</h3>' +
      '<p class="muted" style="margin:0 0 14px">' + esc([c && c.name ? p.email : '', c && c.phone ? c.phone : ''].filter(Boolean).join(' · ') || (c ? '' : 'Not saved as a customer yet')) + '</p>' +
      '<p><button type="button" class="btn" data-act="invoice" data-email="' + esc(p.email) + '">Create invoice</button> ' +
        (c ? '<button type="button" class="btn ghost" data-act="edit" data-email="' + esc(p.email) + '">Edit details</button>'
           : '<button type="button" class="btn ghost" data-act="add-from-history" data-email="' + esc(p.email) + '">Add as customer</button>') + '</p>' +
      (c && c.notes ? '<p style="white-space:pre-wrap;margin:0 0 6px"><span class="muted">Notes:</span> ' + esc(c.notes) + '</p>' : '') +
      (c && c.tax_exempt && c.exemption_ref ? '<p style="margin:0 0 6px"><span class="muted">ST-101:</span> ' + esc(c.exemption_ref) + '</p>' : '') +
      '<h4 class="serif" style="font-size:20px;margin:26px 0 10px">Orders here <span class="muted" style="font-size:14px">' +
        esc(plural(paid.length, 'paid order', 'paid orders') + (paid.length ? ' · ' + money(spent) : '')) + '</span></h4>' + orders +
      '<h4 class="serif" style="font-size:20px;margin:26px 0 10px">Before this store (Shopify)</h4>' + old;
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openProfile(email) {
    host.innerHTML = '<p class="lede">Loading…</p>';
    return profileApi(email).then(function (p) {
      state.viewing = p; state.editing = null;
      renderProfile();
    }).catch(function (err) {
      renderList(); note(err.message, 'error');
    });
  }

  // Hand the customer to the New invoice tab.
  function invoiceFor(email) {
    var c = state.list.filter(function (x) { return x.email === email; })[0];
    document.dispatchEvent(new CustomEvent('invoice-for', { detail: { email: email, name: c ? c.name || '' : '', phone: c ? c.phone || '' : '' } }));
  }

  // ---- the editor ---------------------------------------------------------------
  function renderEditor() {
    var e = state.editing, isNew = state.isNew;
    host.innerHTML =
      '<p><button type="button" class="link-btn" data-act="back">← All customers</button></p>' +
      '<div id="cu-msg"></div>' +
      '<fieldset class="goat-set"><legend>' + (isNew ? 'New customer' : 'Edit customer') + '</legend><div class="form-grid">' +
        '<div class="field"><label for="cu-name">Name</label><input type="text" id="cu-name" maxlength="120" value="' + esc(e.name) + '" autocomplete="off"></div>' +
        '<div class="field"><label for="cu-email">Email</label><input type="email" id="cu-email" maxlength="254" value="' + esc(e.email) + '" autocomplete="off"' + (isNew ? '' : ' readonly') + '>' +
          '<div class="hint">' + (isNew ? 'They use this to sign in, and their orders and past purchases are matched by it.'
            : 'Fixed: their orders, purchases and sign-in all go by this address. For a new address, add a new customer.') + '</div></div>' +
        '<div class="field"><label for="cu-phone">Phone</label><input type="text" id="cu-phone" maxlength="40" value="' + esc(e.phone) + '" autocomplete="off"></div>' +
        '<div class="field"></div>' +
      '</div>' +
      '<div class="check-row" style="margin-bottom:14px"><input type="checkbox" id="cu-trusted"' + (e.trusted ? ' checked' : '') + '>' +
        '<label for="cu-trusted"><strong>Trusted</strong> — their card orders are charged right away instead of waiting for your review, and they can pay cash at pickup. Only for people you know.</label></div>' +
      '<div class="check-row" style="margin-bottom:14px"><input type="checkbox" id="cu-exempt"' + (e.tax_exempt ? ' checked' : '') + '>' +
        '<label for="cu-exempt"><strong>Sales-tax exempt</strong> — no Idaho sales tax is charged. Needs an ST-101 on file.</label></div>' +
      '<div class="field"><label for="cu-ref">ST-101 reference <span class="lbl-note">number or date received</span></label>' +
        '<input type="text" id="cu-ref" maxlength="200" value="' + esc(e.exemption_ref) + '"></div>' +
      '<div class="field"><label for="cu-notes">Private notes <span class="lbl-note">only you see these</span></label>' +
        '<textarea id="cu-notes" rows="3" maxlength="2000">' + esc(e.notes) + '</textarea></div>' +
      '</fieldset>' +
      '<div class="goat-save"><button type="button" class="btn" data-act="save">' + (isNew ? 'Add customer' : 'Save') + '</button>' +
        (isNew ? '' : '<button type="button" class="btn ghost rust-text" data-act="delete">Remove…</button>') +
        '<span id="cu-status" aria-live="polite"></span></div>';
  }

  function openEditor(c, isNew) {
    state.editing = c; state.isNew = !!isNew; state.dirty = false;
    renderEditor();
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var first = document.getElementById(isNew && !c.email ? 'cu-email' : 'cu-name');
    if (first) first.focus();
  }

  function save(btn) {
    if (state.busy) return;
    var st = document.getElementById('cu-status');
    var email = val('cu-email').trim();
    if (state.isNew && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { st.textContent = 'Enter a real email address.'; return; }
    if (state.isNew && !val('cu-name').trim()) { st.textContent = 'Enter their name.'; return; }
    if (checked('cu-exempt') && !val('cu-ref').trim() &&
        !window.confirm('Mark them tax-exempt without an ST-101 reference? You can add the reference later.')) return;
    state.busy = true; btn.disabled = true; st.textContent = 'Saving…';
    api('POST', {
      action: state.isNew ? 'add' : 'update', email: email, name: val('cu-name'), phone: val('cu-phone'),
      trusted: checked('cu-trusted'), tax_exempt: checked('cu-exempt'), exemption_ref: val('cu-ref'), notes: val('cu-notes'),
    }).then(function (r) {
      state.busy = false; state.dirty = false;
      var who = r.customer && (r.customer.name || r.customer.email);
      var verb = state.isNew ? 'Added ' : 'Saved ';
      var back = !state.isNew && state.cameFrom;
      return load().then(function () {
        if (back) return openProfile(back).then(function () { note(verb + who + '.'); });
        renderList(); note(verb + who + '.');
      });
    }).catch(function (err) {
      state.busy = false; btn.disabled = false;
      st.textContent = 'Not saved: ' + err.message;
    });
  }

  function remove(btn) {
    var c = state.editing;
    var full = state.list.filter(function (x) { return x.email === c.email; })[0] || c;
    var keeps = [];
    if (full.paid_orders) keeps.push(plural(full.paid_orders, 'paid order', 'paid orders'));
    if (full.history_lines) keeps.push(plural(full.history_lines, 'old Shopify purchase line', 'old Shopify purchase lines'));
    var gone = ['contact details', 'notes'];
    if (c.trusted) gone.push('trusted setting');
    if (c.tax_exempt) gone.push('tax-exempt setting');
    var msg = 'Remove ' + (c.name || c.email) + ' (' + c.email + ') from your customers?\n\n' +
      'This deletes their ' + gone.join(', ').replace(/, ([^,]*)$/, ' and $1') + '.\n' +
      (keeps.length ? 'Their ' + keeps.join(' and ') + ' stay on file.\n' : 'Nothing else is deleted.\n') +
      'If they order again they start as a new customer.';
    if (!window.confirm(msg)) return;
    btn.disabled = true;
    api('POST', { action: 'delete', email: c.email }).then(function () {
      state.editing = null; state.dirty = false;
      return load().then(function () { renderList(); note('Removed ' + (c.name || c.email) + '.'); });
    }).catch(function (err) {
      document.getElementById('cu-status').textContent = 'Not removed: ' + err.message; btn.disabled = false;
    });
  }

  // ---- events ---------------------------------------------------------------------
  tab.addEventListener('click', function () {
    if (state.editing) return;
    host.innerHTML = '<p class="lede">Loading…</p>';
    load().then(renderList).catch(function () {});
  });

  host.addEventListener('input', function (ev) {
    if (ev.target.id === 'cu-search') { state.filter = ev.target.value; return paintList(); }
    if (!state.editing || state.dirty) return;
    state.dirty = true;
    var st = document.getElementById('cu-status');
    if (st && !st.textContent) st.textContent = 'Not saved yet';
  });
  host.addEventListener('change', function (ev) {
    if (ev.target.id === 'cu-file' || (ev.target.id === 'cu-never' && state.csv)) return runPreview();
    if (state.editing) state.dirty = true;
  });
  host.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && state.editing && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') {
      ev.preventDefault();
      var b = host.querySelector('[data-act="save"]');
      if (b && !b.disabled) save(b);
    }
  });
  window.addEventListener('beforeunload', function (ev) {
    if (state.editing && state.dirty) { ev.preventDefault(); ev.returnValue = ''; }
  });

  host.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    var blank = { email: '', name: '', phone: '', trusted: 0, tax_exempt: 0, exemption_ref: '', notes: '' };
    if (act === 'new') return openEditor(blank, true);
    if (act === 'add-from-history') {
      blank.email = b.getAttribute('data-email');
      return openEditor(blank, true);
    }
    if (act === 'open') return openProfile(b.getAttribute('data-email'));
    if (act === 'invoice') return invoiceFor(b.getAttribute('data-email'));
    if (act === 'edit') {
      var row = state.list.filter(function (x) { return x.email === b.getAttribute('data-email'); })[0];
      state.cameFrom = state.viewing ? state.viewing.email : '';
      return row && openEditor(JSON.parse(JSON.stringify(row)), false);
    }
    if (act === 'back') {
      if (state.editing && state.dirty && !window.confirm('Leave without saving?')) return;
      return renderList();
    }
    if (act === 'save') return save(b);
    if (act === 'delete') return remove(b);
    if (act === 'import-apply') return applyImport(b);
  });
})();
