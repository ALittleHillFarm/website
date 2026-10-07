/* The invoice pay page (/pay?inv=<token>). Shows what the farm wrote up and
 * sends the customer to Stripe for whichever method they choose. */
(function () {
  'use strict';
  var host = document.getElementById('pay');
  var token = new URLSearchParams(location.search).get('inv') || '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(c) { return '$' + (Math.round(Number(c) || 0) / 100).toFixed(2); }
  function fail(msg) { host.innerHTML = '<p class="alert error">' + esc(msg) + '</p>'; }

  if (!token) { fail('This link is missing its invoice code. Please use the link in your invoice email.'); return; }

  fetch('/api/invoice?t=' + encodeURIComponent(token))
    .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Could not load the invoice.'); return d; }); })
    .then(function (inv) {
      document.getElementById('pay-title').textContent = 'Invoice ' + inv.ref;
      var rows = inv.lines.map(function (l) {
        return '<div class="row"><span>' + esc(l.qty) + ' × ' + esc(l.name) + (l.unit ? ' <span class="muted">(' + esc(l.unit) + ')</span>' : '') +
          '</span><span>' + money(l.list_price_cents * l.qty) + '</span></div>';
      }).join('');
      var head = '<p class="lede" style="margin-bottom:20px">For ' + esc(inv.customer_name || '') + ' · Pickup: ' + esc(inv.pickup) + '</p>' +
        (inv.note ? '<p class="alert success" style="margin-bottom:20px">' + esc(inv.note) + '</p>' : '') +
        '<div class="quote pay-lines">' + rows + '</div>';
      if (inv.paid) {
        host.innerHTML = head + '<p class="alert success" style="margin-top:22px"><strong>Paid — thank you!</strong>' +
          (inv.total_paid_cents ? ' ' + money(inv.total_paid_cents) + ' received.' : '') + ' We will be in touch about pickup.</p>';
        return;
      }
      host.innerHTML = head +
        '<div class="pay-choices">' +
          '<div class="pay-choice"><div class="t">Bank transfer</div><div class="amt">' + money(inv.ach.total_cents) + '</div>' +
            '<div class="d">2% off · pay securely from your bank account</div>' +
            '<button type="button" class="btn" data-method="ach">Pay by bank transfer</button></div>' +
          '<div class="pay-choice"><div class="t">Card</div><div class="amt">' + money(inv.card.total_cents) + '</div>' +
            '<div class="d">Credit or debit card</div>' +
            '<button type="button" class="btn ghost" data-method="card">Pay by card</button></div>' +
        '</div>' +
        '<p class="hint" style="margin-top:14px">' + (inv.tax_exempt ? 'Tax-exempt — no sales tax.' : 'Totals include Idaho sales tax.') +
        ' Payments are processed by Stripe. Rather pay cash or check at pickup? Just reply to the invoice email.</p>' +
        '<p id="pay-msg" class="form-msg" role="status"></p>';
    })
    .catch(function (err) { fail(err.message); });

  host.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-method]');
    if (!b) return;
    var all = host.querySelectorAll('button[data-method]');
    for (var i = 0; i < all.length; i++) all[i].disabled = true;
    var msg = document.getElementById('pay-msg');
    msg.textContent = 'Taking you to the secure payment page…';
    fetch('/api/invoice/pay', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: token, method: b.getAttribute('data-method') }),
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong.'); return d; }); })
      .then(function (d) { location.href = d.redirect_url; })
      .catch(function (err) {
        msg.textContent = err.message; msg.className = 'form-msg err';
        for (var i = 0; i < all.length; i++) all[i].disabled = false;
      });
  });
})();
