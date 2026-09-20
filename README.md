# A Little Hill Farm — goat pages

Static site for the A Little Hill Farm herd. No build step, no dependencies.
Open any file in a browser and it works.

```
index.html          herd overview
does.html           the five does
bucks.html          the two herdsires
breeding.html       spring 2026 kidding schedule
404.html
goats/              one page per goat
  calypso.html  maple-sugar.html  royal-tea.html  cookie.html
  mayslee.html  toby.html  polaris.html
assets/
  site.css          all styling
  site.js           nav state + embed mode
  logo.png
```

## Publishing to GitHub Pages

1. Push these files to the root of `github.com/ALittleHillFarm/website`.
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. It goes live at `https://alittlehillfarm.github.io/website/` in a minute or two.

`.nojekyll` is present so GitHub serves the files as-is.

## Embedding in Shopify

Every page hides its header and footer when you add `?embed=1` to the URL:

```html
<iframe src="https://alittlehillfarm.github.io/website/does.html?embed=1"
        style="width:100%;border:0" height="1200" title="Our does"></iframe>
```

In embed mode, links between pages keep the `embed=1` flag, so navigation stays
inside the frame. Each page also posts its height to the parent window, so the
iframe can resize itself:

```html
<script>
  window.addEventListener('message', function (e) {
    if (e.data && e.data.alhfHeight) {
      document.querySelector('iframe[title="Our does"]').height = e.data.alhfHeight;
    }
  });
</script>
```

## Editing content

Each goat page is plain HTML. Anything not yet known is marked `to add` and styled
in muted grey with a dashed underline, so gaps are obvious on the page and easy to
find in the source. Search a file for `to add` to see what's outstanding.

Photos currently load from the Shopify CDN (the same URLs the live shop uses). To
make the site fully self-contained, download them into `assets/photos/` and
replace the `https://cdn.shopify.com/...` URLs with relative paths.

## Still needed

- Buck photographs (Toby, Polaris) — placeholders in the meantime
- Milk test and linear appraisal figures
- Alpha s1 casein for everyone except Calypso
- Colour, markings and height per goat
- Kidding history and temperament notes
- Mayslee's ADGA registration number
- Grandparents for every doe except Calypso
