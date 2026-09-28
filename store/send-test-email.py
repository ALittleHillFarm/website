#!/usr/bin/env python3
"""
Send a test email through Resend, exactly as the store sends mail.

    python send-test-email.py someone@example.com [another@example.com ...]

Uses RESEND_API_KEY and the sender in config.json (email.from / reply_to),
so a message that arrives proves the key, the domain's DNS and the sender
address all work. Keys are read from .env and never printed.
"""
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def env_value(key):
    for line in open(os.path.join(HERE, '.env'), encoding='utf-8-sig'):
        s = line.strip()
        if s.startswith(key + '='):
            v = s.split('=', 1)[1].strip()
            return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'' else v
    return ''


def main():
    to = sys.argv[1:]
    if not to:
        sys.exit(__doc__)
    key = env_value('RESEND_API_KEY')
    if not key:
        sys.exit('RESEND_API_KEY is not in store/.env')
    email = json.load(open(os.path.join(HERE, 'config.json'), encoding='utf-8'))['email']
    for addr in to:
        body = {
            'from': email['from'],
            'reply_to': email['reply_to'],
            'to': [addr],
            'subject': 'Test email from the A Little Hill Farm store',
            'text': 'This is a test from the store at store.alittlehillfarm.com.\n\n'
                    'If it reached your inbox (not spam), sign-in codes and order confirmations will too.\n'
                    'Replies go to ' + email['reply_to'] + '.',
            'html': '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#4A443A">'
                    '<p style="font-family:Georgia,serif;font-size:20px;color:#1E1B16">A Little Hill Farm</p>'
                    '<p>This is a test from the store at store.alittlehillfarm.com.</p>'
                    '<p>If it reached your inbox (not spam), sign-in codes and order confirmations will too.</p>'
                    '<p style="color:#6B6353;font-size:13px">Replies go to ' + email['reply_to'] + '.</p></div>',
        }
        req = urllib.request.Request('https://api.resend.com/emails', data=json.dumps(body).encode(), method='POST',
                                     headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
                                              'User-Agent': 'alhf-setup'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                print(f'sent to {addr}: id {json.load(r).get("id")}')
        except urllib.error.HTTPError as e:
            print(f'FAILED for {addr}: HTTP {e.code} {e.read().decode()[:200]}')


if __name__ == '__main__':
    main()
