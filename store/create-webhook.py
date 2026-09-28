#!/usr/bin/env python3
"""
Create the store's LIVE Stripe webhook and put its signing secret in .env.

    python create-webhook.py

Needs a temporary key in store/.env:

    STRIPE_SETUP_KEY=rk_live_...     (restricted key, "Webhook Endpoints: Write")

The signing secret goes straight from Stripe's reply into .env and is never
printed, so an AI assistant can run this without ever seeing it. Afterwards
the script removes STRIPE_SETUP_KEY from .env — delete that key in the Stripe
dashboard too (Developers → API keys), since nothing needs it again.

Refuses to run if an endpoint for this URL already exists, so running it twice
cannot leave two webhooks double-processing every event.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, '.env')
URL = 'https://store.alittlehillfarm.com/api/webhook'
EVENTS = [
    'checkout.session.completed',
    'checkout.session.expired',
    'payment_intent.amount_capturable_updated',
    'payment_intent.succeeded',
    'payment_intent.canceled',
    'charge.dispute.created',
    'payment_intent.payment_failed',
]


def env_lines():
    return open(ENV, encoding='utf-8-sig').read().splitlines()


def env_value(key):
    for line in env_lines():
        if line.strip().startswith(key + '='):
            v = line.split('=', 1)[1].strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
                v = v[1:-1]
            return v
    return ''


def stripe(key, method, path, fields=None):
    data = urllib.parse.urlencode(fields or [], doseq=True).encode() if fields else None
    req = urllib.request.Request('https://api.stripe.com/v1' + path, data=data, method=method,
                                 headers={'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        msg = json.load(e).get('error', {}).get('message', str(e))
        sys.exit(f'Stripe refused: {msg}')


def main():
    key = env_value('STRIPE_SETUP_KEY')
    if not key:
        sys.exit('Add STRIPE_SETUP_KEY=rk_live_... to store/.env first (restricted key, Webhook Endpoints: Write).')
    if not (key.startswith('rk_live_') or key.startswith('sk_live_')):
        sys.exit('STRIPE_SETUP_KEY is not a live key — this script only creates the live webhook.')

    existing = stripe(key, 'GET', '/webhook_endpoints?limit=100')
    for ep in existing.get('data', []):
        if ep.get('url') == URL:
            sys.exit(f'A live webhook for {URL} already exists ({ep["id"]}, {ep.get("status")}). '
                     'Nothing created. Delete it in the dashboard first if you want a fresh one.')

    fields = [('url', URL), ('description', 'A Little Hill Farm store (worker.js apiWebhook)')]
    fields += [('enabled_events[]', e) for e in EVENTS]
    ep = stripe(key, 'POST', '/webhook_endpoints', fields)
    secret = ep.get('secret', '')
    if not secret.startswith('whsec_'):
        sys.exit(f'Created {ep.get("id")} but Stripe returned no signing secret. '
                 'Reveal it in the dashboard and put it in .env as STRIPE_WEBHOOK_SECRET.')

    out, replaced = [], False
    for line in env_lines():
        s = line.strip()
        if s.startswith('STRIPE_SETUP_KEY='):
            continue                                  # one-time key: drop it
        if s.startswith('STRIPE_WEBHOOK_SECRET='):
            out.append('STRIPE_WEBHOOK_SECRET=' + secret)
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append('STRIPE_WEBHOOK_SECRET=' + secret)
    with open(ENV, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(out) + '\n')

    print(f'Created live webhook {ep["id"]} ({ep.get("status")}) -> {URL}')
    print(f'Events: {", ".join(ep.get("enabled_events", []))}')
    print('Signing secret written to .env as STRIPE_WEBHOOK_SECRET (not shown).')
    print('STRIPE_SETUP_KEY removed from .env. Delete that key in Stripe too: Developers → API keys.')
    print('Next: python push-secrets.py')


if __name__ == '__main__':
    main()
