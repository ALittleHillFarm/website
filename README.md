# A Little Hill Farm — website

The farm site (herd, goat guide, about) and the feed store, both on Cloudflare
Workers. No framework and no npm dependencies; Python only generates pages.

```
index.html          herd overview
does.html           the does
bucks.html          the herdsires
breeding.html       2026 kidding schedule
guide.html          "thinking about goats?" — ten things to know + first-aid kit
about.html          our story + contact (#contact)
404.html            root-relative links, because it is served at any path
goats/              one page per goat — GENERATED, do not hand-edit
goats.json          farm-written goat content (photos, notes, parents)
goat-registry.json  ADGA data harvested from genetics.adga.org (read-only)
build-goats.py      goats.json + goat-registry.json -> goats/*.html
chrome.py           the shared menu and footer, defined once
build-site.sh       runs both generators, assembles dist-site/
site-worker.js      serves the site; 301s old Shopify addresses to new pages
wrangler.site.toml  farm-site deploy config
assets/             site.css, site.js, logo, photos/
store/              the feed store — see store/README.md
research/           the Shopify-exit research and decision
```

## Everyday changes

| To change | Edit | Then |
|---|---|---|
| A goat's photos, notes or parents | `goats.json` | deploy |
| The menu or footer, on every page | `chrome.py` | deploy |
| About, guide, breeding, does/bucks copy | that `.html` file | deploy |

Deploy the farm site:

```bash
bash build-site.sh
npx wrangler deploy -c wrangler.site.toml
```

`build-site.sh` runs `chrome.py` and `build-goats.py` first, so the menu and
goat pages are always current. Photos live in `assets/photos/`; keep new ones
around 900px on the long edge.

## Old Shopify addresses

`site-worker.js` maps every page the Shopify site had (`/pages/about-us`,
`/pages/sugar`, `/policies/refund-policy`, `/products/<handle>` …) to its new
home with a permanent redirect. They take effect once `alittlehillfarm.com`
points at this worker — see *Going live* in `store/README.md`.

## Embed mode

Add `?embed=1` to any page to hide the header and footer (links keep the flag,
and the page posts its height to a parent frame). Left over from embedding in
Shopify; harmless, and handy for dropping a page into another site.
