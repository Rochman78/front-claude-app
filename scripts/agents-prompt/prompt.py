#!/usr/bin/env python3
"""
Source unique des instructions agents : agents/prompt/instructions.md (gabarit)
+ agents/prompt/stores.json (variables et flags par boutique).

  python3 scripts/agents-prompt/prompt.py check            # rendu vs base, boutique par boutique
  python3 scripts/agents-prompt/prompt.py diff LFC         # diff unifié rendu vs base
  python3 scripts/agents-prompt/prompt.py render LFC       # affiche le rendu
  python3 scripts/agents-prompt/prompt.py push [--stores LFC,TAR] --yes
        → backup dans backups/agents-prompt-<ts>/ puis UPDATE agents.instructions
          des seules boutiques dont le rendu diffère de la base.

Règle : on ne modifie plus agents.instructions à la main ni par patch
chercher-remplacer — on édite le gabarit, on relit `diff`, on rejoue le banc
(scripts/replay-agents/) si le changement touche le fond, puis `push`.
Les différences entre boutiques sont VOULUES quand elles sont écrites dans le
gabarit ({% if … %}) ou dans stores.json : c'est là qu'on les documente.
"""
import difflib
import json
import os
import sys
from datetime import datetime

import psycopg2

sys.path.insert(0, os.path.dirname(__file__))
from render import render_all  # noqa: E402


def db_texts(cur):
    cur.execute('SELECT id, store_code, instructions FROM agents ORDER BY store_code')
    return {code: (agent_id, text) for agent_id, code, text in cur.fetchall()}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    rendered = render_all()
    if cmd == 'render':
        print(rendered[sys.argv[2]])
        return

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()
    current = db_texts(cur)
    missing = set(rendered) ^ set(current)
    if missing:
        sys.exit(f'stores.json et table agents ne correspondent pas : {sorted(missing)}')
    changed = [c for c in rendered if rendered[c] != current[c][1]]

    if cmd == 'check':
        for c in rendered:
            if c in changed:
                d = list(difflib.unified_diff(current[c][1].split('\n'), rendered[c].split('\n'), lineterm='', n=0))
                plus = sum(1 for l in d if l.startswith('+') and not l.startswith('+++'))
                minus = sum(1 for l in d if l.startswith('-') and not l.startswith('---'))
                print(f'  {c:5} ≠ base  (+{plus} / −{minus} lignes)')
            else:
                print(f'  {c:5} = base')
        print(f'{len(changed)} boutique(s) à pousser')
    elif cmd == 'diff':
        c = sys.argv[2]
        sys.stdout.writelines(l + '\n' for l in difflib.unified_diff(
            current[c][1].split('\n'), rendered[c].split('\n'), f'base/{c}', f'gabarit/{c}', lineterm=''))
    elif cmd == 'push':
        if '--stores' in sys.argv:
            wanted = sys.argv[sys.argv.index('--stores') + 1].split(',')
            changed = [c for c in changed if c in wanted]
        if not changed:
            print('Rien à pousser')
            return
        if '--yes' not in sys.argv:
            sys.exit(f'Boutiques qui seraient mises à jour : {", ".join(changed)} — relancer avec --yes')
        ts = datetime.now().strftime('%Y%m%d-%H%M%S')
        bdir = os.path.join('backups', f'agents-prompt-{ts}')
        os.makedirs(bdir, exist_ok=True)
        with open(os.path.join(bdir, 'agents_instructions_backup.json'), 'w') as f:
            json.dump([{'id': current[c][0], 'store_code': c, 'instructions': current[c][1]} for c in changed],
                      f, ensure_ascii=False, indent=1)
        for c in changed:
            cur.execute('UPDATE agents SET instructions = %s WHERE id = %s', (rendered[c], current[c][0]))
        conn.commit()
        print(f'Backup : {bdir}\nPoussé : {", ".join(changed)}')
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
