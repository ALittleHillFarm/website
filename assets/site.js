/* Two jobs: mark the current nav item, and support embed mode.
   Add ?embed=1 to any URL (or embed the page in an iframe and pass it)
   and the header + footer disappear, leaving just the page content —
   which is what a Shopify iframe wants. */
(function () {
  var p = new URLSearchParams(location.search);
  if (p.get('embed') === '1' || p.get('embed') === 'true') {
    document.body.classList.add('embed');
    // keep any in-site links inside the iframe in embed mode
    document.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href');
      if (!href || /^(https?:|mailto:|tel:|#)/.test(href)) return;
      a.setAttribute('href', href + (href.indexOf('?') > -1 ? '&' : '?') + 'embed=1');
    });
  }
  // tell a parent frame how tall we are, so Shopify can size the iframe
  function postHeight() {
    if (window.parent === window) return;
    var h = document.documentElement.scrollHeight;
    window.parent.postMessage({ alhfHeight: h }, '*');
  }
  window.addEventListener('load', postHeight);
  window.addEventListener('resize', postHeight);
  if (window.ResizeObserver) new ResizeObserver(postHeight).observe(document.body);
})();
