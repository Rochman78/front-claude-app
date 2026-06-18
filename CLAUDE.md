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

### Prix devis — Architecture des agent_files (refacto 03/06/2026)

**3 fichiers spécialisés** par boutique (sauf COCO qui n'a pas de sur-mesure) :

| Fichier | Contenu | Quand le lire |
|---|---|---|
| `instructions-devis.txt` | Format JSON Pennylane, process, régimes TVA, templates texte, règle de routing prix | À chaque devis, en premier |
| `prix-ht-sur-mesure.txt` | Grille HT/m² par forme + finition + ignifugé × tranche surface | Pour les filets sur-mesure |
| `prix-ht-standards.txt` | Filets standards + accessoires + transport — TTC + HT pré-calculés par taux TVA (autorité unique) | Pour TOUTE référence produit standard (chiffrage devis ET réponse contexte) |

**Règle absolue** : pour un devis, lire le HT déjà pré-calculé dans `prix-ht-standards.txt` à la colonne du taux TVA du client. Ne jamais recalculer (double TVA risque, cf Sylvaine SIMONET-BONNET 03/06/2026).

**Source unique** : LFC est l'autorité TTC. Toutes les boutiques reprennent les mêmes TTC, seul le HT change selon la TVA pays. Voir `scripts/catalogue/README.md` pour le pipeline de mise à jour (CSV LFC → `regen_prix_ht_standards.py`).

**catalogue-XXX.txt SUPPRIMÉ (15/06/2026)** : redondant avec `prix-ht-standards.txt` qui contient déjà TTC + SKU + HT. Backup : `backups/catalogue-deleted-20260615-092625/` (10 fichiers + manifest JSON, restaurable en INSERT si besoin).

**Backup pré-refacto historique** : `backups/agent_files_backup_20260603-120752.json` (1,3 MB).

**Mise à jour future des prix** : voir `scripts/catalogue/README.md`. Le script `regen_prix_ht_standards.py` lit un CSV LFC (autorité TTC) et met à jour les `prix-ht-standards.txt` × 10 boutiques en recalculant le HT par taux TVA. SKU absent du CSV = ligne intacte. Stock géré séparément via Octopia, jamais dans les fichiers agents.

### Réassort produit en rupture — le client s'inscrit lui-même sur le site (12/06/2026)
- Plus de "on note ton email côté SAV" : on **redirige vers la fiche produit du site**, où un bouton intégré permet au client de saisir son email et d'être notifié automatiquement dès le retour en stock (feature Shopify, déjà en place côté site).
- L'agent ne promet plus de l'enregistrer manuellement — il indique au client comment faire : aller sur le site, sélectionner la référence souhaitée (la fiche reste accessible même hors stock), cliquer sur le bouton qui apparait.
- 9 boutiques (LFC, LVO, MON, UNI, TAR, HET, RED, REDE, RETE) : 2 options brouillon = (1) site + (2) sur-mesure. COCO : 1 seule option = site (pas de sur-mesure en coco).
- Encodé × 10 agents en BDD (remplace l'ancienne formulation "nous pouvons vous prévenir par email dès que le réassort sera disponible").

### TVA — toujours le pays de livraison (12/06/2026)
- TVA par défaut = TVA du **pays de livraison** du client (pas du pays de facturation).
- Si AUCUNE adresse de livraison fournie → TVA du **pays de la boutique** (règle B2C OSS par défaut).
- **JAMAIS demander au client** quelle TVA appliquer — c'est imposé par la loi.
- Taux : FR 20 / DE 19 / NL 21 / BE 21 / ES 21 / PT 23 / IT 22 / LU 17 / AT 20 / GB 20 / hors UE 0 (à confirmer).
- Exception B2B intra (n° TVA UE valide hors pays boutique) → 0 % + Article 138 (déjà géré côté code Pennylane).
- Cas Saracco 12/06/2026 (`cnv_1lmrvoev`, RED) : cliente espagnole (Javea), agent a appliqué TVA 20 % (FR) au lieu de 21 % (ES). Encodé × 10 agents.

### Jamais de prix vides dans un brouillon (12/06/2026)
- Si une info essentielle manque pour chiffrer (couleur, finition, dimensions, taux TVA, etc.) → **NE PAS générer le tableau de prix**. Mail court qui pose les questions, sans tableau.
- INTERDIT : « Total sin IVA : » suivi de rien, « XXX € », « à compléter », placeholders dans un tableau de prix envoyé au client.
- Cas Saracco 12/06/2026 (`cnv_1lmrvoev`, RED) : brouillon avec `Precio unitario sin IVA :` / `Total sin IVA :` / `IVA (20 %) :` / `Importe con IVA incluido :` tous vides → push au client. Encodé × 10 agents.
- **Garde-fou code** : `autoDraftService.ts` détecte une ligne « label-prix : » suivie de vide (multilingue) et bloque l'auto-push avec un commentaire de conv "à traiter via le plugin".

### Accessoires — prix strict depuis prix-ht-standards.txt (18/06/2026)
- Quand l'agent mentionne un accessoire (mât, base d'ancrage, kit fixation, cordes à cliquets, câble acier au mètre, corde polyester tressée, corde fibre de coco, colliers serrage, borne solaire), il DOIT lire EXACTEMENT la ligne SKU correspondante dans `prix-ht-standards.txt` et recopier TTC + HT par TVA. Aucune mémorisation, aucun arrondi, aucun calcul.
- Liste officielle des SKU accessoires encodée dans `agents.instructions` × 10 boutiques (bloc "⚠️ ACCESSOIRES — PRIX STRICT" inséré juste avant PROCESS DEVIS).
- Garde-fous métier inclus dans le bloc : (a) câble acier vendu par bobines 7,5/15/30 m, pas au mètre ; (b) NE PAS confondre "corde polyester tressée" (accessoire indépendant en rouleaux) avec "contour polyester Ø 6 mm" (fait partie du filet, soudé au bord) ; (c) NE PAS confondre "câble acier au mètre" (accessoire) avec "contour câble acier Ø 3 mm" (fait partie du filet).
- Cleanup BDD préalable 18/06/2026 : suppression de 3 lignes fantômes obsolètes du fichier prix-ht-standards.txt (Mât 199,90 €, Cordes à cliquets, Kit de fixation — toutes sans SKU), + relabel de 6 lignes "Default Title | Default Ti" → vrais noms (Mât / Base / Kit / Cordes / Borne solaire / Corde coco). Backups : `backups/prix-ht-accessoires-20260618-080724/`.

### Langue — tout en français dans le plugin jusqu'au push (16/06/2026)
- TOUT ce qui est écrit dans le plugin (brouillon, QUESTIONS, alertes [⚠️…], section VÉRIFICATION, exemples) est en **français**, intégralement, sans exception.
- La traduction vers la langue du client se fait UNIQUEMENT au moment du push dans Front App (via `/api/plugin/translate`).
- Avant le push, le service client (gérant) relit en français — c'est sa langue de travail.
- INTERDIT : basculer en italien / espagnol / allemand / néerlandais / portugais / anglais / etc., même un seul mot. Pas de contamination par la langue du mail client. Pas de contamination par un terme officiel étranger ("partita IVA", "USt-IdNr", "BTW", "NIF") croisé en milieu de phrase — on garde le terme en VO mais on ne bascule pas la phrase.
- Cas Cenci Noleggi Mamà Outdoor 16/06/2026 (`cnv_1lktrcev`, RETE) : brouillon commencé en FR, basculé en IT à mi-parcours après mention de "partita IVA IT01520200559" → 3 phrases en italien dans le plugin. Encodé × 10 agents — bloc dédié en **position #2** (juste après RÈGLE MÉTA), ancien item 8 LANGUE de RÈGLES PRIORITAIRES retiré.

### Taille filet — AUCUN conseil, sur-mesure d'abord puis standard (16/06/2026)
- Quand un client donne ses dimensions de zone à couvrir, l'agent NE CONSEILLE JAMAIS de prendre « plus petit » ou « plus grand ». Aucune marge à ajouter, aucun retrait à appliquer — le client se débrouille avec son installation.
- **Ordre obligatoire** dans le brouillon : (1) sur-mesure aux dimensions EXACTES du client, (2) ensuite standard catalogue à la taille la plus proche, (3) « à vous de nous indiquer la solution qui vous convient le mieux ».
- INTERDIT : tension, drapé, effet tombant, strakgespannen, marge fixation poteaux (+40-50 cm), « léger débord », « pour faciliter la pose », « plus petit pour tendre », « plus grand pour le drapé », et toutes leurs traductions multilingues.
- Si le client demande explicitement « lequel me conseillez-vous ? » : on ne tranche pas à sa place. Réponse type + flag QUESTIONS au gérant.
- Cas Graciela Alarcon 26/05/2026 (`cnv_1lh9w3mf`, HET) : terrasse 5,2 × 3,3 m, Claude a recommandé tour à tour 6×4 ("plus grand pour fixation") puis 5×3 ("plus petit pour tendre") sur 4 messages successifs — cliente dans le flou total. Encodé × 10 agents (bloc dédié avant TRANCHE SUR-MESURE).

### Tranche sur-mesure = SURFACE TOTALE du devis, jamais par filet (15/06/2026)
- La tranche tarifaire de `prix-ht-sur-mesure.txt` se choisit sur la SURFACE TOTALE des filets sur-mesure du devis. Les filets standards catalogue ne se cumulent PAS dans ce total.
- 4 tranches : `< 2 m²` | `2-5 m²` | `6-10 m²` | `> 10 m²` (et plus, sans limite).
- Le même prix unitaire s'applique à TOUS les filets sur-mesure du devis (forme + finition correspondante).
- **Avant d'écrire le prix** : annoncer en QUESTIONS la ligne ET la colonne retenues.
- Cas Fabien SZCZODRY EHPAD Les Lauriers 19/05/2026 (`cnv_1lfxyqqf`, LFC) : 2 × câble acier 3×3 (18 m²) + 1 × câble acier 3×4 (12 m²) = **30 m²** total → tranche `> 10 m²` → `15,50 €/m²`. Claude a appliqué `23,50 €/m²` (tranche 6-10) à tout le devis → surfacturation **240 € HT / 288 € TTC**. Encodé × 10 agents.

### Lecture des croquis client — méthode systématique (12/06/2026)
- Quand un croquis (à main levée) est joint, l'agent doit faire un **inventaire des côtés** dans l'ordre haut → droite → bas → gauche, en marquant chaque côté soit avec sa cote exacte soit avec `NON COTÉ`. Les diagonales internes sont listées SÉPARÉMENT (jamais confondues avec un côté). Si plusieurs croquis ont des cotes contradictoires → flagger en QUESTIONS sans choisir.
- INTERDIT : inventer une cote, mélanger les cotes de 2 croquis du même fil, lire un chiffre approximatif sans flag.
- Cas Dominique Laino 12/06/2026 (`cnv_1liirz6f`) : croquis avec haut=2m, gauche=3m, bas=3m, droite NON COTÉ + diagonales 3,63/4,21/3,15. Claude a dit « côté bas non coté » (FAUX) et a lu « 1,21 » au lieu de « 4,21 ». Contamination probable avec les autres croquis du fil. Encodé dans `agents.instructions` (10 boutiques).
- **Fix code parallèle** : `frontappService.ts` dédupe désormais les PNG inline < 100 KB par taille exacte (à l'octet) en plus du nom+bucket → élimine les logos de signature déguisés en `attachment-1.png` / `attachment-6.png` / `''` qui polluaient les slots d'images.

### Anti-fantaisie factuelle — l'agent ne sait RIEN au-delà de ses sources (11/06/2026)
- Toute question factuelle sur l'entreprise (présence marketplace externe Leroy Merlin / Amazon / Cdiscount / ManoMano, partenariats, magasin physique, certifications M1/M2, capacités de prod hors devis, etc.) est par défaut **INCONNUE** sauf si écrite noir sur blanc dans les instructions ou les fichiers de référence.
- Comportement attendu si la réponse n'est pas dans les sources : BROUILLON court d'accusé de réception (« nous revenons vers vous rapidement ») + flagger en QUESTIONS pour que le gérant tranche. **JAMAIS de OUI/NON inventé.**
- INTERDIT : déduire un OUI sur indices circonstanciels (« les images ressemblent → c'est nous », « le nom est proche → c'est notre marque »). Les images de notre site peuvent être reprises ailleurs sans notre accord.
- Cas Langlais 09/06/2026 (`cnv_1llucrrr`, LFC) : client demande « Est-ce vous qui vendez sur Leroy Merlin ? » avec un lien Leroy Merlin. Claude a inventé « Oui, nous sommes bien présents sur la marketplace Leroy Merlin » + « Pas de question, valide le brouillon ». 100 % halluciné. Encodé dans `agents.instructions` (10 boutiques, bloc dédié placé après la RÈGLE MÉTA et avant le PROCESS DEVIS).

### Frais de retour — JAMAIS « à nos frais » par défaut
- Règle par défaut : frais de retour à la charge du **client** (art. L.221-23). Formulations comme *« le retour est pris en charge à nos frais »*, *« vous n'avez rien à régler pour l'expédition »*, *« retour à nos frais »* sont **INTERDITES** sauf instruction explicite du gérant.
- Exception légale automatique : produit défectueux / défaut de conformité / erreur de notre part → frais à notre charge (art. L.217-11), mais à VÉRIFIER avant.
- Pronom ambigu dans la consigne du gérant (« leurs frais », « ses frais ») → ne jamais interpréter, demander en QUESTIONS.
- Cas Bruno VIDAILLAC 02/06/2026 (`cnv_1ljjlk47`) : Claude avait écrit « à nos frais » par mauvaise interprétation de « leurs frais ». Encodé dans `agents.instructions` (9 boutiques).

### Numéro de commande — l'agent lit l'objet/corps AVANT de demander (03/06/2026)
- Avant de demander un n° de commande au client, **l'agent doit chercher** dans l'objet du mail ET dans le corps. Patterns reconnus : `#LFC12345`, `Commande #12345`, `Bestellung`, `Pedido`, `Ordine`, `Bestelling`, `Order #12345`.
- Si trouvé → utilise directement, ne redemande pas.
- Encodé dans `agents.instructions` × 9 boutiques (règle juste après le WORKFLOW).

### Échange (retour + nouvelle commande) — code promo 15% (politique 03/06/2026)
- Retour SIMPLE (rétractation pure, pas de rachat) : frais retour client + remboursement, **pas de code promo**.
- ÉCHANGE (le client retourne pour racheter chez nous) : frais retour client + remboursement de l'ancienne, **+ code promo 15%** sur la nouvelle commande (geste fidélisation).
- Le code est **généré par le gérant dans Shopify** (1 usage, lié à l'email client) — l'agent annonce dans le mail et flagge dans QUESTIONS pour que le gérant crée le code.
- Encodé dans `agents.instructions` (9 boutiques, remplace l'ancienne règle « PAS DE CODE RÉDUCTION ») + dans `template-echange-erreur-client.txt`.

### Quadrilatère quelconque — forme acceptée, exige croquis + diagonale ou angles (18/06/2026)
- L'atelier sait fabriquer **4 catégories** sur-mesure : rectangle/carré, triangle, trapèze (bases parallèles), **quadrilatère quelconque** (4 côtés sans contrainte de parallélisme). Même tarif que Triangle-Trapèze (mêmes lignes dans `prix-ht-sur-mesure.txt`).
- 4 côtés seuls ne suffisent JAMAIS à calculer la surface d'un quadrilatère quelconque (forme non unique). Il faut **1 donnée supplémentaire** : soit une **diagonale cotée** (option préférée, plus simple à mesurer), soit les **4 angles aux sommets**.
- **INTERDICTION ABSOLUE** : ne jamais conclure « ces mesures ne forment pas un trapèze géométriquement réalisable » / « incohérence géométrique » sur la seule base des 4 côtés. C'est faux dans 99 % des cas — la forme existe en quadrilatère quelconque, il manque juste la diagonale.
- Calcul de surface après réception : décomposition en 2 triangles via la diagonale + formule de Héron sur chacun.
- Cas Dominique Delpit 18/06/2026 (`cnv_1lnflc5z`, LFC) : client demande filet « type trapèze » 4,4×3×5,32×1 m. Sous hypothèse trapèze (bases parallèles), géométriquement impossible — VRAI mais TROMPEUR. En quadrilatère quelconque, forme fabricable, il manque juste la diagonale. Claude a écrit au client « ces mesures ne forment pas un trapèze géométriquement réalisable » → cliente perd confiance et abandonne. Encodé × 10 agents (bloc dédié entre LECTURE DES CROQUIS et TVA) + grille `prix-ht-sur-mesure.txt` × 9 boutiques.

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

### Format vat_rate Pennylane (piège erreur trompeuse)
- Format obligatoire : `XX_NNN` où XX = code pays alpha-2 MAJUSCULE, NNN = taux × 10.
  Exemples : `FR_200` (20%), `FR_55` (5,5%), `DE_190`, `ES_210`, `IT_220`, `NL_210`, `BE_210`, `LU_170`. 0% → `exempt`.
- **Tout code invalide** (`"20"`, `"fr_200"`, `"FR_20"` pour 20%, `"tax_free_0"`, `"France_200"`) provoque une erreur 400 **trompeuse** : `"The schema of the object invoice_lines isn't one of the following: 'Product-based Invoice Line' ..."`. Le message ne mentionne JAMAIS vat_rate.
- `pennylaneService.normalizeVatRate()` normalise robustement (accepte nombre, format dégradé, casse mixte) → toujours passer par cette fonction côté serveur.

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
- **Délais** : sur-mesure = **21 jours** (fabrication + livraison) | standard catalogue = 48-72 h (livraison France gratuite)
- **Boucles câble acier 10 cm** soudées aux 4 coins du filet (hors dimensions du filet), sert de points d'accroche principaux
- **Arrondi** : dimensions ET surface **au dixième** (1 décimale). NE PAS arrondir les valeurs intermédiaires. Pour triangle 3-côtés, utiliser Héron pour ne pas perdre en précision sur la hauteur. Règle dans `prix-ht-sur-mesure.txt` × 8 boutiques.

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
| REDE | Rede Camuflagem | PT | 257168 (temp, partagé avec RED en attendant template Pennylane dédié) |
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
