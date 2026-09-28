# A Little Hill Farm — website

The farm site (herd, goat pages, goat guide, about) and the feed store, both
on Cloudflare Workers, sharing one D1 database and one photo bucket. No
framework and no npm dependencies.

```
index.html          home — herd cards and counts filled from the database
does.html           the does   (roster filled from the database)
bucks.html          the bucks  (roster filled from the database)
breeding.html       kidding schedule
guide.html          "thinking about goats?" — ten things + first-aid kit
about.html          our story + contact (#contact)
404.html
site-worker.js      the farm site's worker: see the comment at its top
site/chrome.js      the shared header, footer, fonts, icons and share tags
site/goats.js       goat pages, roster rows and herd cards, from the goats table
site/redirects.js   old Shopify addresses -> their new pages (301)
wrangler.site.toml  farm-site deploy config
build-site.sh       copies the static files into dist-site/ for deploy
assets/             site.css, site.js, logos, icons, og/ share cards, photos/
store/              the feed store and the admin screen — see store/README.md
seed/               where the herd data came from (one-time import)
optimize-images.py  recompress photos, make thumbnails and the small logo
make-share-images.py  the link-preview cards and site icons
research/           the Shopify-exit research and decision
```

## Everyday changes

| To change | Where | Then |
|---|---|---|
| A goat — photos, notes, pedigree, badge, order, shown/hidden | store admin → **Goats** | nothing, live on save |
| The menu or footer, on every page | `site/chrome.js` | deploy |
| About, guide, breeding copy | that `.html` file | deploy |
| A page's link-preview card | `make-share-images.py` | run it, deploy |

Deploy the farm site:

```bash
bash build-site.sh
npx wrangler deploy -c wrangler.site.toml
```

## How a page is put together

The `.html` files carry only their own content, with empty
`<header data-chrome>` / `<footer data-chrome>` placeholders. As each page is
served, `site-worker.js` adds the shared header and footer, the fonts and
icons, and share-preview tags built from the page's `<title>`,
`<meta name="description">` and `<meta name="share-image">`. On the home,
Does and Bucks pages it also fills elements marked `data-goats="…"` and
`data-count="…"` from the `goats` table. The static herd markup inside those
elements is the fallback if the database is ever unreachable.

Goat pages (`/goats/<id>.html`) have no file at all; `site/goats.js` renders
them from the table. `/sitemap.xml` lists the pages and every shown goat.

Canonical and share URLs are built from the request's own address, so the
same code is right on the workers.dev address today and on
alittlehillfarm.com after the move.

## Photos

Site photos live in `assets/photos/`, with 640px copies in
`assets/photos/thumbs/` that cards, rosters and avatars use. After adding
photos here, run `python optimize-images.py`. Photos uploaded from the admin
screen are shrunk in the browser and stored in R2 (`/media/…`) instead.

## Old Shopify addresses

`site/redirects.js` maps every page the Shopify site had (`/pages/about-us`,
`/pages/sugar`, `/policies/refund-policy`, `/products/<handle>` …) to its new
home. They take effect once `alittlehillfarm.com` points at this worker — see
*Going live* in `store/README.md`.

## Backing up the herd

```bash
cd store && npx wrangler d1 export alhf-store --remote --table=goats --output=../seed/goats-backup.sql
```

## Embed mode

Add `?embed=1` to any page to hide the header and footer (links keep the
flag, and the page posts its height to a parent frame).
