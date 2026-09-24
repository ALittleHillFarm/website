#!/usr/bin/env python3
"""
Generate the goat pages from data.

    python build-goats.py

Two inputs:
  goats.json          farm-authored content — photos, prose, colour, height.
                      This is the file to edit.
  goat-registry.json  official ADGA / CDCB data, harvested from
                      genetics.adga.org. Treat as read-only.

Two templates, chosen by each goat's "template" field: doe and buck. Adding
"kid" later means adding one entry to TEMPLATES, not rewriting this file.

The rule throughout: a section renders only when it has real data. Nothing
prints a placeholder. If a doe has no production record, her page simply has
no production section — which is how the "to add" clutter disappears without
anyone inventing a number.
"""
import json
import os
import re
from html import escape as esc

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'goats')
STORE_URL = 'https://store.alittlehillfarm.com/'


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def commas(v):
    """1288 -> '1,288'. Leaves anything non-numeric alone."""
    try:
        return f'{int(str(v).strip()):,}'
    except (TypeError, ValueError):
        return v


def titlecase_name(n):
    """ADGA stores names shouting. 'OAK APPLE HECTOR' -> 'Oak Apple Hector'."""
    if not n:
        return n
    out = ' '.join(w.capitalize() if not re.fullmatch(r"[A-Z]{1,3}\d*|\d+\*?M|\*B|\+B", w) else w
                   for w in n.split())
    return re.sub(r"\bd'(\w)", lambda m: "D'" + m.group(1).upper(), out)


def chrome_head(title, desc):
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="icon" href="../assets/logo.png">
<link rel="stylesheet" href="../assets/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<header class="site-header" data-chrome>
  <div class="bar">
    <a class="brand" href="../index.html">
      <img src="../assets/logo.png" alt="">
      <span>
        <span class="name">A Little Hill Farm</span><br>
        <span class="sub">Potlatch, Idaho · ADGA Registered</span>
      </span>
    </a>
    <nav class="site-nav" aria-label="Main">
      <a href="../index.html">Herd</a>
      <a href="../does.html">Does</a>
      <a href="../bucks.html">Bucks</a>
      <a href="../breeding.html">2026 Kiddings</a>
      <a href="{STORE_URL}">Feed Store</a>
    </nav>
  </div>
</header>

<main id="main">
'''


CHROME_FOOT = '''</main>

<footer class="site-footer" data-chrome>
  <div class="cols">
    <div>
      <div class="mark">A Little Hill Farm</div>
      <p style="font-size:14px;line-height:1.7">ADGA registered Nigerian Dwarf dairy goats in Potlatch, Idaho.</p>
    </div>
    <div>
      <h4>The herd</h4>
      <ul>
        <li><a href="../does.html">Does</a></li>
        <li><a href="../bucks.html">Bucks</a></li>
        <li><a href="../breeding.html">2026 Kiddings</a></li>
      </ul>
    </div>
    <div>
      <h4>Elsewhere</h4>
      <ul>
        <li><a href="''' + STORE_URL + '''">Feed Store</a></li>
      </ul>
    </div>
  </div>
  <div class="fine">
    <span>&copy; A Little Hill Farm</span>
    <span>Potlatch, Idaho</span>
  </div>
</footer>
</body>
</html>
'''


# --------------------------------------------------------------------------
# sections — each returns '' when it has nothing real to show
# --------------------------------------------------------------------------

def sec_hero(g):
    badge = f'<div style="margin-bottom:22px"><span class="badge">{esc(g["badge"])}</span></div>' if g.get('badge') else ''
    blurb = f'<p class="blurb">{esc(g["blurb"])}</p>' if g.get('blurb') else ''
    shot = (f'<div class="shot"><img src="../{esc(g["hero"])}" alt="{esc(g["name"])}"></div>'
            if g.get('hero') else '')
    return f'''<section class="goat-hero">
  <div class="inner">
    <div class="txt">
      {badge}
      <p class="kind">{esc(g.get('kind') or '')}</p>
      <h1 class="serif">{esc(g['name'])}</h1>
      <p class="reg">{esc(g.get('registered_name') or '')}</p>
      {blurb}
    </div>
    {shot}
  </div>
</section>

