# Mât en bois Robinier — ajout catalogue LFC + COCO (2026-07-23)

Nouveau produit ajouté sur les 2 boutiques concernées.

## Info produit
- SKU : `3770043027001`
- Nom : Mât en bois Robinier (série limitée « bois flotté », SPARS design)
- Prix TTC : 219,99 € (identique LFC / COCO)
- Fabrication France (Locmariaquer 56740), essence Robinier, FSC, classe 4 naturel
- Livraison via partenaire **C Chez vous** (avec prise de rendez-vous)
- Sources info : `Notice.docx` fournisseur + PDF SPARS design (Charles 23/07)

## Modifications BDD
1. **agent_files** — nouveau fichier `FT-Mat-Bois-Robinier.txt` (3149 chars)
   inséré pour agents LFC et COCO. Fiche technique complète (matière, dimensions,
   charge, fixation béton, expédition, 2 mâts à ne pas confondre).
2. **agent_files.prix-ht-standards.txt** (LFC + COCO) :
   - Ajout ligne SKU 3770043027001 en `accessoire | mât en bois | bois | naturel | 1 pièce`
     après la ligne « mât télescopique ».
   - HT calculés sur les 12 colonnes TVA (0 à 27 %).
   - Complément listes colonnes 2 (forme : + « mât en bois ») et 3 (matière : + « bois »).
3. **agents.instructions** (LFC + COCO) :
   - Enrichissement bloc « ACCESSOIRES — PRIX STRICT » :
     * Liste initiale des familles accessoires + mention explicite des 2 mâts.
     * Ligne dédiée sous « MÂT & FIXATION SOL ».
     * Ajout à la liste de formes accessoires du bloc « CLASSIFICATION STANDARD vs SUR-MESURE ».
     * Nouveau PIÈGE OBSERVÉ : ne pas confondre mât télescopique alu (189,99 € TTC,
       colis standard) et mât en bois Robinier (219,99 € TTC, scellement béton,
       livraison C Chez vous).

## Fichiers de backup (pré-patch)
- `prix-ht-standards-LFC.txt` : contenu avant modification
- `prix-ht-standards-COCO.txt` : idem
- `instructions-LFC.txt` : idem
- `instructions-COCO.txt` : idem

## Restaurer si besoin
```sql
-- Exemple LFC — remplacer par le fichier de backup souhaité :
UPDATE agent_files SET content = $$…contenu backup…$$
WHERE name = 'prix-ht-standards.txt'
  AND agent_id = (SELECT id FROM agents WHERE store_code = 'LFC');
```
