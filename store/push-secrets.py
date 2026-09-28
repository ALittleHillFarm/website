#!/usr/bin/env python3
"""
Check store/.env, then upload it to Cloudflare as the store's secrets.

    python push-secrets.py            check, then upload
    python push-secrets.py --check    check only

Never prints a secret. It reports each key's KIND (live or test Stripe key,
webhook secret, password length) so a person — or an AI assistant running
this for you — can confirm the file is right without seeing what is in it.

Why check first: wrangler reads .env with '#' as a comment marker, so a
password like abc#def silently uploads as "abc". And a live Stripe key paired
with a sandbox webhook secret fails every payment confirmation, quietly.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, '.env')
REQUIRED = ['ADMIN_PASSWORD', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']
OPTIONAL = ['NOTIFY_URL']


def read_env(path):
    values, problems = {}, []
    for n, raw in enumerate(open(path, encoding='utf-8-sig'), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            problems.append(f'line {n}: no "=" — not a KEY=value line')
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        if '#' in value:
            problems.append(f'{key}: contains "#" — wrangler would cut the value off there')
        if value != value.strip():
            problems.append(f'{key}: has spaces at the start or end')
        value = value.strip()
        # Matching quotes are stripped by wrangler's .env reader, as here.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        values[key] = value
    return values, problems


def describe(key, v):
    if not v:
        return 'EMPTY'
    if key == 'STRIPE_SECRET_KEY':
        kind = {'sk_live_': 'LIVE secret key', 'sk_test_': 'TEST (sandbox) secret key',
                'rk_live_': 'LIVE restricted key', 'rk_test_': 'TEST restricted key'}
        return next((k for p, k in kind.items() if v.startswith(p)), 'not a Stripe secret key (should start sk_live_)')
    if key == 'STRIPE_WEBHOOK_SECRET':
        return 'webhook signing secret' if v.startswith('whsec_') else 'not a webhook secret (should start whsec_)'
    if key == 'ADMIN_PASSWORD':
        return f'{len(v)} characters' + ('' if len(v) >= 12 else ' — use at least 12')
    if key == 'NOTIFY_URL':
        host = v.split('/')[2] if v.count('/') >= 2 else '?'
        return f'set ({host})' if v.startswith('https://') else 'should start https://'
    return 'set'


def main():
    if not os.path.exists(ENV):
        sys.exit('No store/.env file. Create it with the keys: ' + ', '.join(REQUIRED))
    values, problems = read_env(ENV)

    print('store/.env:')
    for key in REQUIRED + OPTIONAL:
        if key in values:
            print(f'  {key:22} {describe(key, values[key])}')
        elif key in REQUIRED:
            print(f'  {key:22} MISSING')
            problems.append(f'{key} is missing')
    for key in sorted(set(values) - set(REQUIRED) - set(OPTIONAL)):
        print(f'  {key:22} (extra key — it will be uploaded too)')

    for key in REQUIRED:
        d = describe(key, values.get(key, ''))
        if values.get(key) is not None and (d == 'EMPTY' or d.startswith('not ') or '—' in d):
            problems.append(f'{key}: {d}')
    if values.get('NOTIFY_URL') and not values['NOTIFY_URL'].startswith('https://'):
        problems.append('NOTIFY_URL should start https://')

    if problems:
        print('\nNot uploaded — fix these first:')
        for p in problems:
            print('  - ' + p)
        sys.exit(1)

    if describe('STRIPE_SECRET_KEY', values['STRIPE_SECRET_KEY']).startswith('LIVE'):
        print('\nLIVE Stripe key: real money. The webhook secret must come from the LIVE-mode endpoint'
              '\n(https://store.alittlehillfarm.com/api/webhook), not the sandbox one.')

    if '--check' in sys.argv:
        print('\nLooks right. Run without --check to upload.')
        return

    print('\nUploading...')
    # wrangler prints only key names. Its output is passed through unchanged.
    r = subprocess.run('npx wrangler secret bulk .env', cwd=HERE, shell=True)
    if r.returncode:
        sys.exit(r.returncode)
    print('\nDone. Secrets take a minute to reach every Cloudflare location — '
          'if a login fails right away, wait and try again.')


if __name__ == '__main__':
    main()