<div class="wrap">
'''


def sec_facts(g, reg):
    """Only facts we actually hold. No empty cells, no 'to add'."""
    pairs = [
        ('Date of birth', g.get('dob_text') or (reg or {}).get('dob')),
        ('Alpha s1 casein', g.get('alpha_s1_casein')),
        ('ADGA number', g.get('reg') or (reg or {}).get('reg')),
        ('Colour & markings', g.get('colour')),
        ('Height', g.get('height')),
        ('DNA on file', (reg or {}).get('dna_on_file')),
    ]
    cells = ''.join(f'<div><div class="label">{esc(k)}</div><div class="v">{esc(str(v))}</div></div>'
                    for k, v in pairs if v)
    return f'  <section class="fact-strip">{cells}</section>\n\n' if cells else ''


def sec_gallery(g):
    # No loading="lazy" anywhere on these pages. The .shot/.stack wrappers give
    # images no intrinsic height until they decode, so a lazy image sits at 0px,
    # never intersects the viewport and never loads. Each page has under a dozen
    # photos, so eager loading costs nothing.
    if not g.get('gallery'):
        return ''
    figs = ''.join(
        f'<figure><div class="shot"><img src="../{esc(p["src"])}" alt="{esc(p.get("caption") or g["name"])}"></div>'
        f'<figcaption>{esc(p.get("caption") or "")}</figcaption></figure>'
        for p in g['gallery'])
    return f'''<div>
        <h2 class="serif" style="font-size:30px;margin-bottom:24px">Gallery</h2>
        <div class="gallery">{figs}</div>
      </div>'''


def sec_production(g, reg):
    """CDCB genetic evaluation. Labelled as what it is, not as a lactation record."""
    pe = (reg or {}).get('production_eval') or {}
    rows = [
        ('Lactations on record', pe.get('Lactations')),
        ('Average standardised milk', f"{commas(pe.get('Average STD Milk'))} lbs" if pe.get('Average STD Milk') else None),
        ('Average standardised fat', f"{commas(pe.get('Average STD Fat'))} lbs" if pe.get('Average STD Fat') else None),
        ('Average standardised protein', f"{commas(pe.get('Average STD Protein'))} lbs" if pe.get('Average STD Protein') else None),
        ('Percentile rank', pe.get('Percentile Rank')),
        ('Fluid merit', f"${pe['Fluid Merit $']}" if pe.get('Fluid Merit $') else None),
    ]
    rows = [(k, v) for k, v in rows if v not in (None, '', 'None')]

    elite = ''
    if g.get('elite'):
        e = g['elite']
        pct = f'<div class="row"><div class="pct">{e["percentile"]}<span>%</span></div><p>Elite percentile,<br>{esc(str(e.get("year") or ""))} list</p></div>' if e.get('percentile') else ''
        elite = f'<div class="top"><div class="t">{esc(e.get("title") or "")}</div><div class="y">{esc(str(e.get("year") or ""))}</div></div>{pct}'

    if not rows and not elite:
        return ''

    dl = ''
    if rows:
        dl = '<dl>' + ''.join(f'<div><dt>{esc(k)}</dt><dd>{esc(str(v))}</dd></div>' for k, v in rows) + '</dl>'

    note = ('<p style="font-size:12px;color:var(--muted);line-height:1.6;margin-top:14px">'
            'Figures are CDCB genetic evaluation averages published by ADGA, '
            'standardised across all recorded lactations — not a single lactation record.</p>') if rows else ''

    return f'''<div>
        <h2 class="serif" style="font-size:30px;margin-bottom:24px">Production</h2>
        <div class="elite">{elite}{dl}</div>
        {note}
      </div>'''


def sec_split(left, right):
    if not left and not right:
        return ''
    if left and right:
        inner = f'<div class="split">{left}{right}</div>'
    else:
        inner = left or right
    return f'  <section class="section">\n    {inner}\n  </section>\n\n'


def sec_pedigree(g, reg):
    named = g.get('pedigree_named') or {}
    gp = (reg or {}).get('grandparents') or {}
    ggp = (reg or {}).get('great_grandparents') or {}

    def blank(v):
        # Old hand-written pages used the literal text 'to add' as a value.
        # Treat any such marker as absent so the ADGA data fills in instead.
        return not v or str(v).strip().lower() in ('to add', 'tbd', '-', '—')

    def pick(label, key):
        v = named.get(label)
        return None if blank(v) and not gp.get(key) else (None if blank(v) else v) or titlecase_name(gp.get(key))

    c1 = [('Sire', named.get('Sire') or titlecase_name((reg or {}).get('sire'))),
          ('Dam', named.get('Dam') or titlecase_name((reg or {}).get('dam')))]
    c2 = [("Sire's sire", pick("Sire's sire", 'SS')), ("Sire's dam", pick("Sire's dam", 'SD')),
          ("Dam's sire", pick("Dam's sire", 'DS')), ("Dam's dam", pick("Dam's dam", 'DD'))]
    c3 = [titlecase_name(ggp.get(k)) for k in ('SSS', 'SSD', 'SDS', 'SDD', 'DSS', 'DSD', 'DDS', 'DDD')]

    if not any(v for _, v in c1):
        return ''

    def cells(items, with_label=True):
        out = ''
        for it in items:
            if with_label:
                lbl, nm = it
                if not nm:
                    continue
                out += f'<div class="cell"><div class="label">{esc(lbl)}</div><div class="n">{esc(nm)}</div></div>'
            else:
                if not it:
                    continue
                out += f'<div class="cell"><div class="n">{esc(it)}</div></div>'
        return out

    regno = g.get('reg') or (reg or {}).get('reg')
    link = (f'<p style="font-size:14px;color:var(--muted);margin:-14px 0 28px">Four generations. '
            f'<a href="https://genetics.adga.org/GoatDetail.aspx?RegNumber={esc(regno)}" target="_blank" rel="noopener">'
            f'View on ADGA Genetics &rarr;</a></p>') if regno else ''

    col3 = f'<div class="col c3">{cells(c3, False)}</div>' if any(c3) else ''
    return f'''  <section class="section">
    <h2 class="serif">Pedigree</h2>
    {link}
    <div class="ped">
      <div class="col c1">{cells(c1)}</div>
      <div class="col c2">{cells(c2)}</div>
      {col3}
    </div>
  </section>

