#!/usr/bin/env python3
"""
Set up mail.alittlehillfarm.com as the store's sending domain in Resend,
and create the DNS records Resend asks for in Cloudflare.

    python setup-email-dns.py            add domain, create DNS records, verify
    python setup-email-dns.py --status   just report Resend's verification status
    python setup-email-dns.py --cleanup  remove the two setup keys from .env

Needs two TEMPORARY keys in store/.env (never uploaded by push-secrets.py):

    RESEND_SETUP_KEY=re_...        Resend API key with FULL access
    CLOUDFLARE_DNS_TOKEN=...       Cloudflare API token: "Edit zone DNS",
                                   limited to the alittlehillfarm.com zone

Safety: it only ever creates records under mail.alittlehillfarm.com, so the
root domain's mail (Proton: MX, SPF, DKIM, DMARC) cannot be touched, and it
never changes or deletes an existing record. Keys are read from .env and
never printed.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, '.env')
ROOT = 'alittlehillfarm.com'
DOMAIN = 'mail.' + ROOT
SETUP_KEYS = ('RESEND_SETUP_KEY', 'CLOUDFLARE_DNS_TOKEN')


def env_value(key):
    for line in open(ENV, encoding='utf-8-sig'):
        s = line.strip()
        if s.startswith(key + '='):
            v = s.split('=', 1)[1].strip()
            return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'' else v
    return ''


def call(method, url, token, body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                                          'User-Agent': 'alhf-setup'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f'{method} {url.split("?")[0]} failed: HTTP {e.code} {e.read().decode()[:300]}')


def resend(method, path, body=None):
    return call(method, 'https://api.resend.com' + path, env_value('RESEND_SETUP_KEY'), body)


def cf(method, path, body=None):
    r = call(method, 'https://api.cloudflare.com/client/v4' + path, env_value('CLOUDFLARE_DNS_TOKEN'), body)
    if not r.get('success'):
        sys.exit(f'Cloudflare refused: {r.get("errors")}')
    return r['result']


def find_domain():
    for d in resend('GET', '/domains').get('data', []):
        if d.get('name') == DOMAIN:
            return resend('GET', '/domains/' + d['id'])
    return None


def fqdn(name):
    name = (name or '').rstrip('.')
    if name in ('', '@'):
        return DOMAIN
    if name.endswith(ROOT):
        return name
    # Resend gives names relative to the domain it was asked to verify.
    return name + '.' + DOMAIN if not name.endswith(DOMAIN) else name


def report(dom):
    print(f'{DOMAIN}: {dom.get("status")}')
    for r in dom.get('records', []):
        print(f'  {r.get("record"):6} {r.get("type"):4} {fqdn(r.get("name"))} -> {r.get("status")}')


def main():
    if '--cleanup' in sys.argv:
        lines = [l for l in open(ENV, encoding='utf-8-sig').read().splitlines()
                 if not l.strip().startswith(tuple(k + '=' for k in SETUP_KEYS))]
        open(ENV, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines) + '\n')
        print('Removed ' + ' and '.join(SETUP_KEYS) + ' from .env. Delete them in Resend and Cloudflare too.')
        return

    missing = [k for k in SETUP_KEYS if not env_value(k)]
    if missing:
        sys.exit('Add to store/.env first: ' + ', '.join(missing))

    if '--status' in sys.argv:
        dom = find_domain()
        report(dom) if dom else print(DOMAIN + ' is not in Resend yet.')
        return

    dom = find_domain()
    if dom:
        print(f'{DOMAIN} is already in Resend ({dom.get("status")}).')
    else:
        created = resend('POST', '/domains', {'name': DOMAIN, 'region': 'us-east-1'})
        dom = resend('GET', '/domains/' + created['id'])
        print(f'Added {DOMAIN} to Resend.')

    zones = cf('GET', '/zones?name=' + ROOT)
    if not zones:
        sys.exit(f'The Cloudflare token cannot see the {ROOT} zone.')
    zone = zones[0]['id']

    for r in dom.get('records', []):
        name = fqdn(r.get('name'))
        rtype = r.get('type')
        value = r.get('value', '')
        if not (name == DOMAIN or name.endswith('.' + DOMAIN)):
            print(f'  SKIPPED {rtype} {name}: outside {DOMAIN}, left for a person to review')
            continue
        existing = cf('GET', f'/zones/{zone}/dns_records?type={rtype}&name={name}')
        if any(e.get('content', '').strip('"') == value.strip('"') for e in existing):
            print(f'  exists   {rtype:4} {name}')
            continue
        if existing and rtype != 'TXT':
            print(f'  SKIPPED  {rtype:4} {name}: a different record is already there — not overwriting')
            continue
        rec = {'type': rtype, 'name': name, 'content': value, 'ttl': 1, 'proxied': False,
               'comment': 'Resend: store email (setup-email-dns.py)'}
        if rtype == 'MX':
            rec['priority'] = int(r.get('priority') or 10)
        cf('POST', f'/zones/{zone}/dns_records', rec)
        print(f'  created  {rtype:4} {name}')

    resend('POST', f'/domains/{dom["id"]}/verify')
    print('Asked Resend to verify. Checking for up to 3 minutes...')
    for _ in range(18):
        time.sleep(10)
        dom = resend('GET', '/domains/' + dom['id'])
        if dom.get('status') == 'verified':
            break
    report(dom)
    if dom.get('status') != 'verified':
        print('Not verified yet — DNS can take a while. Re-check with: python setup-email-dns.py --status')


if __name__ == '__main__':
    main()
