#!/usr/bin/env python3
"""
Génère agents/prompt/instructions.md (gabarit unique) à partir des 10
instructions actuellement en base — ONE-SHOT, lecture seule en base.

- Texte commun = version LFC.
- Zones divergentes (scripts/agents-prompt/regions.py) :
  1. si toutes les variantes se ramènent à une même ligne avec les variables
     {{NAME_UPPER}} {{CODE}} {{PREFIX}} {{BARE}} {{OTHER_PREFIXES}} → ligne unique ;
  2. sinon bloc {% if … %} par groupe de boutiques portant le même texte
     (flag « coco » quand le groupe vaut COCO seul ou tout sauf COCO).
- Vérifie à la fin que le rendu de chaque boutique est IDENTIQUE octet pour
  octet à la base. Échec → rien n'est écrit.

Usage : python3 scripts/agents-prompt/bootstrap.py [--force]
"""
import os
import sys
from collections import OrderedDict

import psycopg2

sys.path.insert(0, os.path.dirname(__file__))
from regions import BASE, compute_regions  # noqa: E402
from render import TEMPLATE, load_stores, render, store_vars  # noqa: E402

VAR_ORDER = ['OTHER_PREFIXES', 'NAME_UPPER', 'PREFIX', 'CODE', 'BARE']
TEMPLATE_SOURCE = 'TAR'  # CODE ≠ BARE ≠ nom → substitutions non ambiguës


def variabilize(lines, code, stores):
    v = store_vars(code, stores)
    out = []
    for line in lines:
        for name in VAR_ORDER:
            val = v[name]
            if name == 'CODE':
                line = line.replace(f'({val})', '({{CODE}})').replace(f'format {val} (', 'format {{CODE}} (')
            else:
                line = line.replace(val, '{{%s}}' % name)
        out.append(line)
    return out


def condition(group, all_codes):
    g = set(group)
    if g == {'COCO'}:
        return 'coco'
    if g == set(all_codes) - {'COCO'}:
        return 'not coco'
    return 'store in ' + ','.join(sorted(g))


def main():
    if TEMPLATE.exists() and '--force' not in sys.argv:
        sys.exit(f'{TEMPLATE} existe déjà (--force pour écraser)')
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()
    cur.execute('SELECT store_code, instructions FROM agents ORDER BY store_code')
    texts = dict(cur.fetchall())
    stores = load_stores()
    assert set(texts) == set(stores), 'stores.json ≠ agents en base'
    codes = list(stores)

    base, regions = compute_regions(texts)
    out, pos = [], 0
    n_var = n_cond = 0
    for r in regions:
        out += base[pos:r['a']]
        pos = r['b']
        vers = r['versions']
        candidate = variabilize(vers[TEMPLATE_SOURCE], TEMPLATE_SOURCE, stores)
        if all(render('\n'.join(candidate), c, stores).split('\n') == vers[c] or
               (not vers[c] and not candidate) for c in codes) and candidate:
            out += candidate
            n_var += 1
            continue
        groups = OrderedDict()
        for c in codes:
            groups.setdefault(tuple(vers[c]), []).append(c)  # tuple : [] ≠ ['']
        # branche « else » = groupe le plus nombreux
        items = sorted(groups.items(), key=lambda kv: -len(kv[1]))
        default_text, default_group = items[0]
        others = items[1:]
        for i, (lines, grp) in enumerate(others):
            out.append(('{% if ' if i == 0 else '{% elif ') + condition(grp, codes) + ' %}')
            out += list(lines)
        if default_text:
            out.append('{% else %}')
            out += list(default_text)
        out.append('{% endif %}')
        n_cond += 1
    out += base[pos:]
    template = '\n'.join(out)

    bad = [c for c in codes if render(template, c, stores) != texts[c]]
    if bad:
        sys.exit(f'❌ rendu différent de la base pour : {", ".join(bad)} — rien écrit')
    TEMPLATE.parent.mkdir(parents=True, exist_ok=True)
    TEMPLATE.write_text(template, encoding='utf-8')
    print(f'✅ {TEMPLATE.relative_to(TEMPLATE.parents[2])} : {len(regions)} zones ({n_var} en variables, '
          f'{n_cond} en blocs conditionnels) — rendu identique à la base pour les {len(codes)} boutiques')


if __name__ == '__main__':
    main()