'''


def sec_parents(g):
    if not g.get('parents'):
        return ''
    blocks = ''
    for p in g['parents']:
        lines = ''.join(f'<div>{esc(l)}</div>' for l in (p.get('lines') or []))
        credit = f'<div class="pc">{esc(p["credit"])}</div>' if p.get('credit') else ''
        # No loading="lazy" here. These sit in a flex .stack that gives them no
        # intrinsic height until they load, so a lazy image collapses to 0px,
        # never intersects the viewport, and therefore never loads at all.
        photos = ''.join(f'<img src="../{esc(ph["src"])}" alt="{esc(ph.get("alt") or "")}">'
                         for ph in (p.get('photos') or []))
        stack = f'<div class="stack">{photos}{credit}</div>' if photos or credit else ''
        blocks += f'''<div>
      <div class="who">{esc(p.get('who') or '')}</div>
      <div class="grid">
        <div>
          <h3>{esc(p.get('name') or '')}</h3>
          <div class="lines">{lines}</div>
        </div>
        {stack}
      </div>
    </div>'''
    return f'  <section class="section">\n    <h2 class="serif">Sire and dam</h2>\n    <div class="parents">{blocks}</div>\n  </section>\n\n'


def sec_extra(g):
    out = ''
    for s in (g.get('sections') or []):
        paras = ''.join(f'<p class="lede" style="margin-bottom:14px">{esc(t)}</p>' for t in s['paragraphs'])
        out += f'  <section class="section">\n    <h2 class="serif">{esc(s["title"])}</h2>\n    {paras}\n  </section>\n\n'
    return out


# --------------------------------------------------------------------------
# templates
# --------------------------------------------------------------------------

def render_doe(g, reg):
    return (sec_hero(g) + sec_facts(g, reg)
            + sec_split(sec_gallery(g), sec_production(g, reg))
            + sec_pedigree(g, reg) + sec_parents(g) + sec_extra(g) + '</div>\n')


def render_buck(g, reg):
    # Bucks carry no production record of their own; the gallery stands alone.
    return (sec_hero(g) + sec_facts(g, reg)
            + sec_split(sec_gallery(g), '')
            + sec_pedigree(g, reg) + sec_parents(g) + sec_extra(g) + '</div>\n')


TEMPLATES = {'doe': render_doe, 'buck': render_buck}


def main():
    farm = json.load(open(os.path.join(HERE, 'goats.json'), encoding='utf-8'))
    try:
        registry = json.load(open(os.path.join(HERE, 'goat-registry.json'), encoding='utf-8'))['goats']
    except FileNotFoundError:
        registry = {}

    for g in farm['goats']:
        reg = registry.get(g['id'])
        render = TEMPLATES.get(g.get('template'), render_doe)
        kind = 'buck' if g.get('template') == 'buck' else 'doe'
        html = (chrome_head(f"{g['name']} — A Little Hill Farm",
                            f"{g['name']}, ADGA registered Nigerian Dwarf {kind} at A Little Hill Farm.")
                + render(g, reg) + CHROME_FOOT)
        path = os.path.join(OUT, g['id'] + '.html')
        open(path, 'w', encoding='utf-8').write(html)
        bits = []
        if reg and (reg.get('production_eval') or {}).get('Lactations'):
            bits.append('production')
        if g.get('parents'):
            bits.append(f"{len(g['parents'])} parents")
        if g.get('gallery'):
            bits.append(f"{len(g['gallery'])} photos")
        print(f"  {g['id']:13} {g['template']:5} {len(html):6,} bytes  {', '.join(bits)}")


if __name__ == '__main__':
    main()
