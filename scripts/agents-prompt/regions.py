"""Alignement multi-boutiques des instructions sur LFC → régions divergentes.

Chaque région est une plage de lignes LFC [a, b) (éventuellement vide = insertion)
avec, pour chaque boutique, le texte qu'elle y porte. Les plages se chevauchant
ou se touchant entre boutiques sont fusionnées, pour que chaque boutique ait une
version bien définie de chaque région.
"""
import difflib

BASE = 'LFC'


def compute_regions(texts):
    base = texts[BASE].split('\n')
    store_ops = {}
    ranges = []
    for s, t in texts.items():
        if s == BASE:
            continue
        lines = t.split('\n')
        ops = [o for o in difflib.SequenceMatcher(None, base, lines, autojunk=False).get_opcodes()]
        store_ops[s] = (lines, ops)
        ranges += [(o[1], o[2]) for o in ops if o[0] != 'equal']
    ranges.sort()
    merged = []
    for a, b in ranges:
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])

    def version(s, a, b):
        """Texte de la boutique s pour la plage LFC [a, b)."""
        if s == BASE:
            return base[a:b]
        lines, ops = store_ops[s]
        out = []
        for tag, i1, i2, j1, j2 in ops:
            if tag == 'equal':
                lo, hi = max(i1, a), min(i2, b)
                if lo < hi:
                    out += lines[j1 + (lo - i1): j1 + (hi - i1)]
            else:
                # hunk entièrement inclus dans la région (garanti par la fusion
                # des plages qui se touchent) ; une insertion (i1 == i2) y est
                # rattachée si elle tombe dans [a, b]
                if a <= i1 and i2 <= b:
                    out += lines[j1:j2]
        return out

    regions = []
    for a, b in merged:
        regions.append({'a': a, 'b': b, 'versions': {s: version(s, a, b) for s in texts}})
    return base, regions
