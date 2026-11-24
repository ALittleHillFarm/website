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

  var state = { list: [], historyOnly: [], filter: '', editing: null, isNew: false, dirty: false, busy: false };

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
  function note(text, kind) {
    var el = document.getElementById('cu-msg');
    if (el) el.innerHTML = text ? '<p class="alert ' + (kind || 'success') + '">' + esc(text) + '</p>' : '';
  }
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
      '<div class="acts"><button type="button" class="btn small" data-act="edit" data-email="' + esc(c.email) + '">Edit</button></div>' +
    '</div>';
  }

  function listHtml() {
    var shown = state.list.filter(function (c) { return matches(c, state.filter); });
    if (!state.list.length) return '<p class="empty-note">No customers yet. They are added when someone orders, or press <strong>Add a customer</strong>.</p>';
    if (!shown.length) return '<p class="empty-note">No customer matches “' + esc(state.filter) + '”.</p>';
    return '<div class="ad-list">' + shown.map(rowHtml).join('') + '</div>';
  }

  function historyOnlyHtml() {
    if (!state.historyOnly.length) return '';
    var rows = state.historyOnly.map(function (h) {
      return '<div class="ad-item">' +
        '<div class="ad-main"><strong>' + esc(h.email) + '</strong>' +
          '<div class="meta">' + esc(plural(h.lines, 'old Shopify line', 'old Shopify lines') + ' · last bought ' + isoDay(h.last_purchase)) + '</div></div>' +
        '<div class="ad-amt"></div>' +
        '<div class="acts"><button type="button" class="btn small" data-act="add-from-history" data-email="' + esc(h.email) + '">Add as customer</button></div>' +
      '</div>';
    }).join('');
    return '<details class="how" style="margin-top:22px"><summary>' +
      esc(plural(state.historyOnly.length, 'email', 'emails')) + ' with Shopify purchases but no customer record</summary>' +
      '<p class="hint" style="margin:12px 0">Their purchases already count (cash at pickup, “recent purchases” on an invoice). ' +
      'Add them as customers to give them a name here and in the invoice form.</p>' +
      '<div class="ad-list">' + rows + '</div></details>';
  }

  function renderList() {
    state.editing = null; state.dirty = false;
    host.innerHTML = '<div id="cu-msg"></div>' +
      '<p><button type="button" class="btn" data-act="new">Add a customer</button> ' +
        '<span class="muted" id="cu-count" style="margin-left:12px"></span></p>' +
      '<div class="field" style="max-width:420px"><label for="cu-search">Find a customer</label>' +
        '<input type="text" id="cu-search" autocomplete="off" placeholder="Name, email or phone" value="' + esc(state.filter) + '"></div>' +
      '<div id="cu-list"></div>' + historyOnlyHtml();
    paintList();
  }
  function paintList() {
    var shown = state.list.filter(function (c) { return matches(c, state.filter); }).length;
    document.getElementById('cu-list').innerHTML = listHtml();
    document.getElementById('cu-count').textContent = state.filter
      ? shown + ' of ' + plural(state.list.length, 'customer', 'customers')
      : plural(state.list.length, 'customer', 'customers');
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
      return load().then(function () { renderList(); note(verb + who + '.'); });
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
  host.addEventListener('change', function () { if (state.editing) state.dirty = true; });
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
    if (act === 'edit') {
      var row = state.list.filter(function (x) { return x.email === b.getAttribute('data-email'); })[0];
      return row && openEditor(JSON.parse(JSON.stringify(row)), false);
    }
    if (act === 'back') {
      if (state.editing && state.dirty && !window.confirm('Leave without saving?')) return;
      return renderList();
    }
    if (act === 'save') return save(b);
    if (act === 'delete') return remove(b);
  });
})();
