#!/usr/bin/env python3
"""
cleanup_private_drafts.py — Supprime les drafts créés en mode 'private'
(bug 03/07/2026 : le premier batch de 8 échantillons a été créé sans
mode='shared', invisibles côté gérant). On DELETE les 8 depuis Front,
on truncate log.csv pour repartir propre, puis on rerun create_drafts.py.
"""
import csv
import os
import sys
import time
import json
import urllib.request
import urllib.error

from config import FRONT_API_URL, front_headers


LOG_PATH = os.path.join(os.path.dirname(__file__), 'log.csv')


def delete_draft(msg_id):
    """Supprime une conversation entière (draft + conv associée)."""
    # Pour un draft api-created privé, on DELETE la conversation via son
    # id (récupérable via GET /messages/{msg_id} → related.conversation).
    url = f'{FRONT_API_URL}/messages/{msg_id}'
    req = urllib.request.Request(url, method='GET', headers=front_headers())
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return True, 'msg déjà supprimé'
        return False, f'GET msg HTTP {e.code}'
    conv_url = data.get('_links', {}).get('related', {}).get('conversation', '')
    conv_id = conv_url.rstrip('/').split('/')[-1] if conv_url else None
    if not conv_id:
        return False, 'conv_id introuvable'
    # PATCH conversation status=deleted (Front API)
    del_url = f'{FRONT_API_URL}/conversations/{conv_id}'
    req = urllib.request.Request(
        del_url, method='PATCH',
        data=json.dumps({'status': 'deleted'}).encode('utf-8'),
        headers=front_headers()
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return True, f'conv {conv_id} → deleted (HTTP {resp.status})'
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')[:200]
        return False, f'PATCH HTTP {e.code}: {body}'


def main():
    if not os.path.exists(LOG_PATH):
        print('Rien à nettoyer — log.csv absent.')
        return
    with open(LOG_PATH, encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    to_delete = [r for r in rows if r.get('status') == 'ok' and r.get('draft_id')]
    if not to_delete:
        print('Rien à supprimer.')
        return
    print(f'{len(to_delete)} drafts à supprimer côté Front...', file=sys.stderr)
    for r in to_delete:
        ok, msg = delete_draft(r['draft_id'])
        print(f'  {r["draft_id"]} ({r["store_code"]}) : {"OK" if ok else "KO"} — {msg}', file=sys.stderr)
        time.sleep(0.2)
    # Reset log.csv (garde le header)
    with open(LOG_PATH, 'w', encoding='utf-8') as f:
        f.write('order,email,store_code,lang,channel_id,draft_id,conv_id,status,error,at\n')
    print('\nlog.csv réinitialisé. Tu peux rerun create_drafts.py.', file=sys.stderr)


if __name__ == '__main__':
    main()
