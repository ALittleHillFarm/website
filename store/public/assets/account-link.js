/* The "Log in" / "Account" link at the top right of every store page.
 * It starts hidden and only appears once the server says sign-in is switched
 * on (a sign-in method is configured), so there is never a link to nowhere.
 * Signed in, it reads "Account"; otherwise "Log in", returning here after. */
(function () {
  var link = document.querySelector('[data-account-link]');
  if (!link || !window.fetch) return;
  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (me) {
      var m = me.methods || {};
      if (me.signed_in) {
        link.textContent = 'Account';
        link.href = '/account';
      } else if (m.email || m.google) {
        link.textContent = 'Log in';
        link.href = '/account?return=' + encodeURIComponent(location.pathname + location.search);
      } else {
        return;
      }
      if (location.pathname === '/account') link.setAttribute('aria-current', 'page');
      link.hidden = false;
      window.alhfMe = me;
      document.dispatchEvent(new CustomEvent('alhf:me', { detail: me }));
    })
    .catch(function () { /* the link just stays hidden */ });
})();
