"""
Config partagée par create_drafts.py + send_drafts.py :
- Mapping préfixe commande → store_code + langue + channel_id Front
- Chargement des traductions FR/DE/NL/ES/IT depuis translations.json
- Chargement de la clé Front API depuis .env
"""
import os
import json

# ─── Front API ─────────────────────────────────────────────────────────────

FRONT_API_URL = 'https://api2.frontapp.com'


def load_env(key):
    """Récupère une variable depuis .env à la racine du repo."""
    env_path = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
    with open(env_path) as f:
        for line in f:
            if line.startswith(f'{key}='):
                return line.split('=', 1)[1].strip()
    raise RuntimeError(f'{key} manquant dans .env')


def front_headers():
    return {
        'Authorization': f"Bearer {load_env('FRONT_API_TOKEN')}",
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }


# ─── Mapping préfixe commande → store ──────────────────────────────────────
# Découvert depuis le fichier DOUBLON OCTOPIA (03/07/2026) :
#   LFC 78, COCO 19, HC 17, RDC 12, TZ 11, LVO 4, RM 1, UC 1
# HC/RDC/TZ/RM/UC sont des abréviations du n° de commande (pas les
# store codes officiels utilisés en BDD agents).
PREFIX_TO_STORE = {
    'LFC':  {'store_code': 'LFC',  'lang': 'fr', 'channel_id': 'cha_is95j', 'email': 'serviceclient@le-filet-de-camouflage.fr'},
    'COCO': {'store_code': 'COCO', 'lang': 'fr', 'channel_id': 'cha_is993', 'email': 'contact@ma-toile-coco.fr'},
    'LVO':  {'store_code': 'LVO',  'lang': 'fr', 'channel_id': 'cha_is9hz', 'email': 'serviceclient@le-voile-ombrage.fr'},
    'UC':   {'store_code': 'UNI',  'lang': 'fr', 'channel_id': 'cha_is9jr', 'email': 'support@univers-camouflage.com'},
    'HC':   {'store_code': 'HET',  'lang': 'nl', 'channel_id': 'cha_is9g7', 'email': 'contact@het-camouflagenet.nl'},
    'RDC':  {'store_code': 'RED',  'lang': 'es', 'channel_id': 'cha_is9cn', 'email': 'contacto@red-de-camuflaje.com'},
    'TZ':   {'store_code': 'TAR',  'lang': 'de', 'channel_id': 'cha_is9ef', 'email': 'kontakt@tarnnetz.com'},
    'RM':   {'store_code': 'RETE', 'lang': 'it', 'channel_id': 'cha_j4ihj', 'email': 'contatto@rete-mimetica.it'},
    # Non présents dans le fichier actuel mais mappés au cas où :
    'MON':  {'store_code': 'MON',  'lang': 'fr', 'channel_id': 'cha_jaa6v', 'email': 'bonjour@mon-ombrage.fr'},
    'RDD':  {'store_code': 'REDE', 'lang': 'pt', 'channel_id': 'cha_mw1nb', 'email': 'contacto@rede-camuflagem.pt'},
}


# ─── Templates traduits (chargés depuis translations.json) ─────────────────

def load_translations():
    """Charge les templates traduits générés par translate_once.py.
    Chaque entrée : {'subject': str, 'body': str}. Placeholder [ORDER]
    à substituer avec le n° de commande client."""
    path = os.path.join(os.path.dirname(__file__), 'translations.json')
    with open(path, encoding='utf-8') as f:
        return json.load(f)


# ─── I/O helpers ───────────────────────────────────────────────────────────

def excel_rows():
    """Itère les lignes (order, email) du fichier DOUBLON OCTOPIA."""
    import openpyxl
    xlsx_path = '/Users/charlesbamy/Downloads/DOUBLON OCTOPIA - avec emails.xlsx'
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    ws = wb['Feuil1']
    rows = list(ws.iter_rows(values_only=True))[1:]  # skip header
    for r in rows:
        if not r or not r[0] or not r[1]:
            continue
        yield str(r[0]).strip(), str(r[1]).strip()


def parse_prefix(order):
    """Extrait le préfixe alphabétique (LFC, HC, RDC…) du n° de commande."""
    import re
    m = re.match(r'^#?([A-Z]+)', order)
    return m.group(1) if m else None


def text_to_html(text):
    """Convertit un mail texte brut en HTML pour Front. Paragraphes séparés
    par double retour ligne + <br> pour les sauts simples à l'intérieur."""
    import re
    def escape(s):
        return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    paragraphs = re.split(r'\n\s*\n', text)
    html_parts = []
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        lines = p.split('\n')
        html_parts.append('<p>' + '<br>'.join(escape(l.rstrip()) for l in lines) + '</p>')
    return ''.join(html_parts)
