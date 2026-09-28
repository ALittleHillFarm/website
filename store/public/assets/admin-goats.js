/* Admin — Goats tab.
 * ---------------------------------------------------------------------
 * Add a goat, edit everything on her page, upload photos, reorder the
 * roster, hide a goat that was sold. Saves go to /api/admin/goats
 * (worker.js, adminGoats), which re-checks every field; the farm site
 * renders from the same table, so a save is live on the next page load.
 *
 * Photos are shrunk in the browser before upload: a 1600px copy for full
 * size and a 640px copy for cards and thumbnails. That keeps pages fast on
 * a phone connection, and re-encoding drops the camera's hidden metadata,
 * including the GPS location of the barn.
 *
 * The page's own Basic Auth covers these requests. This file holds no
 * secrets; it is just the form.
 */
(function () {
  'use strict';

  var host = document.getElementById('goats-app');
  var tab = document.getElementById('tab-goats');
  if (!host || !tab) return;

  var state = { goats: [], farm: '', editing: null, dirty: false, uploads: 0, loaded: false };

  // ---- helpers ----------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }
  function setPath(obj, path, val) {
    var ks = path.split('.');
    var o = obj;
    for (var i = 0; i < ks.length - 1; i++) {
      if (o[ks[i]] == null) o[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {};
      o = o[ks[i]];
    }
    o[ks[ks.length - 1]] = val;
  }
  function api(method, body) {
    return fetch('/api/admin/goats', {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }
  // Site photos (/assets/photos/...) live on the farm site; uploads (/media/...)
  // are served by both workers.
  function view(path) {
    if (!path) return '';
    return path.indexOf('/media/') === 0 ? path : state.farm + path;
  }
  function pageUrl(id) { return state.farm + '/goats/' + encodeURIComponent(id) + '.html'; }
  function shoutToName(s) {
    return String(s || '').toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }
  function message(text, kind) {
    var el = document.getElementById('goats-msg');
    if (el) el.innerHTML = text ? '<p class="alert ' + (kind || 'success') + '">' + text + '</p>' : '';
  }

  // ---- photos: shrink in the browser, then upload --------------------------
  function shrink(file, maxEdge, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.round(img.naturalWidth * scale);
        var h = Math.round(img.naturalHeight * scale);
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';               // transparent PNGs become white, not black
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('could not read that image')); }, 'image/jpeg', quality);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('that file is not a photo this browser can open')); };
      img.src = url;
    });
  }
  // The Inventory tab's photo upload uses the same shrink.
  window.shrinkPhoto = shrink;

  function send(blob) {
    return fetch('/api/admin/upload', { method: 'POST', body: blob, headers: { 'content-type': 'image/jpeg' } })
      .then(function (res) {
        return res.json().then(function (d) {
          if (!res.ok) throw new Error(d.error || 'upload failed');
          return d.url;
        });
      });
  }
  function uploadPhoto(file) {
    return Promise.all([shrink(file, 1600, 0.85), shrink(file, 640, 0.8)]).then(function (b) {
      return Promise.all([send(b[0]), send(b[1])]);
    }).then(function (urls) { return { src: urls[0], thumb: urls[1] }; });
  }

  // ---- list ---------------------------------------------------------------
  function load(keepEditor) {
    message('');
    return api('GET').then(function (d) {
      state.goats = d.goats || [];
      state.farm = String(d.farm_url || '').replace(/\/+$/, '');
      state.loaded = true;
      if (!keepEditor) { state.editing = null; renderList(); }
    }).catch(function (err) {
      host.innerHTML = '<div id="goats-msg"></div>';
      message(esc(err.message), 'error');
    });
  }

  function thumbOf(g) {
    var p = g.data.hero || (g.data.gallery || [])[0];
    return p ? '<img src="' + esc(view(p.thumb || p.src)) + '" alt="">' : '';
  }

  function renderList() {
    function group(template, title) {
      var list = state.goats.filter(function (g) { return g.template === template; });
      var rows = list.map(function (g, i) {
        var shown = g.status === 'active';
        return '<div class="goat-row">' +
          '<div class="shot">' + thumbOf(g) + '</div>' +
          '<div class="who"><strong>' + esc(g.data.name || g.id) + '</strong>' +
            '<span class="chip' + (shown ? ' done' : '') + '">' + (shown ? 'Shown' : 'Hidden') + '</span>' +
            '<div class="meta">' + esc(g.data.registered_name || '') + '</div></div>' +
          '<div class="acts">' +
            '<button type="button" class="btn ghost small" data-act="up" data-id="' + esc(g.id) + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move ' + esc(g.data.name) + ' up">↑</button>' +
            '<button type="button" class="btn ghost small" data-act="down" data-id="' + esc(g.id) + '"' + (i === list.length - 1 ? ' disabled' : '') + ' aria-label="Move ' + esc(g.data.name) + ' down">↓</button>' +
            '<button type="button" class="btn small" data-act="edit" data-id="' + esc(g.id) + '">Edit</button>' +
            (shown ? '<a class="link-u" href="' + esc(pageUrl(g.id)) + '" target="_blank" rel="noopener">View page ↗</a>' : '') +
          '</div></div>';
      }).join('');
      return '<h3 class="serif goat-group">' + title + '</h3>' + (rows || '<p class="empty-note">None yet.</p>');
    }
    host.innerHTML =
      '<div id="goats-msg"></div>' +
      '<form class="goat-add" data-form="add">' +
        '<div class="field"><label for="g-new-name">New goat’s name</label><input type="text" id="g-new-name" maxlength="60" required placeholder="e.g. Clover"></div>' +
        '<div class="field"><label for="g-new-type">Doe or buck</label><select id="g-new-type"><option value="doe">Doe</option><option value="buck">Buck</option></select></div>' +
        '<button type="submit" class="btn">Add goat</button>' +
      '</form>' +
      '<p class="field hint" style="margin-top:-6px">A new goat starts <strong>hidden</strong>, so nobody sees a half-finished page. Switch her to “Shown” when she’s ready.</p>' +
      group('doe', 'Does') + group('buck', 'Bucks');
  }

  // ---- editor ---------------------------------------------------------------
  function field(label, path, opts) {
    opts = opts || {};
    var v = getPath(state.editing, path);
    var id = 'gf-' + path.replace(/\./g, '-');
    var input;
    if (opts.type === 'textarea') {
      var text = opts.kind === 'lines' ? (v || []).join('\n') : opts.kind === 'paras' ? (v || []).join('\n\n') : (v || '');
      input = '<textarea id="' + id + '" data-f="' + path + '"' + (opts.kind ? ' data-kind="' + opts.kind + '"' : '') +
        ' rows="' + (opts.rows || 3) + '"' + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + '>' + esc(text) + '</textarea>';
    } else if (opts.type === 'select') {
      input = '<select id="' + id + '" data-f="' + path + '">' + opts.options.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(v || '') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>';
    } else if (opts.type === 'checkbox') {
      return '<div class="check-row"><input type="checkbox" id="' + id + '" data-f="' + path + '"' + (v ? ' checked' : '') + '>' +
        '<label for="' + id + '">' + label + '</label></div>';
    } else {
      input = '<input type="' + (opts.type || 'text') + '" id="' + id + '" data-f="' + path + '" value="' + esc(v == null ? '' : v) + '"' +
        (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + (opts.max ? ' maxlength="' + opts.max + '"' : '') + '>';
    }
    return '<div class="field' + (opts.span ? ' span2' : '') + '"><label for="' + id + '">' + label + '</label>' + input +
      (opts.hint ? '<div class="hint">' + opts.hint + '</div>' : '') + '</div>';
  }

  function photoCard(p, path, actions, caption) {
    return '<div class="goat-photo">' +
      '<a href="' + esc(view(p.src)) + '" target="_blank" rel="noopener"><img src="' + esc(view(p.thumb || p.src)) + '" alt=""></a>' +
      (caption ? field('Caption', path + '.caption', { max: 120 }) : '') +
      '<div class="acts">' + actions + '</div></div>';
  }

  function uploader(target, label, multiple) {
    var id = 'gu-' + target.replace(/\./g, '-');
    return '<label class="btn ghost small" for="' + id + '">' + label + '</label>' +
      '<input type="file" class="visually-hidden" id="' + id + '" data-upload="' + target + '" accept="image/*"' + (multiple ? ' multiple' : '') + '>';
  }

  function renderEditor() {
    var e = state.editing;
    var d = e.data;
    var reg = e.registry || {};
    var gp = reg.grandparents || {};
    var her = e.template === 'buck' ? 'His' : 'Her';
    var adga = function (v) { return v ? 'Blank uses ADGA: ' + shoutToName(v) : ''; };
    d.parents = d.parents || [];
    while (d.parents.length < 2) d.parents.push({});

    var hero = d.hero
      ? photoCard(d.hero, 'data.hero', uploader('hero', 'Replace…') + '<button type="button" class="btn ghost small" data-act="hero-remove">Remove</button>', false)
      : '<p class="empty-note">No main photo yet.</p>' + uploader('hero', 'Upload main photo…');

    var gallery = (d.gallery || []).map(function (p, i, all) {
      return photoCard(p, 'data.gallery.' + i,
        '<button type="button" class="btn ghost small" data-act="g-left" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move earlier">←</button>' +
        '<button type="button" class="btn ghost small" data-act="g-right" data-i="' + i + '"' + (i === all.length - 1 ? ' disabled' : '') + ' aria-label="Move later">→</button>' +
        '<button type="button" class="btn ghost small" data-act="g-main" data-i="' + i + '">Make main</button>' +
        '<button type="button" class="btn ghost small" data-act="g-remove" data-i="' + i + '">Remove</button>', true);
    }).join('');

    var parents = [0, 1].map(function (i) {
      var p = d.parents[i];
      var photos = (p.photos || []).map(function (ph, j) {
        return photoCard(ph, 'data.parents.' + i + '.photos.' + j,
          '<button type="button" class="btn ghost small" data-act="p-remove" data-i="' + i + '" data-j="' + j + '">Remove</button>', false);
      }).join('');
      return '<div class="goat-parent"><h4>' + her + (i === 0 ? ' sire' : ' dam') + '</h4>' +
        field('Registered name', 'data.parents.' + i + '.name', { max: 120 }) +
        field('Pedigree lines — one per line', 'data.parents.' + i + '.lines', { type: 'textarea', kind: 'lines', rows: 3, placeholder: 'S: …\nD: …' }) +
        field('Photo credit', 'data.parents.' + i + '.credit', { max: 80, placeholder: 'PC: …' }) +
        '<div class="goat-photos">' + photos + '</div>' + uploader('parent.' + i, 'Add photo…', true) + '</div>';
    }).join('');

    var facts = (d.facts || []).map(function (f, i) {
      return '<div class="goat-fact">' + field('Label', 'data.facts.' + i + '.label', { max: 40 }) +
        field('Value', 'data.facts.' + i + '.value', { max: 160 }) +
        '<button type="button" class="btn ghost small" data-act="fact-remove" data-i="' + i + '">Remove</button></div>';
    }).join('');

    var sections = (d.sections || []).map(function (s, i) {
      return '<div class="goat-section">' + field('Heading', 'data.sections.' + i + '.title', { max: 60 }) +
        field('Text — leave a blank line between paragraphs', 'data.sections.' + i + '.paragraphs', { type: 'textarea', kind: 'paras', rows: 6 }) +
        '<button type="button" class="btn ghost small" data-act="section-remove" data-i="' + i + '">Remove this section</button></div>';
    }).join('');
    var prompts = (d.prompts || []).length
      ? '<div class="hint" style="margin-bottom:14px">Ideas for what to write: ' + d.prompts.map(esc).join(' · ') + '</div>' : '';

    var shown = e.status === 'active';
    host.innerHTML =
      '<div id="goats-msg"></div>' +
      '<div class="goat-bar"><button type="button" class="btn ghost small" data-act="back">← All goats</button>' +
        '<h3 class="serif">' + esc(d.name || e.id) + '</h3>' +
        (shown ? '<a class="link-u" href="' + esc(pageUrl(e.id)) + '" target="_blank" rel="noopener">View page ↗</a>' : '<span class="chip">Hidden — no public page</span>') +
      '</div>' +

      '<fieldset class="goat-set"><legend>Basics</legend><div class="form-grid">' +
        field('Barn name', 'data.name', { max: 60 }) +
        field('Registered name', 'data.registered_name', { max: 120 }) +
        field('Doe or buck', 'template', { type: 'select', options: [['doe', 'Doe'], ['buck', 'Buck']] }) +
        field('On the website', 'status', { type: 'select', options: [['active', 'Shown'], ['hidden', 'Hidden (sold, retired, or not ready)']] }) +
        field('Date of birth', 'data.dob', { type: 'date' }) +
        field('ADGA number', 'data.reg', { max: 20, placeholder: 'e.g. D002247356' }) +
        field('Alpha s1 casein', 'data.alpha_s1_casein', { max: 12, placeholder: 'e.g. A/B' }) +
        field('Colour & markings', 'data.colour', { max: 120 }) +
        field('Height', 'data.height', { max: 40 }) +
        field('DNA on file with ADGA', 'data.dna_on_file', { type: 'checkbox' }) +
      '</div></fieldset>' +

      '<fieldset class="goat-set"><legend>Headline</legend><div class="form-grid">' +
        field('Badge (short, shown above the name)', 'data.badge', { max: 80, placeholder: 'e.g. ADGA Elite 2025 · 98%' }) +
        field('Badge colour', 'data.badge_tone', { type: 'select', options: [['', 'Green'], ['rust', 'Rust']] }) +
        field('A few sentences about ' + (e.template === 'buck' ? 'him' : 'her'), 'data.blurb', { type: 'textarea', rows: 3, span: true }) +
        (e.template === 'doe'
          ? field('ADGA Elite list year', 'data.elite.year', { max: 4, placeholder: 'leave blank if not Elite' }) +
            field('Elite percentile', 'data.elite.percentile', { type: 'number', placeholder: 'e.g. 98' })
          : '') +
      '</div></fieldset>' +

      '<fieldset class="goat-set"><legend>Photos</legend>' +
        '<h4>Main photo</h4><div class="goat-photos">' + hero + '</div>' +
        '<h4 style="margin-top:22px">Gallery</h4><div class="goat-photos">' + gallery + '</div>' +
        uploader('gallery', 'Add photos…', true) +
        '<div class="hint" id="goat-upload-status" aria-live="polite"></div>' +
      '</fieldset>' +

      '<fieldset class="goat-set"><legend>Pedigree</legend>' +
        '<p class="hint" style="margin:0 0 14px">Leave a box blank to use the name ADGA has on record, where we have it.</p><div class="form-grid">' +
        field('Sire', 'data.pedigree.sire', { placeholder: adga(reg.sire) }) +
        field('Dam', 'data.pedigree.dam', { placeholder: adga(reg.dam) }) +
        field('Sire’s sire', 'data.pedigree.ss', { placeholder: adga(gp.SS) }) +
        field('Sire’s dam', 'data.pedigree.sd', { placeholder: adga(gp.SD) }) +
        field('Dam’s sire', 'data.pedigree.ds', { placeholder: adga(gp.DS) }) +
        field('Dam’s dam', 'data.pedigree.dd', { placeholder: adga(gp.DD) }) +
      '</div></fieldset>' +

      '<fieldset class="goat-set"><legend>Sire and dam, with photos</legend><div class="goat-parents">' + parents + '</div></fieldset>' +

      '<fieldset class="goat-set"><legend>Extra facts</legend>' +
        '<p class="hint" style="margin:0 0 14px">Shown on the roster card and the goat’s page — e.g. “Breeding to 2026: Maple Sugar”.</p>' +
        facts + '<button type="button" class="btn ghost small" data-act="fact-add">Add a fact</button></fieldset>' +

      '<fieldset class="goat-set"><legend>Notes</legend>' + prompts + sections +
        '<button type="button" class="btn ghost small" data-act="section-add">Add a section</button></fieldset>' +

      '<div class="goat-save"><button type="button" class="btn" data-act="save">Save</button>' +
        '<span id="goat-save-status" aria-live="polite">' + (state.dirty ? 'Unsaved changes' : '') + '</span></div>' +

      '<fieldset class="goat-set danger"><legend>Delete</legend>' +
        '<p class="hint" style="margin:0 0 12px">For a goat that was sold or retired, set “On the website” to Hidden instead — the record stays for later. ' +
        'Deleting cannot be undone. Type ' + esc(d.name) + '’s name to confirm.</p>' +
        '<div class="goat-add"><div class="field"><label for="g-del-name">Name</label><input type="text" id="g-del-name"></div>' +
        '<button type="button" class="btn rust" data-act="delete">Delete permanently</button></div>' +
      '</fieldset>';
  }

  function openEditor(id) {
    var g = state.goats.filter(function (x) { return x.id === id; })[0];
    if (!g) return;
    state.editing = clone(g);
    state.dirty = false;
    renderEditor();
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function rerender() {
    var y = window.scrollY;
    renderEditor();
    window.scrollTo(0, y);
  }

  function leaveEditor() {
    if (state.dirty && !window.confirm('You have unsaved changes. Leave without saving?')) return;
    state.dirty = false;
    load();
  }

  function collect() {
    var e = state.editing;
    var d = clone(e.data);
    d.parents = (d.parents || []).slice(0, 2).map(function (p, i) {
      p.who = (e.template === 'buck' ? 'His' : 'Her') + (i === 0 ? ' sire' : ' dam');
      return p;
    });
    if (d.elite && !d.elite.year && (d.elite.percentile === '' || d.elite.percentile == null)) d.elite = null;
    return { action: 'save', id: e.id, updated_at: e.updated_at, status: e.status, template: e.template, data: d };
  }

  function save(btn) {
    if (state.uploads) { document.getElementById('goat-save-status').textContent = 'Wait for the photos to finish uploading.'; return; }
    var status = document.getElementById('goat-save-status');
    btn.disabled = true;
    status.className = '';
    status.textContent = 'Saving…';
    api('POST', collect()).then(function (r) {
      state.editing.updated_at = r.updated_at;
      state.dirty = false;
      return load(true).then(function () {
        var fresh = state.goats.filter(function (x) { return x.id === state.editing.id; })[0];
        if (fresh) state.editing = clone(fresh);
        rerender();
        var s = document.getElementById('goat-save-status');
        s.className = 'ok';
        s.innerHTML = 'Saved — it’s live now.' + (state.editing.status === 'active'
          ? ' <a class="link-u" href="' + esc(pageUrl(state.editing.id)) + '" target="_blank" rel="noopener">View page ↗</a>' : '');
      });
    }).catch(function (err) {
      status.className = 'err';
      status.textContent = 'Not saved: ' + err.message;
    }).then(function () { btn.disabled = false; });
  }

  // ---- events -----------------------------------------------------------------
  tab.addEventListener('click', function () { if (!state.editing) load(); });

  window.addEventListener('beforeunload', function (ev) {
    if (state.dirty) { ev.preventDefault(); ev.returnValue = ''; }
  });

  host.addEventListener('submit', function (ev) {
    if (ev.target.getAttribute('data-form') !== 'add') return;
    ev.preventDefault();
    var name = document.getElementById('g-new-name').value;
    var template = document.getElementById('g-new-type').value;
    api('POST', { action: 'create', name: name, template: template }).then(function (r) {
      return load(true).then(function () { openEditor(r.id); message('Added. She’s hidden until you set “On the website” to Shown.'); });
    }).catch(function (err) { message(esc(err.message), 'error'); });
  });

  function markDirty() {
    state.dirty = true;
    var s = document.getElementById('goat-save-status');
    if (s) { s.className = ''; s.textContent = 'Unsaved changes'; }
  }

  function onField(ev) {
    var t = ev.target;
    var path = t.getAttribute && t.getAttribute('data-f');
    if (!path || !state.editing) return;
    var kind = t.getAttribute('data-kind');
    var v = t.type === 'checkbox' ? t.checked
      : kind === 'lines' ? t.value.split('\n')
      : kind === 'paras' ? t.value.split(/\n\s*\n/)
      : t.value;
    setPath(state.editing, path, v);
    markDirty();
    // These change what the rest of the form shows (her/his, Elite boxes).
    if (path === 'template' || path === 'status') rerender();
  }
  host.addEventListener('input', onField);
  host.addEventListener('change', function (ev) {
    if (ev.target.getAttribute && ev.target.getAttribute('data-upload')) return onUpload(ev);
    if (ev.target.tagName === 'SELECT' || ev.target.type === 'checkbox') onField(ev);
  });

  function onUpload(ev) {
    var input = ev.target;
    var target = input.getAttribute('data-upload');
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    var d = state.editing.data;
    var done = 0;
    var status = document.getElementById('goat-upload-status') || document.getElementById('goat-save-status');
    state.uploads += files.length;
    function say(t) { if (status) status.textContent = t; }
    say('Uploading ' + files.length + (files.length === 1 ? ' photo…' : ' photos…'));
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return uploadPhoto(f).then(function (p) {
          done++;
          if (target === 'hero') d.hero = p;
          else if (target === 'gallery') (d.gallery = d.gallery || []).push(p);
          else if (target.indexOf('parent.') === 0) {
            var i = +target.split('.')[1];
            var par = d.parents[i] = d.parents[i] || {};
            (par.photos = par.photos || []).push({ src: p.src, thumb: p.thumb, alt: par.name || '' });
          }
        });
      });
    });
    chain.then(function () {
      state.uploads -= files.length;
      markDirty();
      rerender();
      var s = document.getElementById('goat-upload-status');
      if (s) s.textContent = done + (done === 1 ? ' photo' : ' photos') + ' added — press Save to publish.';
    }).catch(function (err) {
      state.uploads -= files.length;
      if (done) { markDirty(); rerender(); }
      var s = document.getElementById('goat-upload-status') || document.getElementById('goat-save-status');
      if (s) { s.className = 'err'; s.textContent = 'Upload stopped: ' + err.message; }
    });
  }

  host.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    var id = b.getAttribute('data-id');
    var i = +b.getAttribute('data-i');
    var d = state.editing && state.editing.data;

    if (act === 'edit') return openEditor(id);
    if (act === 'up' || act === 'down') {
      b.disabled = true;
      return api('POST', { action: 'move', id: id, direction: act }).then(function () { return load(); })
        .catch(function (err) { message(esc(err.message), 'error'); });
    }
    if (act === 'back') return leaveEditor();
    if (act === 'save') return save(b);
    if (act === 'delete') {
      var typed = document.getElementById('g-del-name').value;
      return api('POST', { action: 'delete', id: state.editing.id, confirm_name: typed }).then(function () {
        state.dirty = false;
        return load().then(function () { message('Deleted.'); });
      }).catch(function (err) { message(esc(err.message), 'error'); });
    }

    var g = d && d.gallery;
    if (act === 'g-left' && i > 0) { var t = g[i - 1]; g[i - 1] = g[i]; g[i] = t; }
    else if (act === 'g-right' && i < g.length - 1) { var u = g[i + 1]; g[i + 1] = g[i]; g[i] = u; }
    else if (act === 'g-main') d.hero = clone(g[i]);
    else if (act === 'g-remove') g.splice(i, 1);
    else if (act === 'hero-remove') d.hero = null;
    else if (act === 'p-remove') d.parents[i].photos.splice(+b.getAttribute('data-j'), 1);
    else if (act === 'fact-add') (d.facts = d.facts || []).push({ label: '', value: '' });
    else if (act === 'fact-remove') d.facts.splice(i, 1);
    else if (act === 'section-add') (d.sections = d.sections || []).push({ title: '', paragraphs: [] });
    else if (act === 'section-remove') d.sections.splice(i, 1);
    else return;
    markDirty();
    rerender();
  });
})();
