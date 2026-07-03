#!/usr/bin/env python3
"""
Traduit le mail FR "double expédition" vers DE / NL / ES / IT via Sonnet
et affiche les 4 traductions pour validation par Charles avant l'envoi
en batch. Traduction one-shot : les résultats seront hardcodés dans
config.py une fois validés (pas d'appels Sonnet au runtime des scripts
create/send_drafts).
"""
import os
import sys

# Charger la clé Anthropic depuis .env
def load_env(key):
    env_path = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
    with open(env_path) as f:
        for line in f:
            if line.startswith(f'{key}='):
                return line.split('=', 1)[1].strip()
    raise RuntimeError(f'{key} manquant dans .env')

os.environ['ANTHROPIC_API_KEY'] = load_env('ANTHROPIC_API_KEY')

import anthropic  # noqa: E402

FR_SUBJECT = "Important — commande [ORDER] livrée en double : action requise"

FR_BODY = """Bonjour,

Nous vous contactons au sujet de votre commande.

À la suite d'une erreur logistique de notre part, votre commande a malheureusement été expédiée en double. Nous en sommes sincèrement désolés et tenons à corriger cette situation immédiatement, sans aucun frais pour vous.

👉 Ce que nous vous demandons de faire dès maintenant :

1. Si vous n'avez PAS encore reçu le second colis :
Refusez tout simplement la livraison du colis en double auprès du transporteur. Il nous sera automatiquement retourné, et vous n'aurez aucune démarche supplémentaire à effectuer. Merci de nous le confirmer en répondant à ce mail.

2. Si vous avez DÉJÀ reçu les deux colis :
Répondez à ce mail dans les plus brefs délais (idéalement sous 48h). Nous vous transmettrons alors, individuellement, une étiquette de retour prépayée pour nous renvoyer le colis en double — sans frais de votre part.

Une fois le retour effectué, merci de nous envoyer une photo du récépissé d'expédition (preuve de dépôt) afin que nous puissions suivre le retour et procéder aux vérifications nécessaires.

✅ Notre engagement :
Nous vérifierons systématiquement qu'aucune double facturation n'a été appliquée sur votre moyen de paiement. Si un second débit a eu lieu, il vous sera intégralement remboursé.

Cette démarche est importante pour vous éviter d'être facturé deux fois. Nous vous remercions par avance de votre réactivité, qui nous permettra de régulariser rapidement la situation.

Nous restons entièrement à votre disposition pour toute question — il vous suffit de répondre à ce message.

Avec toutes nos excuses pour ce désagrément,"""

LANGS = [
    ('de', 'allemand'),
    ('nl', 'néerlandais'),
    ('es', 'espagnol'),
    ('it', 'italien'),
]

client = anthropic.Anthropic()

results = {'fr': {'subject': FR_SUBJECT, 'body': FR_BODY}}

for code, langname in LANGS:
    print(f'\n=== Traduction vers {langname.upper()} ({code}) ===', file=sys.stderr)
    prompt = f"""Traduis ce mail de service client + son sujet du français vers le {langname}.

CONSIGNE STRICTE :
- Garde EXACTEMENT le même ton, la même structure et le même formatage (retours à la ligne, emojis 👉 ✅, la placeholder [ORDER] intact).
- Ne traduis PAS [ORDER] (c'est une variable qui sera remplacée par un numéro de commande client).
- Réponds UNIQUEMENT au format suivant, SANS commentaire ni backticks :

SUJET:
<le sujet traduit en une ligne>

CORPS:
<le corps traduit, retours à la ligne préservés>

Mail FR à traduire :

SUJET:
{FR_SUBJECT}

CORPS:
{FR_BODY}"""

    msg = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=4000,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = msg.content[0].text
    # Parse tolérant : SUJET: / CORPS: peuvent varier en majuscules ou en
    # accents selon la langue de sortie ; on scan les 2 premières lignes
    # non-vides pour le sujet et le reste pour le corps.
    import re
    # Cherche un pattern "SUJET" ou "SUBJET"/"BETREFF"/"ONDERWERP"/"ASUNTO"/
    # "OGGETTO" suivi de :
    subj_re = re.compile(r'^(SUJET|SUBJET|SUBJECT|BETREFF|ONDERWERP|ASUNTO|OGGETTO)\s*:\s*(.+?)$', re.I | re.M)
    body_re = re.compile(r'^(CORPS|BODY|KORPER|INHOUD|CUERPO|CORPO)\s*:\s*(.*)', re.I | re.M | re.S)
    subj_m = subj_re.search(raw)
    body_m = body_re.search(raw)
    if not subj_m or not body_m:
        print(f'!!! Parse KO pour {code}, raw:\n{raw[:500]}', file=sys.stderr)
        results[code] = {'subject': '(à retraduire)', 'body': raw.strip()}
    else:
        subject = subj_m.group(2).strip()
        body = body_m.group(2).strip()
        results[code] = {'subject': subject, 'body': body}

# Affichage final
print('=' * 80)
for code, data in results.items():
    print(f'\n### {code.upper()} ###')
    print(f'SUBJECT: {data["subject"]}')
    print(f'BODY:\n{data["body"]}')
    print()

# Sauvegarde dans un fichier pour référence
import json
out_path = os.path.join(os.path.dirname(__file__), 'translations.json')
with open(out_path, 'w') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
print(f'\n\nSauvegardé dans : {out_path}', file=sys.stderr)
