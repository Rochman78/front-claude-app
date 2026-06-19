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

  // Convs à refresher :
  //   1. open & cohérentes (status != archived, archived_at IS NULL) — le gros du flow
  //   2. archived récentes < 7j → rattrape les reopen non captés par le webhook
  //   3. incohérentes (status != archived MAIS archived_at NOT NULL, peu importe l'âge)
  //      → Front nous dit qu'elles sont ouvertes mais notre archived_at est périmé
  //      (bug vu 19/06/2026 : 59 conv avec archived_at jusqu'à 2 mois → 18 devis exclus
  //      du dashboard à cause du filtre archived_at IS NULL)
  const params: any[] = [];
  let where = `is_noise = false AND (
    (status IS DISTINCT FROM 'archived' AND archived_at IS NULL)
    OR archived_at > NOW() - INTERVAL '7 days'
    OR (status IS DISTINCT FROM 'archived' AND archived_at IS NOT NULL)
  )`;
  if (sinceArg) {
    params.push(sinceArg);
    where += ` AND created_at >= $1`;
  }
  const r = await db.query(`SELECT id, inbox_id FROM sav_conversations WHERE ${where} ORDER BY created_at DESC`, params);
  const convs = r.rows as { id: string; inbox_id: string | null }[];
  console.log(`\n  ${convs.length} convs open à refresher${sinceArg ? ` (depuis ${sinceArg})` : ''}${dryRun ? ' [DRY-RUN]' : ''}\n`);

  // Fetch en BDD le status actuel pour comparer
  const r2 = await db.query(`SELECT id, status, archived_at, waiting_since FROM sav_conversations WHERE id = ANY($1::text[])`, [convs.map(c => c.id)]);
  const dbState = new Map<string, { status: string | null; archived_at: Date | null; waiting_since: Date | null }>();
  for (const row of r2.rows) dbState.set(row.id, { status: row.status, archived_at: row.archived_at, waiting_since: row.waiting_since });

  let inboxChanged = 0, statusChanged = 0, archivedNow = 0, waitingChanged = 0, tagsAdded = 0, tagsRemoved = 0, unchanged = 0, notFound = 0, errors = 0;
  const t0 = Date.now();

  // Helper : synchronise les tags d'une conv avec ce que Front retourne
  async function syncConvTags(cid: string, frontTags: Array<{ id: string; name?: string }>) {
    if (dryRun) return { added: 0, removed: 0 };
    for (const t of frontTags) {
      await db.query(
        `INSERT INTO sav_tags (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [t.id, t.name || t.id]
      );
    }
    const cur = await db.query<{ tag_id: string }>(
      `SELECT tag_id FROM sav_conversation_tags WHERE conversation_id = $1 AND removed_at IS NULL`,
      [cid]
    );
    const currentIds = new Set(cur.rows.map(r => r.tag_id));
    const frontIds = new Set(frontTags.map(t => t.id));
    let added = 0, removed = 0;
    for (const fId of frontIds) {
      if (!currentIds.has(fId)) {
        await db.query(
          `INSERT INTO sav_conversation_tags (conversation_id, tag_id, applied_at)
           VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
          [cid, fId]
        );
        added++;
      }
    }
    for (const cId of currentIds) {
      if (!frontIds.has(cId)) {
        await db.query(
          `UPDATE sav_conversation_tags SET removed_at = NOW()
           WHERE conversation_id = $1 AND tag_id = $2 AND removed_at IS NULL`,
          [cid, cId]
        );
        removed++;
      }
    }
    return { added, removed };
  }

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
      const frontWaitingSince: number | null = convRes.waiting_since ?? null; // unix seconds (float) ou null
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
      // waiting_since : aligne sur Front (autorité), mais seulement si différent
      // (sinon UPDATE inutile sur ~2600 lignes à chaque run).
      const nextWaiting = frontWaitingSince !== null ? new Date(frontWaitingSince * 1000) : null;
      const curWaiting = cur.waiting_since;
      const waitingDiff = (nextWaiting === null) !== (curWaiting === null)
        || (nextWaiting !== null && curWaiting !== null && nextWaiting.getTime() !== curWaiting.getTime());
      if (waitingDiff) {
        if (nextWaiting !== null) {
          updates.push(`waiting_since = $${pidx++}`);
          params.push(nextWaiting);
        } else {
          updates.push(`waiting_since = NULL`);
        }
        waitingChanged++;
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

      // 3) Synchronise les tags depuis la réponse /conversations/{id}
      const frontTags = Array.isArray(convRes.tags) ? convRes.tags as Array<{ id: string; name?: string }> : [];
      const tagDelta = await syncConvTags(conv.id, frontTags);
      tagsAdded += tagDelta.added;
      tagsRemoved += tagDelta.removed;
      if (tagDelta.added + tagDelta.removed > 0 && tagsAdded + tagsRemoved <= 60) {
        console.log(`    🏷  ${conv.id} : +${tagDelta.added} -${tagDelta.removed} tags (front=${frontTags.map(t => t.name || t.id).join(',') || '∅'})`);
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
  console.log(`  Waiting_since chg. : ${waitingChanged}`);
  console.log(`  Tags ajoutés       : ${tagsAdded}`);
  console.log(`  Tags retirés       : ${tagsRemoved}`);
  console.log(`  Unchanged          : ${unchanged}`);
  console.log(`  404                : ${notFound}`);
  console.log(`  Errors             : ${errors}`);
  console.log(`  Durée              : ${Math.round((Date.now() - t0) / 1000)}s`);

  await db.end();
}

main().catch(e => { console.error('❌ FATAL', e); process.exit(1); });
