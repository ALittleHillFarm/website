#!/usr/bin/env python3
"""
One-time move of the herd from goats.json into the D1 `goats` table.

    python seed/seed-goats.py > seed/goats.sql
    cd store && npx wrangler d1 execute alhf-store --remote --file=../seed/goats.sql

Done on 2026-09-27. Since then the live herd is in D1 and is edited from the
admin screen (Goats tab); goats.json and goat-registry.json are kept only as
the record of where it started. Re-running this would OVERWRITE every edit
made since, so don't — take a backup instead:

    cd store && npx wrangler d1 export alhf-store --remote --table=goats --output=../seed/goats-backup.sql
"""
import json
import os
import re
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Roster order as it stood on the Does and Bucks pages.
SORT = {'calypso': 10, 'maple-sugar': 20, 'royal-tea': 30, 'cookie': 40, 'maylsee': 50,
        'toby': 10, 'polaris': 20}

# Things that were only ever on the roster pages, not in goats.json.
EXTRA = {
    'polaris': {'badge': 'On lease from Amy York at TUA Farms', 'badge_tone': 'rust',
                'facts': [{'label': 'Breeding to 2026', 'value': 'Cookies & Cream · Calypso · Royal Tea'}]},
    'toby': {'facts': [{'label': 'Breeding to 2026', 'value': 'Maple Sugar'}]},
}


def photo(src, caption=None, alt=None):
    if not src:
        return None
    thumb = 'assets/photos/thumbs/' + os.path.basename(src)
    p = {'src': '/' + src.lstrip('/')}
    if os.path.exists(os.path.join(ROOT, thumb)):
        p['thumb'] = '/' + thumb
    if caption:
        p['caption'] = caption
    if alt:
        p['alt'] = alt
    return p


def iso(dob_text):
    try:
        return datetime.strptime(dob_text, '%B %d, %Y').strftime('%Y-%m-%d')
    except (TypeError, ValueError):
        return ''


def q(v):
    return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"


def main():
    farm = json.load(open(os.path.join(HERE, 'goats.json'), encoding='utf-8'))['goats']
    registry = json.load(open(os.path.join(HERE, 'goat-registry.json'), encoding='utf-8'))['goats']
    now = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    out = ['DELETE FROM goats;']
    for g in farm:
        ped = g.get('pedigree_named') or {}
        reg = registry.get(g['id'])
        data = {
            'name': g['name'],
            'registered_name': g.get('registered_name') or '',
            'dob': iso(g.get('dob_text')),
            'reg': g.get('reg') or '',
            'alpha_s1_casein': g.get('alpha_s1_casein') or '',
            'colour': g.get('colour') or '',
            'height': g.get('height') or '',
            'dna_on_file': bool(reg and reg.get('dna_on_file')),
            'badge': g.get('badge') or '',
            'badge_tone': '',
            'blurb': g.get('blurb') or '',
            'hero': photo(g.get('hero')),
            'gallery': [photo(p['src'], p.get('caption')) for p in g.get('gallery') or []],
            'elite': g.get('elite'),
            'pedigree': {k2: (ped.get(k1) or '') for k1, k2 in [
                ('Sire', 'sire'), ('Dam', 'dam'), ("Sire's sire", 'ss'), ("Sire's dam", 'sd'),
                ("Dam's sire", 'ds'), ("Dam's dam", 'dd')]},
            'parents': [{
                'who': p.get('who') or '', 'name': p.get('name') or '', 'credit': p.get('credit') or '',
                'lines': p.get('lines') or [],
                'photos': [photo(ph['src'], alt=ph.get('alt')) for ph in p.get('photos') or []],
            } for p in g.get('parents') or []],
            'facts': [],
            'sections': g.get('sections') or [],
            # Prompts for what to write next. Shown in the admin form, never on the site.
            'prompts': [t for s in g.get('sections_todo') or [] for t in s.get('paragraphs') or []],
        }
        data.update(EXTRA.get(g['id'], {}))
        out.append(
            'INSERT INTO goats (id, sort, status, template, data, registry, updated_at) VALUES ('
            + ', '.join([q(g['id']), str(SORT.get(g['id'], 100)), q('active'), q(g.get('template') or 'doe'),
                         q(json.dumps(data, ensure_ascii=False)),
                         q(json.dumps(reg, ensure_ascii=False)) if reg else 'NULL', q(now)])
            + ');')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
