/* The account page: sign in (Google, or a code sent by email), then see your
 * details and orders. The server decides everything — /api/me says who is
 * signed in and which sign-in methods are switched on. */
(function () {
  'use strict';
  var host = document.getElementById('acct');
  var title = document.getElementById('acct-title');
  var params = new URLSearchParams(location.search);
  var back = params.get('return') || '';
  if (!/^\/[A-Za-z0-9/_?=&.%-]*$/.test(back) || back.indexOf('//') === 0 || back === '/account') back = '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(c) { return '$' + (Math.round(Number(c) || 0) / 100).toFixed(2); }
  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again.');
        return d;
      });
    });
  }
  function done() { location.href = back || '/account'; }

  // ---- signed out ---------------------------------------------------------
  function renderSignIn(me, err) {
    var m = me.methods || {};
    title.textContent = 'Log in';
    if (!m.email && !m.google) {
      host.innerHTML = '<p class="lede">Customer accounts are not open yet. You can still check out as a guest.</p>' +
        '<p><a class="btn" href="index.html">Back to the store</a></p>';
      return;
    }
    host.innerHTML =
      '<p class="lede" style="margin-bottom:26px">Log in to see your orders and check out faster. ' +
        'If we have your business on file as tax-exempt, logging in is how the exemption is applied. ' +
        'No password — you’ll never need to remember one.</p>' +
      (err ? '<p class="alert error">' + esc(err) + '</p>' : '') +
      '<div class="signin">' +
        (m.google
          ? '<a class="btn google" href="/auth/google' + (back ? '?return=' + encodeURIComponent(back) : '') + '">' +
            '<svg class="g" aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg> Continue with Google</a>' : '') +
        (m.google && m.email ? '<div class="or"><span>or</span></div>' : '') +
        (m.email
          ? '<form id="code-ask" novalidate>' +
              '<div class="field"><label for="acct-email">Email address</label>' +
              '<input type="email" id="acct-email" autocomplete="email" required></div>' +
              '<button type="submit" class="btn ghost">Email me a sign-in code</button>' +
            '</form>' +
            '<form id="code-check" novalidate hidden>' +
              '<p id="code-sent" class="lede" style="font-size:15px"></p>' +
              '<div class="field"><label for="acct-code">6-digit code</label>' +
              '<input type="text" id="acct-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></div>' +
              '<button type="submit" class="btn">Log in</button> ' +
              '<button type="button" class="link-btn" id="code-restart">Use a different email</button>' +
            '</form>' : '') +
        '<p class="form-msg" id="acct-msg" role="status"></p>' +
      '</div>' +
      '<p class="hint" style="margin-top:26px">Just ordering once? You don’t need an account — ' +
        '<a href="index.html">check out as a guest</a>.</p>';

    var ask = document.getElementById('code-ask');
    var check = document.getElementById('code-check');
    var msg = document.getElementById('acct-msg');
    var email = '';
    function say(t, bad) { msg.textContent = t || ''; msg.className = 'form-msg' + (bad ? ' err' : ''); }
    if (!ask) return;

    ask.addEventListener('submit', function (e) {
      e.preventDefault();
      email = document.getElementById('acct-email').value.trim();
      var btn = ask.querySelector('button');
      btn.disabled = true;
      say('Sending…');
      post('/api/auth/code', { email: email }).then(function () {
        ask.hidden = true;
        check.hidden = false;
        document.getElementById('code-sent').textContent =
          'We sent a code to ' + email + '. It works for 10 minutes — check your spam folder if it isn’t there in a minute.';
        say('');
        document.getElementById('acct-code').focus();
      }).catch(function (err) { say(err.message, true); }).then(function () { btn.disabled = false; });
    });
    check.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = check.querySelector('button[type=submit]');
      btn.disabled = true;
      say('Checking…');
      post('/api/auth/verify', { email: email, code: document.getElementById('acct-code').value })
        .then(done)
        .catch(function (err) { say(err.message, true); btn.disabled = false; });
    });
    document.getElementById('code-restart').addEventListener('click', function () {
      check.hidden = true; ask.hidden = false; say('');
      document.getElementById('acct-email').focus();
    });
  }

  // ---- signed in ----------------------------------------------------------
  var STATUS = {
    authorized: 'Received — card held, not charged yet',
    processing: 'Received — bank payment processing',
    failed: 'Payment did not go through — please contact us',
    captured: 'Paid',
    awaiting_cash: 'Received — pay cash at pickup',
    recorded: 'Paid in person',
    canceled: 'Canceled',
    refunded: 'Refunded',
  };

  function renderAccount(me) {
    title.textContent = 'Your account';
    var perks = [];
    if (me.tax_exempt) perks.push('<span class="badge moss">Tax-exempt</span>');
    if (me.trusted) perks.push('<span class="badge">Established customer</span>');
    var orders = (me.orders || []).map(function (o) {
      var items = (o.items || []).map(function (l) {
        return esc(l.qty) + ' × ' + esc(l.name) + (l.unit ? ' <span class="muted">(' + esc(l.unit) + ')</span>' : '');
      }).join('<br>');
      return '<article class="acct-order">' +
        '<div class="top"><strong>' + esc(new Date(o.sold_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })) +
        '</strong><span>' + money(o.total_cents) + '</span></div>' +
        '<div class="items">' + items + '</div>' +
        '<div class="st">' + esc(STATUS[o.status] || o.status) + '</div></article>';
    }).join('');
    host.innerHTML =
      '<div class="acct-card">' +
        '<div><div class="label">Signed in as</div><div class="v">' + esc(me.email) + '</div>' +
        (me.name ? '<div class="sub">' + esc(me.name) + (me.phone ? ' · ' + esc(me.phone) : '') + '</div>' : '') + '</div>' +
        (perks.length ? '<div class="perks">' + perks.join(' ') + '</div>' : '') +
      '</div>' +
      (me.tax_exempt ? '<p class="hint">Your tax exemption is applied automatically when you check out while logged in.</p>' : '') +
      '<div class="rule-head" style="margin-top:36px"><h2 class="serif" style="font-size:26px">Your orders</h2><div class="rule"></div></div>' +
      (orders || '<p class="empty-note">No orders yet. <a href="index.html">Browse the store</a>.</p>') +
      '<p style="margin-top:36px">' + (me.is_admin ? '<a class="btn" href="/admin">Open the admin →</a> ' : '') +
        '<a class="btn' + (me.is_admin ? ' ghost' : '') + '" href="index.html">Shop the store</a> ' +
        '<button type="button" class="btn ghost" id="logout">Log out</button></p>';
    document.getElementById('logout').addEventListener('click', function () {
      post('/api/auth/logout').then(function () { location.href = 'index.html'; });
    });
  }

  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (me.signed_in) renderAccount(me);
      else renderSignIn(me, params.get('error'));
    })
    .catch(function () {
      host.innerHTML = '<p class="alert error">Could not reach the store just now. Please refresh in a moment.</p>';
    });
})();
