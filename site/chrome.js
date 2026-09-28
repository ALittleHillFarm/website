/**
 * The farm site's shared header, footer and <head> extras, defined once.
 *
 * site-worker.js injects these into every page as it is served: the
 * hand-written .html files carry empty <header data-chrome> and
 * <footer data-chrome> placeholders, and the goat pages are rendered whole.
 * A menu change is made here and nowhere else.
 *
 * Links are root-absolute ("/does.html") so they work from any depth,
 * including the 404 page, which is served at whatever path was missing.
 */
export const STORE_URL = 'https://store.alittlehillfarm.com/';
export const EMAIL = 'christine@alittlehillfarm.com';
export const PHONE = '208-875-9563';
export const SITE_NAME = 'A Little Hill Farm';

export const NAV = [
  ['Herd', '/'],
  ['Does', '/does.html'],
  ['Bucks', '/bucks.html'],
  ['2026 Kiddings', '/breeding.html'],
  ['Goat Guide', '/guide.html'],
  ['About', '/about.html'],
  ['Feed Store', STORE_URL],
];

export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/** Which menu item a path belongs to. Goat pages sit under Does or Bucks. */
export function currentNav(pathname, section) {
  if (section) return section;
  if (pathname === '/' || pathname === '/index.html') return '/';
  return pathname;
}

export function headerInner(current) {
  const links = NAV.map(
    ([label, href]) =>
      `      <a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`
  ).join('\n');
  return `
  <div class="bar">
    <a class="brand" href="/">
      <img src="/assets/logo-small.png" alt="" width="46" height="46">
      <span>
        <span class="name">${SITE_NAME}</span><br>
        <span class="sub">Potlatch, Idaho · ADGA Registered</span>
      </span>
    </a>
    <nav class="site-nav" aria-label="Main">
${links}
    </nav>
  </div>
`;
}

export function footerInner() {
  const tel = '+1' + PHONE.replace(/-/g, '');
  return `
  <div class="cols">
    <div>
      <div class="mark">${SITE_NAME}</div>
      <p style="font-size:14px;line-height:1.7">ADGA registered Nigerian Dwarf dairy goats and organic feed in Potlatch, Idaho.</p>
    </div>
    <div>
      <h4>The herd</h4>
      <ul>
        <li><a href="/does.html">Does</a></li>
        <li><a href="/bucks.html">Bucks</a></li>
        <li><a href="/breeding.html">2026 Kiddings</a></li>
      </ul>
    </div>
    <div>
      <h4>The farm</h4>
      <ul>
        <li><a href="/about.html">About us</a></li>
        <li><a href="/guide.html">Goat guide</a></li>
        <li><a href="${STORE_URL}">Feed Store</a></li>
      </ul>
    </div>
    <div>
      <h4>Get in touch</h4>
      <ul>
        <li><a href="mailto:${EMAIL}">${EMAIL}</a></li>
        <li><a href="tel:${tel}">${PHONE}</a></li>
        <li><a href="https://genetics.adga.org">ADGA Genetics</a></li>
      </ul>
    </div>
  </div>
  <div class="fine">
    <span>&copy; ${SITE_NAME}</span>
    <span>Potlatch, Idaho</span>
  </div>
`;
}

/**
 * Everything a page's <head> needs beyond its own title and description:
 * fonts, icons, and the tags that make a shared link show a picture.
 * `origin` comes from the request, so the same code is correct on the
 * workers.dev address today and on alittlehillfarm.com after the move.
 */
export function headExtras({ origin, path, title, description, image, imageAlt, type, jsonld }) {
  const abs = (u) => (/^https?:/.test(u) ? u : origin + (u.startsWith('/') ? u : '/' + u));
  const canonical = origin + (path === '/index.html' ? '/' : path);
  const img = abs(image || '/assets/og/default.jpg');
  const t = esc(title || SITE_NAME);
  const d = esc(description || '');
  return `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,300;1,6..72,400&family=Hanken+Grotesk:wght@400;500;600;700&display=swap">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#59803D">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="${esc(type || 'website')}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:alt" content="${esc(imageAlt || title || SITE_NAME)}">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>\n` : ''}`;
}

/** Schema.org description of the farm, for search engines' business panels. */
export function farmJsonLd(origin) {
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: SITE_NAME,
    description:
      'ADGA registered Nigerian Dwarf dairy goats and a pre-order organic feed store in Potlatch, Idaho.',
    url: origin + '/',
    logo: origin + '/assets/logo-full.png',
    image: origin + '/assets/og/default.jpg',
    email: EMAIL,
    telephone: '+1-' + PHONE,
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Potlatch',
      addressRegion: 'ID',
      postalCode: '83855',
      addressCountry: 'US',
    },
    areaServed: ['Potlatch, ID', 'Moscow, ID', "Coeur d'Alene, ID"],
    sameAs: [STORE_URL],
  };
}
