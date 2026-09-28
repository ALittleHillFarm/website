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
import json
import os
import secrets
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, '.env')
REQUIRED = ['ADMIN_PASSWORD', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']
OPTIONAL = ['SESSION_SECRET', 'RESEND_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NOTIFY_URL']


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
    if key == 'SESSION_SECRET':
        return f'{len(v)} characters' + ('' if len(v) >= 32 else ' — too short, delete the line to regenerate')
    if key == 'RESEND_API_KEY':
        return 'Resend API key' if v.startswith('re_') else 'not a Resend key (should start re_)'
    if key == 'GOOGLE_CLIENT_ID':
        return 'Google OAuth client ID' if v.endswith('.apps.googleusercontent.com') else 'should end .apps.googleusercontent.com'
    if key == 'GOOGLE_CLIENT_SECRET':
        return 'Google OAuth client secret' if v.startswith('GOCSPX-') else 'set (unusual format — check it)'
    if key == 'NOTIFY_URL':
        host = v.split('/')[2] if v.count('/') >= 2 else '?'
        return f'set ({host})' if v.startswith('https://') else 'should start https://'
    return 'set'


def main():
    if not os.path.exists(ENV):
        sys.exit('No store/.env file. Create it with the keys: ' + ', '.join(REQUIRED))
    values, problems = read_env(ENV)

    # Customer sign-in cookies are signed with SESSION_SECRET. Nobody needs to
    # know it, so make one if it is missing — written to .env, never shown.
    if 'SESSION_SECRET' not in values:
        ends_clean = open(ENV, encoding='utf-8').read().endswith(chr(10))
        with open(ENV, 'a', encoding='utf-8') as f:
            f.write(('' if ends_clean else chr(10)) + 'SESSION_SECRET=' + secrets.token_urlsafe(48) + chr(10))
        print('Generated SESSION_SECRET in .env (not shown).')
        values, problems = read_env(ENV)

    print('store/.env:')
    for key in REQUIRED + OPTIONAL:
        if key in values:
            print(f'  {key:22} {describe(key, values[key])}')
        elif key in REQUIRED:
            print(f'  {key:22} MISSING')
            problems.append(f'{key} is missing')
    for key in sorted(set(values) - set(REQUIRED) - set(OPTIONAL)):
        print(f'  {key:22} (setup-only — stays in .env, never uploaded)')

    for key in REQUIRED:
        d = describe(key, values.get(key, ''))
        if values.get(key) is not None and (d == 'EMPTY' or d.startswith('not ') or '—' in d):
            problems.append(f'{key}: {d}')
    if values.get('NOTIFY_URL') and not values['NOTIFY_URL'].startswith('https://'):
        problems.append('NOTIFY_URL should start https://')
    for key in ('SESSION_SECRET', 'RESEND_API_KEY', 'GOOGLE_CLIENT_ID'):
        d = describe(key, values.get(key, ''))
        if key in values and (d == 'EMPTY' or d.startswith('not ') or d.startswith('should ') or '—' in d):
            problems.append(f'{key}: {d}')
    if bool(values.get('GOOGLE_CLIENT_ID')) != bool(values.get('GOOGLE_CLIENT_SECRET')):
        problems.append('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together — set both or neither')

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
    # Only the keys the store uses. Setup-only keys in .env (a DNS token, an
    # admin-level API key) must never reach the live worker, so the upload is
    # built from an allow-list. The temporary file matches .gitignore's
    # ".env.*" and is deleted straight after. wrangler prints key names only.
    # --without KEY holds one back, e.g. an email key whose domain isn't verified yet.
    held = [sys.argv[i + 1] for i, a in enumerate(sys.argv[:-1]) if a == '--without']
    upload = {k: values[k] for k in REQUIRED + OPTIONAL if values.get(k) and k not in held}
    for k in held:
        print(f'  holding back {k} (not uploaded this time)')
    tmp = os.path.join(HERE, '.env.upload.json')
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(upload, f)
        r = subprocess.run('npx wrangler secret bulk .env.upload.json', cwd=HERE, shell=True)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    if r.returncode:
        sys.exit(r.returncode)
    print('\nDone. Secrets take a minute to reach every Cloudflare location — '
          'if a login fails right away, wait and try again.')


if __name__ == '__main__':
    main()
