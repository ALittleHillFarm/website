/* Three jobs: keep the current menu item in view, open photos full size,
   and support embed mode.
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
  // On phones the menu is one sideways-scrolling row; bring the current
  // page's tab into view so "About" isn't hidden off the right edge.
  var nav = document.querySelector('.site-nav');
  var cur = nav && nav.querySelector('[aria-current="page"]');
  if (cur && nav.scrollWidth > nav.clientWidth) {
    nav.scrollLeft = cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2;
  }
  // Tap a gallery or parent photo to see it full size. Without this script
  // the link still opens the image on its own, so nothing is lost.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a.zoom');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    var img = a.querySelector('img');
    var box = document.createElement('figure');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', (img && img.alt) || 'Photo');
    box.innerHTML = '<button class="close" type="button" aria-label="Close">&times;</button><img alt="">' +
      ((img && img.alt) ? '<figcaption></figcaption>' : '');
    box.querySelector('img').src = a.getAttribute('href');
    box.querySelector('img').alt = (img && img.alt) || '';
    if (img && img.alt) box.querySelector('figcaption').textContent = img.alt;
    function close() {
      document.removeEventListener('keydown', onKey);
      box.remove();
      a.focus();
    }
    function onKey(ev) { if (ev.key === 'Escape') close(); }
    box.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
    box.querySelector('.close').focus();
  });

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
