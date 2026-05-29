# CLAUDE.md — Conventions et pièges connus

## Architecture

```
front-claude-app/
├── client/                          # Plugin Front App (Vite + React)
│   └── src/
│       ├── components/
│       │   ├── PluginMain.tsx        # Composant principal — state, multitask, conversation switch
│       │   ├── QuotePanel.tsx        # Formulaire devis PDF — extraction, vérification, envoi Pennylane
│       │   ├── DraftFinal.tsx        # Push brouillon dans Front — traduction, cleanDraft
│       │   └── ClaudeChat.tsx        # Affichage messages chat
│       ├── hooks/
│       │   ├── useClaude.ts          # Hook streaming — analyze, sendMessage, multitask
│       │   └── useConversationCache.ts  # Cache mémoire + BDD conversations
│       ├── utils/
│       │   └── cleanDraft.ts         # Nettoyage brouillon avant push (questions, signatures, commentaires)
│       └── providers/
│           └── FrontContext.tsx       # Context Front SDK
├── src/
│   ├── app/api/
│   │   ├── plugin/
│   │   │   ├── analyze/route.ts      # Analyse mail — Claude Sonnet + stock Octopia + images
│   │   │   ├── message/route.ts      # Messages de suivi — même logique que analyze
│   │   │   ├── extract-quote/route.ts # Extraction données devis — Claude Sonnet
│   │   │   ├── create-quote/route.ts  # Création devis Pennylane + appendices
│   │   │   ├── push-draft/route.ts    # Push brouillon dans Front (avec ou sans PDF)
│   │   │   ├── translate/route.ts     # Détection langue + traduction — Claude Sonnet
│   │   │   ├── stock/route.ts         # Endpoint stock Octopia
│   │   │   ├── conversation-images/   # Images d'une conversation Front
│   │   │   └── quote-history/route.ts # Historique devis par conversation
│   │   └── frontapp/
│   │       └── draft-with-quote/      # Push brouillon + PDF (legacy, utilisé par app Next.js)
│   └── lib/services/
│       ├── claudeService.ts          # Appels Claude API — streaming, buildMessages, images/PDF
│       ├── pennylaneService.ts       # Création devis + upload appendices Pennylane
│       ├── frontappService.ts        # API Front — messages, images, canaux
│       └── octopiaService.ts         # API Octopia — auth OAuth2, stock par SKU
```

## Données en BDD (PostgreSQL)

- **agents** : instructions système par boutique (store_code)
- **agent_files** : documents de référence (catalogue, devis-sur-mesure, CGV, etc.)
- **claude_conversations / claude_messages** : historique conversations plugin
- **conversation_quotes** : historique devis créés par conversation
- **shared_files** : fichiers partagés entre agents

## Pièges connus — NE PAS reproduire

### Prix accessoires
- Les prix catalogue sont en **TTC**. Les prix grille sur mesure sont en **HT**.
- NE JAMAIS convertir TTC→HT dans le code. La conversion se fait via le **tableau de lookup** dans le document `devis-sur-mesure` (pré-calculé par taux de TVA).
- Le code QuotePanel envoie les prix **tels quels** du formulaire à Pennylane.
- PIÈGE : Haiku/Sonnet peut convertir de son côté → double conversion. Le prompt dit "copier depuis le tableau, pas calculer".

