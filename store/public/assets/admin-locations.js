/* Admin — Locations tab.
 * ---------------------------------------------------------------------
 * The farm itself and any shop, market or other place that sells your goods.
 * A shop's monthly statements are entered on the Location sales tab; this tab
 * holds who they are, how to reach them, the shop's cut (if any) and whether
 * the shop collects sales tax on its own sales. Saves go to
 * /api/admin/locations (worker.js, adminLocations).
 */
(function () {
  'use strict';

  var host = document.getElementById('locations-app');
  var tab = document.getElementById('tab-locations');
  if (!host || !tab) return;

  var state = { list: [], editing: null, loaded: false, busy: false };
  var KINDS = [['store', 'Shop'], ['market', 'Market'], ['other', 'Other'], ['farm', 'The farm']];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, body) {
    return fetch('/api/admin/locations', {
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
    var el = document.getElementById('lo-msg');
    if (el) el.innerHTML = text ? '<p class="alert ' + (kind || 'success') + '">' + esc(text) + '</p>' : '';
  }
  function kindName(k) { return (KINDS.filter(function (x) { return x[0] === k; })[0] || [0, k])[1]; }
  function percent(bps) { return String(Math.round((bps || 0)) / 100); }

  function load() {
    return api('GET').then(function (d) {
      state.list = d.locations || [];
      state.loaded = true;
      if (!state.editing) renderList();
    }).catch(function (err) {
      host.innerHTML = '<div id="lo-msg"></div>';
      note(err.message, 'error');
    });
  }

  function renderList() {
    state.editing = null;
    host.innerHTML = '<div id="lo-msg"></div>' +
      '<p><button type="button" class="btn" data-act="new">Add a location</button></p>' +
      '<div class="ad-list">' + state.list.map(function (l) {
        var bits = [kindName(l.kind)];
        if (l.contact) bits.push(l.contact);
        if (l.phone) bits.push(l.phone);
        if (l.kind !== 'farm') bits.push(l.commission_bps ? percent(l.commission_bps) + '% shop’s cut' : 'no shop’s cut');
        return '<div class="ad-item">' +
          '<div class="ad-main"><strong>' + esc(l.name) + '</strong> ' + (l.active ? '' : '<span class="chip">Switched off</span>') +
            '<div class="meta">' + esc(bits.join(' · ')) + '</div></div>' +
          '<div class="ad-amt"></div>' +
          '<div class="acts"><button type="button" class="btn small" data-act="edit" data-id="' + esc(l.id) + '">Edit</button></div>' +
        '</div>';
      }).join('') + '</div>';
  }

  function field(label, id, value, extra) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><input type="text" id="' + id + '" value="' + esc(value == null ? '' : value) + '"' + (extra || '') + '></div>';
  }

  function renderEditor() {
    var e = state.editing;
    var isFarm = e.id === 'farm';
    host.innerHTML =
      '<p><button type="button" class="link-btn" data-act="back">← All locations</button></p>' +
      '<div id="lo-msg"></div>' +
      '<fieldset class="goat-set"><legend>' + (e.id ? 'Edit location' : 'New location') + '</legend><div class="form-grid">' +
        field('Name', 'lo-name', e.name, ' maxlength="80"') +
        '<div class="field"><label for="lo-kind">Kind</label><select id="lo-kind"' + (isFarm ? ' disabled' : '') + '>' +
          KINDS.filter(function (k) { return isFarm || k[0] !== 'farm'; }).map(function (k) {
            return '<option value="' + k[0] + '"' + (e.kind === k[0] ? ' selected' : '') + '>' + k[1] + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field span2"><label for="lo-address">Address</label><input type="text" id="lo-address" maxlength="200" value="' + esc(e.address) + '"></div>' +
        field('Contact person', 'lo-contact', e.contact, ' maxlength="80"') +
        field('Phone', 'lo-phone', e.phone, ' maxlength="40" inputmode="tel"') +
        field('Email', 'lo-email', e.email, ' maxlength="120" inputmode="email"') +
        '<div class="field"><label for="lo-cut">Shop’s cut (%) <span class="lbl-note">0 if they keep nothing</span></label>' +
          '<input type="text" id="lo-cut" inputmode="decimal" value="' + esc(percent(e.commission_bps)) + '"></div>' +
      '</div>' +
      '<div class="check-row" style="margin-bottom:10px"><input type="checkbox" id="lo-tax"' + (e.tax_collected_by_location ? ' checked' : '') + '>' +
        '<label for="lo-tax">The shop collects sales tax on its own sales <span class="lbl-note">(so it is left out of your Idaho filing)</span></label></div>' +
      '<div class="check-row" style="margin-bottom:14px"><input type="checkbox" id="lo-active"' + (e.active ? ' checked' : '') + '>' +
        '<label for="lo-active">Active (shows in the Location sales list)</label></div>' +
      '<div class="field"><label for="lo-note">Notes</label><textarea id="lo-note" rows="2" maxlength="1000">' + esc(e.note) + '</textarea></div>' +
      '</fieldset>' +
      '<div class="goat-save"><button type="button" class="btn" data-act="save">Save</button>' +
        (e.id && !isFarm ? '<button type="button" class="btn ghost rust-text" data-act="delete">Delete…</button>' : '') +
        '<span id="lo-status" aria-live="polite"></span></div>';
  }

  function openEditor(l) {
    state.editing = l;
    renderEditor();
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function save(btn) {
    if (state.busy) return;
    var e = state.editing, status = document.getElementById('lo-status');
    var cut = parseFloat(document.getElementById('lo-cut').value.replace('%', '') || '0');
    if (isNaN(cut) || cut < 0 || cut > 100) { status.textContent = 'The shop’s cut should be a percentage from 0 to 100.'; return; }
    state.busy = true; btn.disabled = true; status.textContent = 'Saving…';
    api('POST', {
      action: 'save', id: e.id,
      name: document.getElementById('lo-name').value,
      kind: e.id === 'farm' ? 'farm' : document.getElementById('lo-kind').value,
      address: document.getElementById('lo-address').value, contact: document.getElementById('lo-contact').value,
      phone: document.getElementById('lo-phone').value, email: document.getElementById('lo-email').value,
      commission_bps: Math.round(cut * 100),
      tax_collected_by_location: document.getElementById('lo-tax').checked,
      active: document.getElementById('lo-active').checked,
      note: document.getElementById('lo-note').value,
    }).then(function () {
      state.busy = false; state.editing = null;
      document.dispatchEvent(new CustomEvent('locations-changed'));
      return load().then(function () { renderList(); note('Saved.'); });
    }).catch(function (err) {
      state.busy = false; btn.disabled = false;
      status.textContent = 'Not saved: ' + err.message;
    });
  }

  tab.addEventListener('click', function () {
    if (state.editing) return;
    host.innerHTML = '<p class="lede">Loading…</p>';
    load().then(renderList);
  });

  host.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'new') return openEditor({ id: null, name: '', kind: 'store', address: '', contact: '', phone: '', email: '', commission_bps: 0, tax_collected_by_location: 1, active: 1, note: '' });
    if (act === 'edit') {
      var l = state.list.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
      return l && openEditor(JSON.parse(JSON.stringify(l)));
    }
    if (act === 'back') { state.editing = null; return renderList(); }
    if (act === 'save') return save(b);
    if (act === 'delete') {
      if (!window.confirm('Delete “' + state.editing.name + '”?\n\nIf it has reports behind it, it is switched off instead of erased.')) return;
      b.disabled = true;
      api('POST', { action: 'delete', id: state.editing.id }).then(function (r) {
        state.editing = null;
        document.dispatchEvent(new CustomEvent('locations-changed'));
        return load().then(function () { renderList(); note(r.archived ? 'It has reports behind it, so it was switched off instead of deleted.' : 'Deleted.'); });
      }).catch(function (err) { document.getElementById('lo-status').textContent = err.message; b.disabled = false; });
    }
  });
})();
