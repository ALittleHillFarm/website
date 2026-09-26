#!/usr/bin/env python3
"""
The site's shared navigation and footer, defined once.

    python chrome.py

Rewrites the <nav class="site-nav"> and <footer class="site-footer"> of every
hand-written page in this folder. build-goats.py imports the same functions
for the generated goat pages, and build-site.sh runs this before deploying,
so a menu change is made here and nowhere else.
"""
import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
STORE_URL = 'https://store.alittlehillfarm.com/'
EMAIL = 'christine@alittlehillfarm.com'
PHONE = '208-875-9563'

# (label, page). Pages are relative to the site root; external URLs are left alone.
NAV = [
    ('Herd', 'index.html'),
    ('Does', 'does.html'),
    ('Bucks', 'bucks.html'),
    ('2026 Kiddings', 'breeding.html'),
    ('Goat Guide', 'guide.html'),
    ('About', 'about.html'),
    ('Feed Store', STORE_URL),
]


def _href(page, prefix):
    return page if page.startswith('http') else prefix + page


def nav(current=None, prefix=''):
    """current: the page filename to mark with aria-current, e.g. 'does.html'."""
    links = '\n'.join(
        f'      <a href="{_href(page, prefix)}"'
        + (' aria-current="page"' if page == current else '')
        + f'>{label}</a>'
        for label, page in NAV)
    return f'<nav class="site-nav" aria-label="Main">\n{links}\n    </nav>'


def footer(prefix=''):
    p = prefix
    tel = '+1' + PHONE.replace('-', '')
    return f'''<footer class="site-footer" data-chrome>
  <div class="cols">
    <div>
      <div class="mark">A Little Hill Farm</div>
      <p style="font-size:14px;line-height:1.7">ADGA registered Nigerian Dwarf dairy goats and organic feed in Potlatch, Idaho.</p>
    </div>
    <div>
      <h4>The herd</h4>
      <ul>
        <li><a href="{p}does.html">Does</a></li>
        <li><a href="{p}bucks.html">Bucks</a></li>
        <li><a href="{p}breeding.html">2026 Kiddings</a></li>
      </ul>
    </div>
    <div>
      <h4>The farm</h4>
      <ul>
        <li><a href="{p}about.html">About us</a></li>
        <li><a href="{p}guide.html">Goat guide</a></li>
        <li><a href="{STORE_URL}">Feed Store</a></li>
      </ul>
    </div>
    <div>
      <h4>Get in touch</h4>
      <ul>
        <li><a href="mailto:{EMAIL}">{EMAIL}</a></li>
        <li><a href="tel:{tel}">{PHONE}</a></li>
        <li><a href="https://genetics.adga.org">ADGA Genetics</a></li>
      </ul>
    </div>
  </div>
  <div class="fine">
    <span>&copy; A Little Hill Farm</span>
    <span>Potlatch, Idaho</span>
  </div>
</footer>'''


NAV_RE = re.compile(r'<nav class="site-nav" aria-label="Main">.*?</nav>', re.S)
FOOT_RE = re.compile(r'<footer class="site-footer" data-chrome>.*?</footer>', re.S)


def main():
    for path in sorted(glob.glob(os.path.join(HERE, '*.html'))):
        name = os.path.basename(path)
        html = open(path, encoding='utf-8').read()
        # 404.html is served at whatever path was missing (/goats/x, /pages/y),
        # so its links must be root-relative or they resolve under that path.
        prefix = '/' if name == '404.html' else ''
        out = NAV_RE.sub(lambda _: nav(name, prefix), html, count=1)
        out = FOOT_RE.sub(lambda _: footer(prefix), out, count=1)
        if out != html:
            open(path, 'w', encoding='utf-8', newline='\n').write(out)
            print(f'  chrome  {name}')


if __name__ == '__main__':
    main()
