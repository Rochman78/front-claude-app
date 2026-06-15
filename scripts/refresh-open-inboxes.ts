#!/usr/bin/env tsx
/**
 * Refresh inbox_id pour toutes les convs non archivées (status='open' ou last_event récent).
 *
 * Pourquoi : Front laisse les conv changer d'inbox via "Move to..." mais notre sync
 * normal (events 48h glissantes) rate les moves sur des convs endormies.
 * Résultat : sav_conversations.inbox_id reste figé sur l'inbox d'origine.
 *
 * Ce script appelle GET /conversations/{id}/inboxes pour chaque conv ouverte et
 * met à jour inbox_id en BDD avec la 1ère inbox boutique active retournée
 * (ou n'importe quelle inbox active si aucune boutique).
 *
 * Usage :
 *   tsx scripts/refresh-open-inboxes.ts
 *   tsx scripts/refresh-open-inboxes.ts --since 2026-06-01   # ne refresh que les conv créées depuis
 *   tsx scripts/refresh-open-inboxes.ts --dry-run            # affiche sans updater
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

const FRONT_API   = 'https://api2.frontapp.com';
const FRONT_TOKEN = process.env.FRONT_API_TOKEN;
const DB_URL      = process.env.DATABASE_URL;
if (!FRONT_TOKEN) { console.error('❌ FRONT_API_TOKEN manquant'); process.exit(1); }
if (!DB_URL)      { console.error('❌ DATABASE_URL manquant');    process.exit(1); }

const args = process.argv.slice(2);
const sinceArg = (() => { const i = args.indexOf('--since'); return i >= 0 ? args[i + 1] : null; })();
const dryRun = args.includes('--dry-run');

const SLEEP = 250;
async function frontFetch(path: string, retries = 5): Promise<any> {
  const url = path.startsWith('http') ? path : `${FRONT_API}${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === retries) throw new Error(`HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, Math.min(30_000, 1000 * Math.pow(2, attempt))));
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (err: any) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, Math.min(30_000, 1000 * Math.pow(2, attempt))));
    }
  }
}

async function main() {
  const db = new Client({
    connectionString: DB_URL,
    ssl: DB_URL!.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();

  // Inboxes actives + boutique
  const activeInboxes = new Set<string>(
    (await db.query(`SELECT id FROM sav_inboxes WHERE is_active = true`)).rows.map(r => r.id)
  );
  const boutiqueInboxes = new Set<string>(
    (await db.query(`SELECT id FROM sav_inboxes WHERE is_active = true AND store_code IS NOT NULL`)).rows.map(r => r.id)
  );
  console.log(`  ${activeInboxes.size} inboxes actives (dont ${boutiqueInboxes.size} boutique)`);

  // Convs open à refresher
  const params: any[] = [];
  let where = `status IS DISTINCT FROM 'archived' AND archived_at IS NULL AND is_noise = false`;
  if (sinceArg) {
    params.push(sinceArg);
    where += ` AND created_at >= $1`;
  }
  const r = await db.query(`SELECT id, inbox_id FROM sav_conversations WHERE ${where} ORDER BY created_at DESC`, params);
  const convs = r.rows as { id: string; inbox_id: string | null }[];
  console.log(`\n  ${convs.length} convs open à refresher${sinceArg ? ` (depuis ${sinceArg})` : ''}${dryRun ? ' [DRY-RUN]' : ''}\n`);

  // Fetch en BDD le status actuel pour comparer
  const r2 = await db.query(`SELECT id, status, archived_at FROM sav_conversations WHERE id = ANY($1::text[])`, [convs.map(c => c.id)]);
  const dbState = new Map<string, { status: string | null; archived_at: Date | null }>();
  for (const row of r2.rows) dbState.set(row.id, { status: row.status, archived_at: row.archived_at });

  let inboxChanged = 0, statusChanged = 0, archivedNow = 0, unchanged = 0, notFound = 0, errors = 0;
  const t0 = Date.now();

  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i];
    try {
      // 1) inboxes
      const inboxRes = await frontFetch(`/conversations/${conv.id}/inboxes`);
      if (!inboxRes) { notFound++; continue; }
      const inboxes = (inboxRes._results || []) as Array<{ id: string }>;
      let nextInbox: string | null = null;
      for (const ibx of inboxes) if (boutiqueInboxes.has(ibx.id)) { nextInbox = ibx.id; break; }
      if (!nextInbox) for (const ibx of inboxes) if (activeInboxes.has(ibx.id)) { nextInbox = ibx.id; break; }
      if (!nextInbox && inboxes.length > 0) nextInbox = inboxes[0].id;

      await new Promise(r => setTimeout(r, SLEEP));

      // 2) status (et archived_at déduit)
      const convRes = await frontFetch(`/conversations/${conv.id}`);
      if (!convRes) { notFound++; continue; }
      const frontStatus: string = convRes.status; // open, archived, deleted, spam, unassigned, assigned…
      const frontUpdatedAt: number | undefined = convRes.updated_at; // unix seconds
      const isArchivedInFront = frontStatus === 'archived' || convRes.status_category === 'archived';

      const cur = dbState.get(conv.id)!;
      const updates: string[] = [];
      const params: any[] = [];
      let pidx = 1;

      if (nextInbox && nextInbox !== conv.inbox_id) {
        updates.push(`inbox_id = $${pidx++}`); params.push(nextInbox);
        inboxChanged++;
      }
      if (frontStatus && frontStatus !== cur.status) {
        updates.push(`status = $${pidx++}`); params.push(frontStatus);
        statusChanged++;
      }
      // Si Front dit archivée et notre archived_at est null → poser l'archived_at (updated_at de Front sinon NOW)
      if (isArchivedInFront && !cur.archived_at) {
        const archAt = frontUpdatedAt ? new Date(frontUpdatedAt * 1000) : new Date();
        updates.push(`archived_at = $${pidx++}`); params.push(archAt);
        archivedNow++;
      }
      // Si Front dit pas archivée et on a un archived_at → reset (cas reopen)
      if (!isArchivedInFront && cur.archived_at) {
        updates.push(`archived_at = NULL`);
      }

      if (updates.length === 0) {
        unchanged++;
      } else {
        if (!dryRun) {
          updates.push(`synced_at = NOW()`);
          params.push(conv.id);
          await db.query(`UPDATE sav_conversations SET ${updates.join(', ')} WHERE id = $${pidx}`, params);
        }
        if (inboxChanged + statusChanged + archivedNow <= 40) {
          console.log(`    ↻ ${conv.id} :${nextInbox !== conv.inbox_id ? ` inbox→${nextInbox}` : ''}${frontStatus !== cur.status ? ` status→${frontStatus}` : ''}${isArchivedInFront && !cur.archived_at ? ` archived` : ''}`);
        }
      }
    } catch (err: any) {
      errors++;
      if (errors <= 5) console.warn(`    ⚠️  ${conv.id} : ${err.message}`);
    }
    await new Promise(r => setTimeout(r, SLEEP));
    if ((i + 1) % 50 === 0) {
      const eta = Math.round((convs.length - i - 1) * (Date.now() - t0) / (i + 1) / 1000);
      console.log(`    ... ${i + 1}/${convs.length} (inbox=${inboxChanged} status=${statusChanged} archived=${archivedNow} errors=${errors})  ETA ~${eta}s`);
    }
  }

  console.log(`\n═══ FIN ═══`);
  console.log(`  Inbox changés      : ${inboxChanged}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`  Status changés     : ${statusChanged}`);
  console.log(`  Nouvellement archi.: ${archivedNow}`);
  console.log(`  Unchanged          : ${unchanged}`);
  console.log(`  404                : ${notFound}`);
  console.log(`  Errors             : ${errors}`);
  console.log(`  Durée              : ${Math.round((Date.now() - t0) / 1000)}s`);

  await db.end();
}

main().catch(e => { console.error('❌ FATAL', e); process.exit(1); });
