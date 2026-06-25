#!/usr/bin/env tsx
/**
 * Réconcilie le status des conversations en BDD avec leur état réel
 * dans Front pour les 10 inboxes boutique.
 *
 * Cas couvert :
 *   - BDD = 'archived' mais Front = 'unassigned' / 'assigned' (= conv
 *     rouverte côté Front sans qu'on ait reçu l'event reopen — typique
 *     après une coupure webhook).
 *
 * Pour chaque inbox active :
 *   1) GET /inboxes/{id}/conversations?q[statuses][]=unassigned
 *      + q[statuses][]=assigned (paginated)
 *   2) Pour chaque conv retournée : si BDD a status='archived', remettre
 *      status=Front, archived_at=NULL, synced_at=NOW().
 *
 * Idempotent : si BDD a déjà status='unassigned', l'UPDATE est no-op.
 *
 * Usage : npx tsx scripts/reconcile-open-convs.ts
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const DB_URL = process.env.DATABASE_URL;
const FRONT_TOKEN = process.env.FRONT_API_TOKEN;
if (!DB_URL) { console.error('❌ DATABASE_URL manquant'); process.exit(1); }
if (!FRONT_TOKEN) { console.error('❌ FRONT_API_TOKEN manquant'); process.exit(1); }

interface FrontConv {
  id?: string;
  status?: string;
  assignee?: { id?: string } | null;
  subject?: string;
}
interface FrontPage {
  _results?: FrontConv[];
  _pagination?: { next?: string };
}

async function frontFetch(path: string): Promise<FrontPage | null> {
  const url = path.startsWith('http') ? path : `https://api2.frontapp.com${path}`;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      if (i === 4) return null;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

async function main() {
  const db = new Client({
    connectionString: DB_URL,
    ssl: DB_URL!.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();

  const inboxes = await db.query<{ id: string; store_code: string; name: string }>(
    `SELECT id, store_code, name FROM sav_inboxes
     WHERE is_active = true AND store_code IS NOT NULL
     ORDER BY store_code`,
  );

  console.log(`═══ Réconciliation status sur ${inboxes.rows.length} inboxes ═══\n`);

  let totalCheckedFront = 0;
  let totalFixed = 0;
  const fixedSamples: { id: string; store: string; oldStatus: string; newStatus: string }[] = [];

  for (const ibx of inboxes.rows) {
    let url: string | null = `/inboxes/${ibx.id}/conversations?q%5Bstatuses%5D%5B%5D=unassigned&q%5Bstatuses%5D%5B%5D=assigned&limit=100`;
    const frontOpenIds: { id: string; status: string }[] = [];
    while (url) {
      const page = await frontFetch(url);
      if (!page) break;
      for (const c of page._results || []) {
        if (c.id && c.status) frontOpenIds.push({ id: c.id, status: c.status });
      }
      url = page._pagination?.next || null;
      await new Promise(r => setTimeout(r, 200)); // anti-429
    }
    totalCheckedFront += frontOpenIds.length;

    if (frontOpenIds.length === 0) {
      console.log(`  ${ibx.store_code} : 0 conv ouverte côté Front`);
      continue;
    }

    // Check BDD : combien sont actuellement marquées 'archived' ?
    const idList = frontOpenIds.map(c => c.id);
    const dbState = await db.query<{ id: string; status: string; archived_at: Date | null }>(
      `SELECT id, status, archived_at FROM sav_conversations WHERE id = ANY($1::text[])`,
      [idList],
    );
    const byId = new Map(dbState.rows.map(r => [r.id, r]));
    const toFix = frontOpenIds.filter(f => {
      const d = byId.get(f.id);
      return d && (d.status === 'archived' || d.archived_at !== null);
    });

    if (toFix.length === 0) {
      console.log(`  ${ibx.store_code} : ${frontOpenIds.length} ouvertes Front, BDD cohérente`);
      continue;
    }

    for (const f of toFix) {
      await db.query(
        `UPDATE sav_conversations
         SET status = $2, archived_at = NULL, synced_at = NOW()
         WHERE id = $1`,
        [f.id, f.status],
      );
      const old = byId.get(f.id)!;
      fixedSamples.push({ id: f.id, store: ibx.store_code, oldStatus: old.status, newStatus: f.status });
      totalFixed++;
    }
    console.log(`  ${ibx.store_code} : ${frontOpenIds.length} ouvertes Front, ${toFix.length} ré-ouvertes en BDD ✓`);
  }

  console.log(`\n═══ FIN ═══`);
  console.log(`  Conv Front ouvertes scannées : ${totalCheckedFront}`);
  console.log(`  Conv ré-ouvertes en BDD      : ${totalFixed}`);
  if (fixedSamples.length > 0) {
    console.log(`\n  Échantillon ré-ouvertes :`);
    for (const s of fixedSamples.slice(0, 20)) {
      console.log(`    ${s.store}  ${s.id}  ${s.oldStatus} → ${s.newStatus}`);
    }
  }

  await db.end();
}

main().catch(e => { console.error('❌ FATAL', e); process.exit(1); });
