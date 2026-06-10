# Reporting SAV hebdomadaire

Génère le rapport Excel hebdomadaire de performance de l'équipe SAV à partir de l'API Front.

## Lancer

```bash
# Dernière semaine ISO complétée (défaut)
python3 reporting_semaine.py

# Semaine spécifique
python3 reporting_semaine.py --week 24

# Reconstruire le xlsx depuis un raw JSON déjà existant (sans retaper l'API)
python3 reporting_semaine.py --week 23 --rebuild-only
```

Le script :
1. Pull les conversations Front dans une fenêtre de 8 jours (Ven semaine d'avant → Ven semaine cible).
2. Compte mails reçus / bruits filtrés / traités par teammate et par jour.
3. Échantillonne 5 mails par collaboratrice pour l'audit qualité (seed = date du jour).
4. Écrit `~/Downloads/reporting_S<NN>_<YYYY>.xlsx` et l'ouvre.

Durée typique : 30-90 min selon le rate limit Front partagé.

## Conventions méthodo (héritées du S22 du 02/06/2026)

| Règle | Détail |
|---|---|
| **Fenêtre affichée** | 8 jours : Ven précédent → Ven cible inclus |
| **Vendredi contextuel** | Le Ven du début est affiché (traités = `—`) mais **exclu** du TOTAL et de la cadence |
| **Jours ouvrés comptés** | Lun-Ven de la semaine cible, hors fériés FR |
| **Heures par teammate** | 7h/jour sauf **mardi 6h** (réunion équipe) |
| **Périmètre prime** | Murella + Roniah uniquement (Charles & Jérémy comptent dans le débit équipe mais pas dans la prime individuelle) |
| **Cadence** | mails traités / heures travaillées |
| **À traiter aujourd'hui** | Mails réels reçus la veille (pour le premier jour ouvré : cumul du Ven contextuel + WE + fériés) |
| **Barème prime** | ≥ 16/20 = prime entière 🟢 \| 10-15/20 = -50% 🟠 \| < 10/20 = 0 🔴 |

## Teammates Front (référence)

| ID | Nom | Rôle | Prime ? |
|---|---|---|:---:|
| `tea_hmfvb` | Murella Z. | Service Client | ✅ |
| `tea_mxhsn` | Roniah R. | Service Client | ✅ |
| `tea_mxqqf` | Jérémy Lerat | Responsable SC | ❌ |
| `tea_gnazb` | Charles BAMY | Fondateur | ❌ |

## Pièges connus

- **Cellules Excel commençant par `=`** → Excel les interprète comme formules et corrompt le fichier. Le script préfixe automatiquement par un espace.
- **Pagination Front** → suivre `_pagination.next` (le paramètre `page=N` est ignoré par Front).
- **Rate limit Front** → retry exponentiel + respect du `Retry-After`. Si on partage le token avec une autre session, on peut atteindre 60-90 min de fetch.
- **Filtre bruit** → regex reconstituée le 09/06/2026 (le S22 originel a été perdu avec `/tmp`). Peut différer ~1-2 % du S22. Affiche `bruit / brut` dans la synthèse pour surveiller la dérive.
- **Fériés FR** → maintenir `HOLIDAYS_FR` dans le script. Liste actuelle : 2026 + 2027.

## Reprendre la conversation Claude avec contexte complet

```bash
cd /Users/charlesbamy/front-claude-app
claude --resume 60e27702-1a82-4d67-a775-a1c0c5f23256
```

Cette conversation contient l'historique complet :
- Reconstitution du S22 (02/06/2026)
- Architecture des `sav_*` tables (mise en place par une autre session Claude le 09/06/2026)
- Toutes les règles métier (filtre bruit, cadence, audit qualité)

## Évolutions possibles

- **Migrer vers les tables `sav_*` BDD** : une session Claude parallèle a synchronisé Front en local (tables `sav_messages`, `sav_events`, `sav_conversations`...). Lire depuis la BDD éviterait complètement l'API Front (instantané vs 30-90 min de fetch).
- **Sync incrémentale** : ne pull que les convs avec `updated_at >= last_run` et merger.
- **Concurrent requests** : utiliser `ThreadPoolExecutor` pour paralléliser les `/messages` (max 4-6 workers pour ne pas saturer le rate limit).

## Backup et restauration

- Le **raw JSON** dans `/tmp/reporting_S<NN>_<YYYY>_raw.json` permet de reconstruire le xlsx avec `--rebuild-only` (utile si on veut changer le format Excel sans retaper l'API).
- `/tmp` **est vidé au reboot** : pour conserver un raw long terme, le copier ailleurs.

## Historique des fichiers livrés

| Semaine | Fichier | Date livraison |
|---|---|---|
| S22 | `~/Downloads/reporting_S22_2026.xlsx` | 02/06/2026 |
| S23 | `~/Downloads/reporting_S23_2026.xlsx` | 09-10/06/2026 |
