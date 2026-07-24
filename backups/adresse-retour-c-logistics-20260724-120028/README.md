# Adresse physique de retour C-Logistics — 24/07/2026

Ajout du bloc « ADRESSE PHYSIQUE DE RETOUR — entrepôt partenaire C-Logistics » dans `agents.instructions` × 10 boutiques.

## Adresse
```
C-Logistics — Service des retours
ZA Pot au Pin
33613 CESTAS CEDEX
```

## Règle métier (Charles, 24/07/2026)
L'adresse ne se donne au client QUE quand les 3 conditions sont réunies :
1. Le client a formellement demandé un retour
2. Le gérant a validé la demande
3. Le gérant a envoyé au client l'étiquette de retour prépayée

Sinon → phrase neutre « nous revenons vers vous avec les instructions de retour » + flag QUESTIONS.

**JAMAIS renvoyer le client au siège 5 rue Fénelon** — les retours n'y sont pas traités.

## Contenu du backup
- `instructions-<STORE>.txt` × 10 : état PRÉ-patch de chaque agents.instructions (restauration via `UPDATE agents SET instructions = ... WHERE store_code = ...` si besoin).
- `patch_adresse_retour.py` : script idempotent utilisé (relance = skip si `C-Logistics` déjà présent).
