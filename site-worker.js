/**
 * Farm site — static pages, plus redirects from the old Shopify addresses.
 *
 * html_handling = "none" keeps the hand-written does.html / goats/calypso.html
 * links working without redirects, but it also turns off index.html
 * resolution, so "/" would 404. This maps directory paths to their index.html
 * and passes everything else straight through.
 *
 * SHOPIFY maps the addresses the old alittlehillfarm.com used, so bookmarks,
 * search results and links in old emails land somewhere sensible once the
 * domain points here. 301 = permanent, which also tells search engines to
 * move their ranking to the new page.
 */
const STORE = 'https://store.alittlehillfarm.com';

const SHOPIFY = {
  '/pages/about-us': '/about.html',
  '/pages/contact': '/about.html#contact',
  '/pages/nigerian-dwarf-goats': '/guide.html',
  '/pages/more': '/guide.html#kit',
  '/pages/our-goats': '/',
  '/pages/does': '/does.html',
  '/pages/bucks': '/bucks.html',
  '/pages/spring-2026-breeding-schedule': '/breeding.html',
  '/pages/calypso': '/goats/calypso.html',
  '/pages/cookie': '/goats/cookie.html',
  '/pages/sugar': '/goats/maple-sugar.html',
  '/pages/royal': '/goats/royal-tea.html',
  '/pages/maylsee': '/goats/maylsee.html',
  '/pages/toby': '/goats/toby.html',
  '/pages/polaris': '/goats/polaris.html',
  '/pages/data-sharing-opt-out': STORE + '/policies#privacy',
  '/policies/privacy-policy': STORE + '/policies#privacy',
  '/policies/refund-policy': STORE + '/policies#returns',
  '/policies/shipping-policy': STORE + '/policies#pickup',
  '/policies/terms-of-service': STORE + '/policies#ordering',
  '/policies/contact-information': '/about.html#contact',
  '/cart': STORE + '/',
  '/search': STORE + '/',
};

function oldShopifyAddress(pathname) {
  const path = pathname.replace(/\/+$/, '').toLowerCase() || '/';
  if (SHOPIFY[path]) return SHOPIFY[path];
  // Store product ids are the Shopify product handles, so a product link
  // goes straight to the same product in the new store.
  const product = path.match(/^(?:\/collections\/[^/]+)?\/products\/([a-z0-9-]+)$/);
  if (product) return STORE + '/product?id=' + product[1];
  if (path === '/collections' || path.startsWith('/collections/')) return STORE + '/';
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const moved = oldShopifyAddress(url.pathname);
    if (moved) return Response.redirect(new URL(moved, url).toString(), 301);
    if (url.pathname.endsWith('/')) {
      return env.ASSETS.fetch(new Request(new URL(url.pathname + 'index.html', url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
