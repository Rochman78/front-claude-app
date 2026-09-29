"""Moteur de gabarit minimal pour les instructions agents (sans dépendance).

Syntaxe (lignes de contrôle seules sur leur ligne) :
    {% if coco %}                 flag déclaré dans stores.json
    {% if not coco %}
    {% if store in HET,RED %}     liste de codes boutique
    {% elif ... %} / {% else %} / {% endif %}   (imbrication autorisée)
Variables dans le texte : {{NAME_UPPER}}, {{CODE}}, {{PREFIX}}, {{BARE}}, {{OTHER_PREFIXES}}, {{SPECIALITE}}, {{CODE_ECHANGE}}.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROMPT_DIR = ROOT / 'agents' / 'prompt'
TEMPLATE = PROMPT_DIR / 'instructions.md'
STORES = PROMPT_DIR / 'stores.json'

CTRL = re.compile(r'^\{% (if|elif|else|endif)(?: (.*?))? %\}$')
VAR = re.compile(r'\{\{([A-Z_]+)\}\}')


def load_stores():
    return json.loads(STORES.read_text(encoding='utf-8'))


def store_vars(code, stores):
    s = stores[code]
    others = sorted({o['bare'] for c, o in stores.items() if o['bare'] != s['bare']})
    return {
        'CODE': code,
        'NAME_UPPER': s['name_upper'],
        'PREFIX': s['prefix'],
        'BARE': s['bare'],
        'OTHER_PREFIXES': ', '.join(others),
        'SPECIALITE': s['specialite'],
        'CODE_ECHANGE': s['code_echange'],
    }


def eval_cond(expr, code, stores):
    expr = expr.strip()
    neg = expr.startswith('not ')
    if neg:
        expr = expr[4:].strip()
    m = re.match(r'^store in (.+)$', expr)
    if m:
        val = code in [c.strip() for c in m.group(1).split(',')]
    else:
        flags = stores[code].get('flags', {})
        if expr not in flags:
            raise ValueError(f'flag inconnu « {expr} » pour {code}')
        val = bool(flags[expr])
    return not val if neg else val


def render(template, code, stores):
    variables = store_vars(code, stores)
    out = []
    # pile : (branche active ?, une branche a déjà été prise ?, parent actif ?)
    stack = []
    active = True
    for lineno, line in enumerate(template.split('\n'), 1):
        m = CTRL.match(line)
        if m:
            kw, expr = m.group(1), m.group(2)
            if kw == 'if':
                taken = active and eval_cond(expr, code, stores)
                stack.append([taken, taken, active])
            elif kw == 'elif':
                top = stack[-1]
                taken = top[2] and not top[1] and eval_cond(expr, code, stores)
                top[0] = taken
                top[1] = top[1] or taken
            elif kw == 'else':
                top = stack[-1]
                top[0] = top[2] and not top[1]
                top[1] = True
            else:
                stack.pop()
            active = stack[-1][0] if stack else True
            continue
        if active:
            def sub(mv):
                if mv.group(1) not in variables:
                    raise ValueError(f'variable inconnue {{{{{mv.group(1)}}}}} ligne {lineno}')
                return variables[mv.group(1)]
            out.append(VAR.sub(sub, line))
    if stack:
        raise ValueError('bloc {% if %} non fermé')
    return '\n'.join(out)


def render_all():
    template = TEMPLATE.read_text(encoding='utf-8')
    stores = load_stores()
    return {code: render(template, code, stores) for code in stores}
