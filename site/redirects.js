/**
 * Addresses the old Shopify site used, mapped to their new homes, so
 * bookmarks, search results and links in old emails land somewhere sensible
 * once alittlehillfarm.com points here. site-worker.js answers these with a
 * 301 (permanent), which also moves search ranking to the new page.
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

export function oldShopifyAddress(pathname) {
  const path = pathname.replace(/\/+$/, '').toLowerCase() || '/';
  if (SHOPIFY[path]) return SHOPIFY[path];
  // Store product ids are the Shopify product handles, so a product link
  // goes straight to the same product in the new store.
  const product = path.match(/^(?:\/collections\/[^/]+)?\/products\/([a-z0-9-]+)$/);
  if (product) return STORE + '/product?id=' + product[1];
  if (path === '/collections' || path.startsWith('/collections/')) return STORE + '/';
  return null;
}
