/**
 * Farm site worker. Every request passes through here (run_worker_first).
 *
 *   /pages/..., /products/...   301 to the new page (site/redirects.js)
 *   /media/<uuid>.<ext>         photos uploaded from the admin screen (R2)
 *   /goats/<id>.html            rendered from the goats table (site/goats.js)
 *   /sitemap.xml, /robots.txt   generated, so they always list current goats
 *   everything else             the static file in dist-site/
 *
 * Every HTML page then gets, as it streams out:
 *   - the shared header and footer (site/chrome.js) into its empty
 *     <header data-chrome> / <footer data-chrome> placeholders
 *   - fonts, icons, and share-preview tags built from its own <title>,
 *     <meta name="description"> and optional <meta name="share-image">
 *   - on the home, Does and Bucks pages, the herd from the database into
 *     elements marked data-goats="..." and data-count="..."
 *
 * The static files keep their last-known herd content inside those
 * elements, so if the database is unreachable a page still renders.
 *
 * html_handling = "none" keeps /does.html links working without redirects,
 * but also turns off index.html resolution, so "/" is mapped here.
 */
import { headerInner, footerInner, headExtras, currentNav, farmJsonLd } from './site/chrome.js';
import {
  loadGoats, loadGoat, goatPage, rosterArticle, herdCard, numberWord, capitalise,
} from './site/goats.js';
import { oldShopifyAddress } from './site/redirects.js';

// Pages whose herd sections come from the database.
const HERD_PAGES = new Set(['/index.html', '/does.html', '/bucks.html']);
// Static pages listed in the sitemap, most important first.
const SITEMAP_PAGES = ['/', '/does.html', '/bucks.html', '/breeding.html', '/guide.html', '/about.html'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const moved = oldShopifyAddress(url.pathname);
    if (moved) return Response.redirect(new URL(moved, url).toString(), 301);

    if (url.pathname.startsWith('/media/')) return serveMedia(url.pathname, env);
    if (url.pathname === '/sitemap.xml') return sitemap(url.origin, env);
    if (url.pathname === '/robots.txt') {
      return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${url.origin}/sitemap.xml\n`, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const goat = /^\/goats\/([a-z0-9-]+)(?:\.html)?$/.exec(url.pathname);
    if (goat) return decorate(await goatResponse(goat[1], request, env), url, env);

    const path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const res = await env.ASSETS.fetch(new Request(new URL(path, url), request));
    return decorate(res, url, env, path);
  },
};

// ---------------------------------------------------------------------------
// goat pages
// ---------------------------------------------------------------------------

async function goatResponse(id, request, env) {
  let g;
  try {
    g = await loadGoat(env, id);
  } catch (err) {
    console.error('goats table unavailable: ' + err);
    return new Response('The herd pages are briefly unavailable. Please try again in a minute.', {
      status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' },
    });
  }
  if (!g) {
    // Same 404 page as any other missing address, decorated like the rest.
    return env.ASSETS.fetch(new Request(new URL('/404.html', request.url), request))
      .then((r) => new Response(r.body, { status: 404, headers: r.headers }));
  }
  return new Response(goatPage(g), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// ---------------------------------------------------------------------------
// the per-page decoration pass
// ---------------------------------------------------------------------------

async function decorate(res, url, env, assetPath) {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/html')) return res;

  const path = assetPath || url.pathname;
  const meta = { title: '', description: '', image: '', section: '' };

  let herd = null;
  if (HERD_PAGES.has(path)) {
    try {
      herd = await loadGoats(env);
    } catch (err) {
      console.error('goats table unavailable, serving static herd: ' + err);
    }
  }
  const does = herd ? herd.filter((g) => g.template === 'doe') : [];
  const bucks = herd ? herd.filter((g) => g.template === 'buck') : [];

  const rewriter = new HTMLRewriter()
    .on('title', { text(t) { meta.title += t.text; } })
    .on('meta[name="description"]', { element(e) { meta.description = e.getAttribute('content') || ''; } })
    .on('meta[name="share-image"]', { element(e) { meta.image = e.getAttribute('content') || ''; e.remove(); } })
    .on('meta[name="nav-section"]', { element(e) { meta.section = e.getAttribute('content') || ''; e.remove(); } })
    .on('head', {
      element(e) {
        e.onEndTag((end) => {
          const isHome = path === '/index.html';
          end.before(headExtras({
            origin: url.origin,
            path: res.status === 404 ? '/404.html' : path,
            title: unescapeHtml(meta.title.trim()),
            description: unescapeHtml(meta.description),
            image: meta.image,
            type: path.startsWith('/goats/') ? 'profile' : 'website',
            jsonld: isHome || path === '/about.html' ? farmJsonLd(url.origin) : null,
          }), { html: true });
        });
      },
    })
    .on('header[data-chrome]', {
      element(e) { e.setInnerContent(headerInner(currentNav(path, meta.section)), { html: true }); },
    })
    .on('footer[data-chrome]', {
      element(e) { e.setInnerContent(footerInner(), { html: true }); },
    });

  if (herd) {
    const fill = {
      'does-roster': () => does.map(rosterArticle).join('') + '\n  ',
      'bucks-roster': () => bucks.map(rosterArticle).join('') + '\n  ',
      'does-cards': () => does.map(herdCard).join('') + '\n    ',
      'bucks-cards': () => bucks.map(herdCard).join('') + '\n    ',
    };
    const count = {
      does: () => numberWord(does.length),
      Does: () => capitalise(numberWord(does.length)),
      bucks: () => numberWord(bucks.length),
      Bucks: () => capitalise(numberWord(bucks.length)),
      'does-n': () => String(does.length),
      'bucks-n': () => String(bucks.length),
      'elite-n': () => String(herd.filter((g) => g.elite).length),
    };
    rewriter
      .on('[data-goats]', {
        element(e) {
          const f = fill[e.getAttribute('data-goats')];
          if (f) e.setInnerContent(f(), { html: true });
        },
      })
      .on('[data-count]', {
        element(e) {
          const f = count[e.getAttribute('data-count')];
          if (f) e.setInnerContent(f());
        },
      });
  }

  const out = new Response(rewriter.transform(res).body, res);
  // Edits made in the admin screen should show on the next load.
  out.headers.set('cache-control', 'no-cache');
  return out;
}

// HTMLRewriter hands over text and attributes still HTML-escaped. Undo the
// common entities so headExtras() can escape them exactly once.
const unescapeHtml = (s) =>
  String(s || '').replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e]);

// ---------------------------------------------------------------------------
// sitemap + uploaded media
// ---------------------------------------------------------------------------

async function sitemap(origin, env) {
  let goats = [];
  try { goats = await loadGoats(env); } catch (err) { console.error('sitemap without goats: ' + err); }
  const urls = SITEMAP_PAGES.map((p) => origin + p).concat(goats.map((g) => `${origin}/goats/${g.id}.html`));
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') + '\n</urlset>\n';
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}

// Same rules as the store worker's copy: only a random-named image under
// uploads/ is ever served, with the type detected at upload time.
async function serveMedia(path, env) {
  const name = path.split('/').filter(Boolean).pop() || '';
  if (!/^[a-f0-9-]{8,}\.(jpg|png|gif|webp)$/.test(name)) return new Response('Not found', { status: 404 });
  const obj = await env.MEDIA.get('uploads/' + name);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  headers.set('content-type', obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', "default-src 'none'; sandbox");
  return new Response(obj.body, { headers });
}
