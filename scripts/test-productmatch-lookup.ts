#!/usr/bin/env tsx
/**
 * Test unitaire de findSkuByProductMatch sur le catalogue LFC réel.
 * Cas Charles 08/07/2026 (cnv_1lsco05z) : 4×5 militaire polyester.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Copie locale des helpers (test isolé, pas d'import Next.js)
interface CatalogEntry {
  ttc: number; hts: number[]; label: string;
  typology: string; shape: string; material: string; color: string; size: string;
}

function parsePriceFile(content: string): Record<string, CatalogEntry> {
  const out: Record<string, CatalogEntry> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('═') || line.startsWith('-') || line.startsWith('⚠') || line.startsWith('ℹ')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length !== 19) continue;
    const sku = parts[5];
    if (!/^\d{12,14}$/.test(sku)) continue;
    const ttc = parseFloat(parts[6].replace(',', '.'));
    if (Number.isNaN(ttc)) continue;
    const hts: number[] = [];
    for (let i = 7; i < 19; i++) {
      const v = parseFloat(parts[i].replace(',', '.'));
      if (Number.isNaN(v)) break;
      hts.push(v);
    }
    if (hts.length !== 12) continue;
    const label = `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]} ${parts[4]}`.trim();
    out[sku] = { ttc, hts, label, typology: parts[0], shape: parts[1], material: parts[2], color: parts[3], size: parts[4] };
  }
  return out;
}

function normAttr(s: string): string {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[×x]/g, 'x')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function normSize(s: string): string {
  const n = normAttr(s);
  const m = n.match(/^(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)(?:\s*x\s*(\d+(?:[.,]\d+)?))?$/);
  if (!m) return n;
  const nums = [m[1], m[2], m[3]].filter(Boolean).map((v) => parseFloat(v.replace(',', '.')));
  nums.sort((a, b) => a - b);
  return nums.map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.0', ''))).join('x');
}
function findSkuByProductMatch(
  catalog: Record<string, CatalogEntry>,
  pm: { typology?: string; shape?: string; material?: string; color?: string; size?: string },
): string | null {
  if (!pm.typology || !pm.shape || !pm.material || !pm.color || !pm.size) return null;
  const wantTypo = normAttr(pm.typology);
  const wantShape = normAttr(pm.shape);
  const wantMat = normAttr(pm.material);
  const wantColor = normAttr(pm.color);
  const wantSize = normSize(pm.size);
  const matches: string[] = [];
  for (const [sku, entry] of Object.entries(catalog)) {
    if (normAttr(entry.typology) !== wantTypo) continue;
    if (normAttr(entry.shape) !== wantShape) continue;
    if (normAttr(entry.material) !== wantMat) continue;
    if (normAttr(entry.color) !== wantColor) continue;
    if (normSize(entry.size) !== wantSize) continue;
    matches.push(sku);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function main() {
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL!.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });

  const r = await db.query<{ content: string }>(
    `SELECT content FROM agent_files WHERE name='prix-ht-standards.txt' AND agent_id = (SELECT id FROM agents WHERE store_code='LFC')`,
  );
  const catalog = parsePriceFile(r.rows[0].content);
  console.log(`═══ Catalogue LFC chargé : ${Object.keys(catalog).length} SKU ═══\n`);

  // ─── Test 1 : cas Charles cnv_1lsco05z ─────────────────────
  console.log('TEST 1 — Cas cnv_1lsco05z : 4×5 militaire polyester');
  const t1 = findSkuByProductMatch(catalog, {
    typology: 'filet', shape: 'rectangle', material: 'polyester',
    color: 'militaire', size: '4x5',
  });
  console.log(`  Résultat : ${t1}`);
  const t1Entry = t1 ? catalog[t1] : null;
  console.log(`  Label catalogue : ${t1Entry?.label}`);
  console.log(`  TTC : ${t1Entry?.ttc} €  HT@20% : ${t1Entry?.hts[3]} €`);
  console.log(`  ATTENDU : SKU 3760388670444, TTC 199.99, HT 166.66\n`);

  // ─── Test 2 : taille réversible 5×4 vs 4×5 ─────────────────
  console.log('TEST 2 — Taille réversible : demande 5x4 (au lieu de 4x5)');
  const t2 = findSkuByProductMatch(catalog, {
    typology: 'filet', shape: 'rectangle', material: 'polyester',
    color: 'militaire', size: '5x4',
  });
  console.log(`  Résultat : ${t2}  ${t2 === t1 ? '✓ (identique)' : '✗ DEVRAIT être identique !'}\n`);

  // ─── Test 3 : triangle 3 côtés (taille standard existante) ─
  console.log('TEST 3 — Triangle 4x4x4 blanc polyester');
  const t3 = findSkuByProductMatch(catalog, {
    typology: 'filet', shape: 'triangle', material: 'polyester',
    color: 'blanc', size: '4x4x4',
  });
  console.log(`  Résultat : ${t3}`);
  const t3Entry = t3 ? catalog[t3] : null;
  console.log(`  Label : ${t3Entry?.label} — TTC : ${t3Entry?.ttc}`);
  console.log(`  ATTENDU : SKU 3760388679270, TTC 99.90\n`);

  // ─── Test 3 bis : triangle ordre inversé (4x5x3 doit trouver 3x4x5) ─
  console.log('TEST 3 bis — Triangle blanc polyester ordre inversé (4x5x3)');
  const t3bis = findSkuByProductMatch(catalog, {
    typology: 'filet', shape: 'triangle', material: 'polyester',
    color: 'blanc', size: '4x5x3',
  });
  console.log(`  Résultat : ${t3bis}  ${t3bis === '3770030527545' ? '✓ (3x4x5 trouvé)' : '✗'}\n`);

  // ─── Test 4 : accents / casse (« Militaire » au lieu de « militaire ») ─
  console.log('TEST 4 — Robustesse casse/accents : « MILITAIRE » ');
  const t4 = findSkuByProductMatch(catalog, {
    typology: 'FILET', shape: 'Rectangle', material: 'Polyester',
    color: 'MILITAIRE', size: '4x5',
  });
  console.log(`  Résultat : ${t4}  ${t4 === t1 ? '✓ (identique)' : '✗ CASSE'}\n`);

  // ─── Test 5 : couleur inexistante ─────────────────────────
  console.log('TEST 5 — Couleur inexistante « rouge »');
  const t5 = findSkuByProductMatch(catalog, {
    typology: 'filet', shape: 'rectangle', material: 'polyester',
    color: 'rouge', size: '4x5',
  });
  console.log(`  Résultat : ${t5}  ${t5 === null ? '✓ (null attendu)' : '✗'}\n`);

  await db.end();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
