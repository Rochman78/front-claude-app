#!/usr/bin/env python3
"""
send_drafts.py — Script B du batch "doublon expédition"

Pour chaque draft loggué dans log.csv (par create_drafts.py) :
  1. GET /drafts/{draft_id} — si 404, le gérant l'a SUPPRIMÉ → skip
     (= "je ne veux PAS envoyer ce mail")
  2. Sinon on lit le contenu ACTUEL (le gérant a pu l'éditer dans Front)
  3. POST /channels/{ch}/messages avec ce contenu → envoi direct
  4. DELETE /drafts/{draft_id} — cleanup de la duplication

Convention Charles 03/07/2026 : le gérant revoit tous les drafts dans
Front. Ceux qu'il ne veut PAS envoyer, il les supprime avec le bouton
delete de Front. Ce script envoie tout ce qui reste.

Usage :
  python3 scripts/batch-mail/send_drafts.py [--limit N] [--dry-run]
"""
import csv
import os
import sys
import time
import json
import argparse
import urllib.request
import urllib.error

from config import FRONT_API_URL, front_headers


LOG_PATH = os.path.join(os.path.dirname(__file__), 'log.csv')
SEND_LOG_PATH = os.path.join(os.path.dirname(__file__), 'send_log.csv')
SEND_FIELDS = ['order', 'email', 'store_code', 'channel_id', 'draft_id', 'conv_id_original', 'sent_conv_id', 'status', 'error', 'at']


def load_send_log():
    """Set des drafts_id déjà envoyés OU explicitement skippés."""
    done = set()
    if not os.path.exists(SEND_LOG_PATH):
        return done
    with open(SEND_LOG_PATH, encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if row.get('status') in ('sent', 'skip-deleted'):
                done.add(row['draft_id'])
    return done


def append_send_log(entry):
    exists = os.path.exists(SEND_LOG_PATH)
    with open(SEND_LOG_PATH, 'a', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=SEND_FIELDS)
        if not exists:
            w.writeheader()
        w.writerow(entry)


def front_request(method, path, payload=None, max_retries=3):
    url = f'{FRONT_API_URL}{path}'
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    delay = 1.0
    for attempt in range(max_retries + 1):
        req = urllib.request.Request(url, data=data, method=method, headers=front_headers())
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode('utf-8')
                return resp.status, json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')
            if e.code == 404:
                return 404, {}
            if e.code in (429, 500, 502, 503, 504) and attempt < max_retries:
                print(f'    HTTP {e.code} → retry dans {delay:.1f}s', file=sys.stderr)
                time.sleep(delay)
                delay *= 2
                continue
            return e.code, {'error': body[:500]}
        except Exception as e:
            if attempt < max_retries:
                time.sleep(delay); delay *= 2
                continue
            return 0, {'error': str(e)}


def send_one(row):
    draft_id = row['draft_id']
    channel_id = row['channel_id']
    if not draft_id or not channel_id:
        return {'status': 'error', 'error': 'draft_id ou channel_id manquant dans log.csv'}

    # 1. GET du draft — 404 = supprimé par le gérant = "ne pas envoyer"
    status, draft = front_request('GET', f'/drafts/{draft_id}')
    if status == 404:
        return {'status': 'skip-deleted', 'error': 'draft supprimé côté Front (gérant a rejeté)'}
    if status not in (200, 201):
        return {'status': 'error', 'error': f'GET draft HTTP {status}: {json.dumps(draft)[:200]}'}

    # 2. Extraire le contenu ACTUEL (gérant a pu éditer)
    recipients = draft.get('recipients', [])
    to = [r['handle'] for r in recipients if r.get('role') == 'to']
    subject = draft.get('subject', '')
    body = draft.get('body', '')
    if not to or not body:
        return {'status': 'error', 'error': 'draft sans to/body — inattendu'}

    # 3. POST /channels/{ch}/messages — envoi direct
    payload = {
        'to': to,
        'subject': subject,
        'body': body,
        'options': {'archive': False, 'tags': []},
    }
    status, sent = front_request('POST', f'/channels/{channel_id}/messages', payload)
    if status not in (200, 201, 202):
        return {'status': 'error', 'error': f'POST messages HTTP {status}: {json.dumps(sent)[:200]}'}
    sent_conv_id = ''
    links = sent.get('_links', {}).get('related', {})
    if 'conversation' in links:
        sent_conv_id = links['conversation'].rstrip('/').split('/')[-1]

    # 4. DELETE du draft d'origine (cleanup)
    front_request('DELETE', f'/drafts/{draft_id}')

    return {'status': 'sent', 'sent_conv_id': sent_conv_id}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=None)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    if not os.path.exists(LOG_PATH):
        print(f'log.csv introuvable : {LOG_PATH}. Lance create_drafts.py d\'abord.', file=sys.stderr)
        sys.exit(1)

    already = load_send_log()
    print(f'{len(already)} drafts déjà traités (send_log.csv) — seront skippés.', file=sys.stderr)

    with open(LOG_PATH, encoding='utf-8') as f:
        rows = [r for r in csv.DictReader(f) if r.get('status') == 'ok' and r.get('draft_id')]

    total, sent, deleted, errors = 0, 0, 0, 0
    for row in rows:
        total += 1
        if args.limit and total > args.limit:
            break
        if row['draft_id'] in already:
            print(f'  [{total}] SKIP (déjà traité) {row["order"]} {row["email"]}', file=sys.stderr)
            continue
        print(f'  [{total}] {row["order"]} → {row["email"]}...', end=' ', file=sys.stderr, flush=True)
        if args.dry_run:
            print(f'[DRY] draft={row["draft_id"]} channel={row["channel_id"]}', file=sys.stderr)
            continue
        res = send_one(row)
        entry = {
            'order': row['order'], 'email': row['email'],
            'store_code': row.get('store_code', ''),
            'channel_id': row['channel_id'],
            'draft_id': row['draft_id'],
            'conv_id_original': row.get('conv_id', ''),
            'sent_conv_id': res.get('sent_conv_id', ''),
            'status': res['status'],
            'error': res.get('error', ''),
            'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        }
        append_send_log(entry)
        if res['status'] == 'sent':
            sent += 1
            print(f"SENT conv={res.get('sent_conv_id', '?')}", file=sys.stderr)
        elif res['status'] == 'skip-deleted':
            deleted += 1
            print('SKIP (draft supprimé)', file=sys.stderr)
        else:
            errors += 1
            print(f"ERR {res.get('error', '')}", file=sys.stderr)
        time.sleep(0.2)

    print(f'\nTerminé — total={total} sent={sent} skip-deleted={deleted} errors={errors}', file=sys.stderr)
    print(f'Log : {SEND_LOG_PATH}', file=sys.stderr)


if __name__ == '__main__':
    main()