### Standard vs sur-mesure (jamais de substitution)
- Si la taille demandée existe au catalogue (tailles **réversibles** : 3×4 = 4×3) → STANDARD, prix TTC.
- Sinon → SUR MESURE aux **dimensions exactes** demandées. **Jamais** de proposition d'une taille standard « proche » à la place (ni avant, ni à côté du chiffrage sur-mesure).
- Si le client emploie « sur mesure », « dimensions exactes », « à façon », « personnalisé » → sur-mesure obligatoire, même si une taille catalogue est très proche.
- Encodé dans `agents.instructions` (rule #1 + section « STANDARD vs SUR MESURE » §4) pour les 8 boutiques avec sur-mesure (COCO exclue — pas de sur-mesure).

### Jamais recommander une taille plus petite que la surface à couvrir
- Le client doit avoir un filet qui couvre **EXACTEMENT** sa surface (ou immédiatement au-dessus s'il veut du débord).
- INTERDIT : « prenez 25 cm de moins », « -5 à 10 % pour effet drapé/tension », « la taille inférieure suffira pour tendre ». Ces conseils ont causé des erreurs SAV graves (filets sous-dimensionnés, cas Richard CHIERICI mai 2026).
- Boucles/dragonnes/œillets périphériques = **soudés en plus** de la dimension utile → le client décide où les placer, on ne réduit pas la commande pour ça.
- Pose entre arbres/poteaux : **AJOUTER** 40-50 cm à la distance entre supports (matière à enrouler), jamais retirer.
- Encodé dans `agents.instructions` (règle #5 sur les 8 boutiques sur-mesure + équivalent COCO).
- **À fixer côté site** : la page produit / formulaire devis qui conseille « enlever 25 cm aux 3 côtés » → source du bug. Pas modifiable depuis le code (Shopify).

### Tranche de surface (grille sur mesure)
- La grille sur mesure a 4 colonnes : `< 2 m²` | `2-5 m²` | `6-10 m²` | `> 10 m²`. La tranche se choisit sur la **surface totale** (tous filets confondus).
- PIÈGE : Claude reste sur `6-10 m²` pour une surface > 10 m². La colonne `> 10 m²` couvre **tout ≥ 10 m²** (24 m², 50 m²…). Ex : 24 m² acier rectangle = **15,50 €/m²**, PAS 23,50 (qui est la tranche 6-10).
- Garde-fou dans le doc `devis-sur-mesure-base-documentaire.txt` : la tranche est le **critère 4** de la VÉRIFICATION OBLIGATOIRE, et le prompt exige d'annoncer ligne+colonne dans QUESTIONS avant de chiffrer. Doc identique sur les 8 boutiques.

### PRODUCT_ID_FILET (Pennylane)
- Le produit `14369303` dans Pennylane a une **description template** ("Quantité : ** | Total m² | Délai...").
- Utiliser ce product_id **uniquement** pour les filets sur mesure (unit=m2, quantité décimale).
- Pour les produits standard catalogue : **pas de product_id** → ligne libre sans description template.

### cleanDraft (nettoyage avant push)
- Doit supprimer : QUESTIONS/PREGUNTAS/FRAGEN/etc., commentaires [⚠️...], signatures (toutes langues)
- Les sections QUESTIONS peuvent être formatées en **bold markdown** (`**PREGUNTAS**`) → le regex doit gérer `\**`
- Chercher le "Bonjour" **après** le marqueur BROUILLON/MAIL FINAL (pas le Bonjour du mail client)

### Multitask
- NE PAS abort les streams précédents lors d'un nouveau `analyze` (les streams continuent en background)
- `frontConvIdRef` est la clé pour empêcher les streams de mettre à jour l'UI du mauvais mail
- `onBackgroundComplete` sauve les résultats en cache mémoire quand un stream finit en arrière-plan
- `justSwitchedRef` empêche le cache de se polluer lors d'un changement de conversation

### Langue
- Claude rédige TOUJOURS en **français** (langue de travail du gérant)
- La traduction se fait au moment du **push** dans Front App
- Le sélecteur de langue est pré-rempli par le **store code** (TAR→de, RED→es, etc.), pas par détection IA
- La traduction utilise Claude Sonnet

### Canal Front (email vs chat vs Instagram)
- Le type de canal est détecté depuis `conv.last_message.type` et le sujet de la conversation
- Instagram/Facebook → matcher par nom dans les canaux custom
- Si erreur 403 "channel type mismatch" → retry sans channel_id
- Si erreur 400 "channel_id missing" → Front exige un channel_id (conversations custom)

### Images / PJ
- Images récupérées côté **backend** via Front REST API (pas le SDK client)
- Filtrage : `metadata.is_inline` < 100KB → exclu (logos), > 100KB → gardé (photos)
- Noms commençant par "logo/signature/banner" → exclus
- PDFs envoyés comme `DocumentBlockParam` (pas convertis en image)
- Magic bytes pour détecter le vrai format (Front ment parfois sur le content_type)
- Images > 3.7MB compressées via `sharp` (max 2000x2000, JPEG 80%)

### Templates
- Les templates (dropdown, bouton "i", liens procédure/PJ) doivent être **identiques** sur la page d'accueil ET dans la popup "Reprendre avec Claude". Toute modification doit s'appliquer aux DEUX endroits.
- Templates stockés en BDD (table `templates`) avec : name, summary, content, attachment_url, procedure_url, store_code
- `attachment_url` : PDF joint automatiquement au push dans Front (URL de téléchargement direct Google Drive)
- `procedure_url` : lien cliquable "Voir la procédure" affiché dans le plugin

### Devis PDF
- Standard (catalogue) : unit=piece, pas de description, pas de product_id
- Sur mesure : unit=m2, quantité décimale, product_id=PRODUCT_ID_FILET, description délai
- Transport : prix HT depuis table de lookup (pas de calcul)
- TVA intra (LIC) : si n° TVA intra renseigné + pays UE hors FR → TVA auto à 0% + mention légale Article 138
- Remise globale → champ `discountPercent` (pas une ligne produit)
- Téléphone obligatoire pour générer

### Stock Octopia
- Auth OAuth2 avec `sellerId` en **header** (pas query param)
- Credentials : `SAS ZEPHYR O.S.C` / seller 223879
- SKU = `sellerProductReference` = code EAN catalogue
- Info stock dans la section QUESTIONS uniquement (jamais dans le brouillon client)

## Boutiques et langues

| Code | Nom | Langue | Pennylane Template |
|------|-----|--------|-------------------|
| LFC | Le Filet de Camouflage | FR | 253634 |
| LVO | Le Voile d'Ombrage | FR | 877143 |
| COCO | Ma Toile Coco | FR | 257180 |
| MON | Mon Ombrage | FR | 883869 |
| UNI | L'Univers du Camouflage | FR | 883875 |
| TAR | Tarnnetz | DE | 257174 |
| HET | Het Camouflagenet | NL | 257162 |
| RED | Red de Camuflaje | ES | 257168 |
| RETE | Rete Mimetica | IT | 861190 |

## Commandes utiles

```bash
# Accéder à la BDD
export DATABASE_URL=$(grep DATABASE_URL .env | cut -d'=' -f2-)
psql "$DATABASE_URL"

# Voir les instructions d'un agent
psql "$DATABASE_URL" -c "SELECT instructions FROM agents WHERE store_code = 'LFC';"

# Voir un document agent
psql "$DATABASE_URL" -c "SELECT content FROM agent_files WHERE name LIKE '%devis%' AND agent_id = (SELECT id FROM agents WHERE store_code = 'LFC');"

# Build
npm run build

# Les .env ne sont PAS dans git — modifier sur Render directement
```
