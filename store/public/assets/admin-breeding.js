/* Admin — Breeding tab.
 * ---------------------------------------------------------------------
 * The breeding schedule on the farm website (alittlehillfarm.com/breeding.html):
 * one row per pairing, plus the page's heading and intro. Saves go to
 * /api/admin/breedings (worker.js, adminBreedings) and show on the website
 * on the next page load — there is no separate publish step.
 */
(function () {
  'use strict';

  var host = document.getElementById('breeding-app');
  var tab = document.getElementById('tab-breeding');
  if (!host || !tab) return;

  var state = { list: [], goats: [], settings: {}, editing: null, dirty: false, busy: false, siteUrl: '' };
  var STATUSES = [
    ['planned', 'Planned'], ['bred', 'Bred'], ['kidded', 'Kidded'], ['skipped', 'Not bred (keep the record, hide from the page)'],
  ];
  var GESTATION_DAYS = 150;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, body) {
    return fetch('/api/admin/breedings', {
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
    var el = document.getElementById('br-msg');
    if (el) el.innerHTML = text ? '<p class="alert ' + (kind || 'success') + '">' + esc(text) + '</p>' : '';
  }
  function prettyDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] : (iso || '');
  }
  function addDays(iso, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
    return d.toISOString().slice(0, 10);
  }
  function statusName(s) { return (STATUSES.filter(function (x) { return x[0] === s; })[0] || [0, s])[1].replace(/ \(.*/, ''); }
  function goatsOf(template) { return state.goats.filter(function (g) { return g.template === template; }); }
  function goatById(id) { return state.goats.filter(function (g) { return g.id === id; })[0]; }

  function load() {
    return api('GET').then(function (d) {
      state.list = d.breedings || [];
      state.goats = d.goats || [];
      state.settings = d.settings || {};
      state.siteUrl = d.site_url || '';
    }).catch(function (err) {
      host.innerHTML = '<div id="br-msg"></div>';
      note(err.message, 'error');
      throw err;
    });
  }

  // ---- the list ---------------------------------------------------------------
  function renderList() {
    state.editing = null;
    var s = state.settings;
    var rows = state.list.map(function (b) {
      var bits = ['bred to ' + b.sire_name];
      if (b.status === 'kidded' && b.outcome) bits.push(b.outcome);
      if (b.status === 'skipped') bits.push('not shown on the website');
      else if (!b.show) bits.push('hidden from the website');
      return '<div class="ad-item">' +
        '<div class="ad-main"><strong>' + esc(b.doe_name) + '</strong> <span class="chip">' + esc(statusName(b.status)) + '</span>' +
          '<div class="meta">Due ' + esc(prettyDate(b.due_on)) + ' · ' + esc(bits.join(' · ')) + '</div></div>' +
        '<div class="ad-amt"></div>' +
        '<div class="acts"><button type="button" class="btn small" data-act="edit" data-id="' + esc(b.id) + '">Edit</button></div>' +
      '</div>';
    }).join('');
    host.innerHTML = '<div id="br-msg"></div>' +
      '<p><button type="button" class="btn" data-act="new">Add a pairing</button> ' +
        (state.siteUrl ? '<a class="btn ghost" href="' + esc(String(state.siteUrl).replace(/\/+$/, '')) + '/breeding.html" target="_blank" rel="noopener">View the page ↗</a>' : '') + '</p>' +
      (rows ? '<div class="ad-list">' + rows + '</div>'
            : '<p class="empty-note">No pairings yet. Until you add one, the website shows its original schedule.</p>') +
      '<details class="how" style="margin-top:22px"><summary>Page heading and intro</summary>' +
        '<fieldset class="goat-set" style="margin-top:12px"><legend>Top of the breeding page</legend><div class="form-grid">' +
          '<div class="field"><label for="br-eyebrow">Small line above the heading</label><input type="text" id="br-eyebrow" maxlength="60" value="' + esc(s.breeding_eyebrow || '') + '" placeholder="Kidding Season"></div>' +
          '<div class="field"><label for="br-title">Heading</label><input type="text" id="br-title" maxlength="100" value="' + esc(s.breeding_title || '') + '" placeholder="Spring 2027 Breeding Schedule"></div>' +
          '<div class="field span2"><label for="br-lede">Intro sentence</label><textarea id="br-lede" rows="2" maxlength="400">' + esc(s.breeding_lede || '') + '</textarea></div>' +
        '</div><p class="hint">Leave a box empty to use the page’s original wording.</p></fieldset>' +
        '<div class="goat-save"><button type="button" class="btn" data-act="save-settings">Save heading</button><span id="br-set-status" aria-live="polite"></span></div>' +
      '</details>';
  }

  // ---- the editor ---------------------------------------------------------------
  function field(label, id, value, extra, hint) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><input type="text" id="' + id + '" value="' + esc(value == null ? '' : value) + '"' + (extra || '') + '>' +
      (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
  }
  function goatSelect(id, label, list, current, none) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><select id="' + id + '">' +
      '<option value="">' + none + '</option>' +
      list.map(function (g) {
        return '<option value="' + esc(g.id) + '"' + (current === g.id ? ' selected' : '') + '>' + esc(g.name) + (g.hidden ? ' (hidden on website)' : '') + '</option>';
      }).join('') + '</select></div>';
  }

  function renderEditor() {
    var e = state.editing;
    host.innerHTML =
      '<p><button type="button" class="link-btn" data-act="back">← All pairings</button></p>' +
      '<div id="br-msg"></div>' +
      '<fieldset class="goat-set"><legend>' + (e.id ? 'Edit pairing' : 'New pairing') + '</legend><div class="form-grid">' +
        goatSelect('br-doe', 'Doe (from your herd)', goatsOf('doe'), e.doe_id, 'Someone not on this list…') +
        field('Doe’s full name', 'br-doe-name', e.doe_name, ' maxlength="120"', 'As it should read on the page.') +
        goatSelect('br-sire', 'Buck (from your herd)', goatsOf('buck'), e.sire_id, 'A buck from another farm…') +
        field('Buck’s full name', 'br-sire-name', e.sire_name, ' maxlength="120"') +
        '<div class="field"><label for="br-bred">Bred on</label><input type="date" id="br-bred" value="' + esc(e.bred_on || '') + '"></div>' +
        '<div class="field"><label for="br-due">Due on <span class="lbl-note">about ' + GESTATION_DAYS + ' days after breeding</span></label><input type="date" id="br-due" value="' + esc(e.due_on || '') + '"></div>' +
        field('Freshening', 'br-fresh', e.freshening, ' maxlength="20" placeholder="2F"', 'Optional. 2F = second freshening.') +
        '<div class="field"><label for="br-status">Where it stands</label><select id="br-status">' +
          STATUSES.map(function (s) { return '<option value="' + s[0] + '"' + (e.status === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field span2"><label for="br-outcome">What was born <span class="lbl-note">shown on the page once she has kidded</span></label>' +
          '<input type="text" id="br-outcome" maxlength="200" value="' + esc(e.outcome || '') + '" placeholder="2 doelings, 1 buckling"></div>' +
        field('Doe’s ADGA number', 'br-dam-reg', e.dam_reg, ' maxlength="30"', 'For the Pedigree button. Filled in from your herd when you pick a doe.') +
        field('Buck’s ADGA number', 'br-sire-reg', e.sire_reg, ' maxlength="30"', 'Both numbers are needed for the button to appear.') +
      '</div>' +
      '<div class="check-row" style="margin-bottom:14px"><input type="checkbox" id="br-show"' + (e.show ? ' checked' : '') + '>' +
        '<label for="br-show">Show on the website</label></div>' +
      '<div class="field"><label for="br-note">Private notes <span class="lbl-note">never shown on the website</span></label><textarea id="br-note" rows="2" maxlength="1000">' + esc(e.note) + '</textarea></div>' +
      '</fieldset>' +
      '<div class="goat-save"><button type="button" class="btn" data-act="save">Save</button>' +
        (e.id ? '<button type="button" class="btn ghost rust-text" data-act="delete">Delete…</button>' : '') +
        '<span id="br-status-msg" aria-live="polite"></span></div>';
  }

  function openEditor(b) {
    state.editing = b; state.dirty = false;
    renderEditor();
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function val(id) { return document.getElementById(id).value; }

  function save(btn) {
    if (state.busy) return;
    var e = state.editing, st = document.getElementById('br-status-msg');
    if (!val('br-doe-name').trim()) { st.className = ''; st.textContent = 'Enter the doe’s name.'; return; }
    if (!val('br-sire-name').trim()) { st.className = ''; st.textContent = 'Enter the buck’s name.'; return; }
    if (!val('br-due')) { st.className = ''; st.textContent = 'Enter the due date (or the date she was bred and it fills in).'; return; }
    state.busy = true; btn.disabled = true; st.className = ''; st.textContent = 'Saving…';
    api('POST', {
      action: 'save', id: e.id,
      doe_id: val('br-doe'), doe_name: val('br-doe-name'), sire_id: val('br-sire'), sire_name: val('br-sire-name'),
      dam_reg: val('br-dam-reg'), sire_reg: val('br-sire-reg'), freshening: val('br-fresh'),
      bred_on: val('br-bred'), due_on: val('br-due'), status: val('br-status'), outcome: val('br-outcome'),
      note: val('br-note'), show: document.getElementById('br-show').checked,
    }).then(function () {
      state.busy = false; state.dirty = false;
      return load().then(function () { renderList(); note('Saved. It is on the website now.'); });
    }).catch(function (err) {
      state.busy = false; btn.disabled = false;
      st.className = ''; st.textContent = 'Not saved: ' + err.message;
    });
  }

  function saveSettings(btn) {
    var st = document.getElementById('br-set-status');
    btn.disabled = true; st.textContent = 'Saving…';
    api('POST', { action: 'save_settings', breeding_eyebrow: val('br-eyebrow'), breeding_title: val('br-title'), breeding_lede: val('br-lede') })
      .then(function () { return load(); })
      .then(function () { renderList(); note('Heading saved. It is on the website now.'); })
      .catch(function (err) { btn.disabled = false; st.textContent = 'Not saved: ' + err.message; });
  }

  // ---- events ---------------------------------------------------------------------
  tab.addEventListener('click', function () {
    if (state.editing) return;
    host.innerHTML = '<p class="lede">Loading…</p>';
    load().then(renderList).catch(function () {});
  });

  host.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!state.editing) return;
    // Picking a goat from the herd fills in her name and ADGA number.
    if (t.id === 'br-doe' || t.id === 'br-sire') {
      var g = goatById(t.value);
      if (g) {
        var isDoe = t.id === 'br-doe';
        document.getElementById(isDoe ? 'br-doe-name' : 'br-sire-name').value = g.registered_name || g.name;
        document.getElementById(isDoe ? 'br-dam-reg' : 'br-sire-reg').value = g.reg || '';
      }
    }
    // The due date follows the breeding date until it is set by hand.
    if (t.id === 'br-bred' && t.value) {
      var due = document.getElementById('br-due');
      if (!due.value || due.getAttribute('data-auto') === due.value) {
        due.value = addDays(t.value, GESTATION_DAYS);
        due.setAttribute('data-auto', due.value);
      }
    }
    if (t.id === 'br-due' && t.value !== t.getAttribute('data-auto')) t.removeAttribute('data-auto');
  });
  host.addEventListener('input', function () {
    if (!state.editing || state.dirty) return;
    state.dirty = true;
    var st = document.getElementById('br-status-msg');
    if (st && !st.textContent) { st.textContent = 'Not saved yet'; st.className = 'muted'; }
  });
  host.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && state.editing && ev.target.tagName === 'INPUT' && ev.target.type === 'text') {
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
    if (act === 'new') {
      return openEditor({ id: null, doe_id: '', doe_name: '', sire_id: '', sire_name: '', dam_reg: '', sire_reg: '', freshening: '',
        bred_on: '', due_on: '', status: 'planned', outcome: '', note: '', show: 1 });
    }
    if (act === 'edit') {
      var row = state.list.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
      return row && openEditor(JSON.parse(JSON.stringify(row)));
    }
    if (act === 'back') {
      if (state.editing && state.dirty && !window.confirm('Leave without saving this pairing?')) return;
      state.editing = null; state.dirty = false; return renderList();
    }
    if (act === 'save') return save(b);
    if (act === 'save-settings') return saveSettings(b);
    if (act === 'delete') {
      if (!window.confirm('Delete the pairing for “' + state.editing.doe_name + '”?\n\nIt will come off the website. (To keep the record, set it to “Not bred” instead.)')) return;
      b.disabled = true;
      api('POST', { action: 'delete', id: state.editing.id }).then(function () {
        state.editing = null; state.dirty = false;
        return load().then(function () { renderList(); note('Deleted.'); });
      }).catch(function (err) { document.getElementById('br-status-msg').textContent = err.message; b.disabled = false; });
    }
  });
})();
