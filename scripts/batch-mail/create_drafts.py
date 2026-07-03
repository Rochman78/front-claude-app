#!/usr/bin/env python3
"""
create_drafts.py — Script A du batch "doublon expédition"

Crée un brouillon Front pour chaque ligne du fichier Excel :
  - Résout store + langue depuis le préfixe (LFC/HC/RDC/TZ/...)
  - Substitue [ORDER] dans le sujet et le corps du template traduit
  - POST /channels/{ch}/drafts vers Front — crée une NOUVELLE conv
  - Log chaque résultat dans log.csv (input pour send_drafts.py)

Usage :
  python3 scripts/batch-mail/create_drafts.py [--limit N] [--dry-run]

Idempotent : ne recrée pas les drafts déjà loggés dans log.csv (match par
email+order). Rate-limité à 200 ms entre chaque call Front (≈ 5 req/s).
Retries sur 429 / 5xx avec backoff exponentiel.
"""
import csv
import os
import sys
import time
import json
import argparse
import urllib.request
import urllib.error

from config import (
    FRONT_API_URL, front_headers,
    PREFIX_TO_STORE, load_translations,
    excel_rows, parse_prefix, text_to_html,
)


LOG_PATH = os.path.join(os.path.dirname(__file__), 'log.csv')
LOG_FIELDS = ['order', 'email', 'store_code', 'lang', 'channel_id', 'draft_id', 'conv_id', 'status', 'error', 'at']


def load_existing_log():
    """Set des (email, order) déjà traités avec succès (draft_id présent)."""
    done = set()
    if not os.path.exists(LOG_PATH):
        return done
    with open(LOG_PATH, encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if row.get('draft_id') and row.get('status') == 'ok':
                done.add((row['email'].lower(), row['order']))
    return done


def append_log(entry):
    exists = os.path.exists(LOG_PATH)
    with open(LOG_PATH, 'a', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=LOG_FIELDS)
        if not exists:
            w.writeheader()
        w.writerow(entry)


def front_post(path, payload, max_retries=3):
    """POST vers Front API avec retry sur 429 / 5xx. Retourne (status, json)."""
    url = f'{FRONT_API_URL}{path}'
    data = json.dumps(payload).encode('utf-8')
    delay = 1.0
    for attempt in range(max_retries + 1):
        req = urllib.request.Request(url, data=data, method='POST', headers=front_headers())
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode('utf-8')
                return resp.status, json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')
            # Retry sur rate-limit et server errors
            if e.code in (429, 500, 502, 503, 504) and attempt < max_retries:
                print(f'    HTTP {e.code} → retry dans {delay:.1f}s ({attempt+1}/{max_retries})', file=sys.stderr)
                time.sleep(delay)
                delay *= 2
                continue
            return e.code, {'error': body[:500]}
        except Exception as e:
            if attempt < max_retries:
                print(f'    Erreur réseau ({e}) → retry dans {delay:.1f}s', file=sys.stderr)
                time.sleep(delay)
                delay *= 2
                continue
            return 0, {'error': str(e)}


def create_one_draft(order, email, translations):
    prefix = parse_prefix(order)
    if not prefix or prefix not in PREFIX_TO_STORE:
        return {'status': 'skip', 'error': f'préfixe {prefix} non mappé'}
    store = PREFIX_TO_STORE[prefix]
    lang = store['lang']
    tpl = translations.get(lang)
    if not tpl:
        return {'status': 'skip', 'error': f'traduction {lang} manquante'}

    subject = tpl['subject'].replace('[ORDER]', order)
    body_txt = tpl['body'].replace('[ORDER]', order)
    body_html = text_to_html(body_txt)

    payload = {
        'to': [email],
        'subject': subject,
        'body': body_html,
        # signature par défaut du canal (auto-attachée par Front)
        'should_add_default_signature': True,
    }
    status, data = front_post(f"/channels/{store['channel_id']}/drafts", payload)
    if status not in (200, 201, 202):
        return {'status': 'error', 'error': f'HTTP {status}: {json.dumps(data)[:300]}',
                'store_code': store['store_code'], 'lang': lang, 'channel_id': store['channel_id']}

    draft_id = data.get('id') or ''
    # conv_id : Front retourne _links.related.conversation ou similar
    conv_id = ''
    links = data.get('_links', {}).get('related', {})
    if 'conversation' in links:
        # URL type https://.../conversations/cnv_xxx
        conv_id = links['conversation'].rstrip('/').split('/')[-1]

    return {
        'status': 'ok', 'draft_id': draft_id, 'conv_id': conv_id,
        'store_code': store['store_code'], 'lang': lang, 'channel_id': store['channel_id'],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=None, help='Limite N lignes (test)')
    parser.add_argument('--dry-run', action='store_true', help='N\'écrit rien dans Front, affiche seulement')
    args = parser.parse_args()

    translations = load_translations()
    done = load_existing_log()
    print(f'{len(done)} drafts déjà créés (log.csv) — seront skippés.', file=sys.stderr)

    total, ok, skipped, errors = 0, 0, 0, 0
    for order, email in excel_rows():
        total += 1
        if args.limit and total > args.limit:
            break
        key = (email.lower(), order)
        if key in done:
            skipped += 1
            print(f'  [{total}] SKIP (déjà fait) {order} {email}', file=sys.stderr)
            continue
        print(f'  [{total}] {order} → {email}...', end=' ', file=sys.stderr, flush=True)
        if args.dry_run:
            prefix = parse_prefix(order)
            store = PREFIX_TO_STORE.get(prefix, {})
            print(f"[DRY] store={store.get('store_code')} lang={store.get('lang')}", file=sys.stderr)
            continue
        res = create_one_draft(order, email, translations)
        entry = {
            'order': order, 'email': email,
            'store_code': res.get('store_code', ''),
            'lang': res.get('lang', ''),
            'channel_id': res.get('channel_id', ''),
            'draft_id': res.get('draft_id', ''),
            'conv_id': res.get('conv_id', ''),
            'status': res.get('status', 'error'),
            'error': res.get('error', ''),
            'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        }
        append_log(entry)
        if res['status'] == 'ok':
            ok += 1
            print(f"OK draft={res['draft_id']}", file=sys.stderr)
        elif res['status'] == 'skip':
            skipped += 1
            print(f"SKIP {res['error']}", file=sys.stderr)
        else:
            errors += 1
            print(f"ERR {res['error']}", file=sys.stderr)
        # Rate-limit doux vs Front API (~5 req/s max)
        time.sleep(0.2)

    print(f'\nTerminé — total={total} ok={ok} skipped={skipped} errors={errors}', file=sys.stderr)
    print(f'Log : {LOG_PATH}', file=sys.stderr)


if __name__ == '__main__':
    main()
