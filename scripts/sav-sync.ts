#!/usr/bin/env tsx
/**
 * SAV SYNC V2 — Aspire les données Front API → tables sav_*
 *
 * Usage :
 *   tsx scripts/sav-sync.ts                              # 48h glissantes (mode cron)
 *   tsx scripts/sav-sync.ts --from 2026-05-25 --to 2026-06-10  # backfill explicite
 *   tsx scripts/sav-sync.ts --last-48h                   # idem défaut
 *
 * Stratégie validée 10/06 (après échec sav-sync v1) :
 *   1. /events?q[after]&q[before]  paginé global (≠ /inboxes/{id}/conversations qui ne filtre pas)
 *   2. Filtre côté script par inbox active (les events portent l'inbox dans source.data)
 *   3. Pour chaque message (inbound + out_reply) : fetch /messages/{id} pour author + body + attachments
 *   4. Upsert idempotent (ON CONFLICT DO UPDATE) dans 7 tables
 *   5. Log dans sav_sync_log
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

// ─── Charge .env manuellement ──────────────────────────────────
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

// ─── CLI args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(name: string): boolean { return args.includes(`--${name}`); }

const argFrom = arg('from');
const argTo   = arg('to');
const last48  = hasFlag('last-48h') || (!argFrom && !argTo);

let fromDate: Date, toDate: Date;
if (argFrom && argTo) {
  // Dates Paris (UTC+2 en été) → en UTC pour Front
  fromDate = new Date(`${argFrom}T00:00:00+02:00`);
  toDate   = new Date(`${argTo}T23:59:59+02:00`);
} else {
  // 48h glissantes
  toDate   = new Date();
  fromDate = new Date(toDate.getTime() - 48 * 3600 * 1000);
}

const fromUnix = Math.floor(fromDate.getTime() / 1000);
const toUnix   = Math.floor(toDate.getTime() / 1000);

console.log(`═══ SAV SYNC V2 ═══`);
console.log(`  fenêtre : ${fromDate.toISOString()} → ${toDate.toISOString()}`);
console.log(`  mode    : ${last48 ? '48h glissantes (cron)' : 'backfill manuel'}`);
console.log('');

// ─── DB client ─────────────────────────────────────────────────
const db = new Client({
  connectionString: DB_URL,
  ssl: DB_URL!.includes('render.com') ? { rejectUnauthorized: false } : undefined,
});

// ─── Front API helper ──────────────────────────────────────────
const SLEEP = 250; // ms entre requêtes (anti-429)
async function frontFetch(path: string, retries = 5): Promise<any> {
  const url = path.startsWith('http') ? path : `${FRONT_API}${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(45_000),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === retries) throw new Error(`HTTP ${res.status} après ${retries} retries`);
        const wait = Math.min(30_000, 1000 * Math.pow(2, attempt));
        console.warn(`  ⚠️  ${res.status} → retry ${attempt + 1}/${retries} dans ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (err: any) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, Math.min(30_000, 1000 * Math.pow(2, attempt))));
    }
  }
}

async function frontPaginate(path: string, label: string): Promise<any[]> {
  const items: any[] = [];
  let url: string | undefined = path;
  let page = 0;
  const t0 = Date.now();
  while (url) {
    page++;
    try {
      const d = await frontFetch(url);
      items.push(...(d._results || []));
      url = d._pagination?.next;
    } catch (e: any) {
      console.warn(`  ⚠️  ${label} page ${page} échec (${e.message.slice(0, 80)}) — on garde ${items.length}`);
      break;
    }
    await new Promise(r => setTimeout(r, SLEEP));
    if (page % 50 === 0) console.log(`    ... ${label} page ${page} | ${items.length} items | ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  return items;
}

// ─── Helpers ───────────────────────────────────────────────────
function tsToIso(unix: number | undefined | null): string | null {
  if (!unix) return null;
  return new Date(unix * 1000).toISOString();
}

let totals = {
  events_seen: 0, conversations_upserted: 0,
  messages_upserted: 0, comments_upserted: 0,
  events_upserted: 0, attachments_upserted: 0,
  tags_links_upserted: 0, assignees_links_upserted: 0,
  errors: 0,
};
const errorDetails: any[] = [];

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  await db.connect();

  // Sync log start
  const r = await db.query(`INSERT INTO sav_sync_log (started_at, status) VALUES (NOW(), 'in_progress') RETURNING id`);
  const syncLogId = r.rows[0].id;
  const startMs = Date.now();

  // Référentiels en cache
  const activeInboxIds = new Set<string>(
    (await db.query(`SELECT id FROM sav_inboxes WHERE is_active = true`)).rows.map(r => r.id)
  );
  console.log(`  ${activeInboxIds.size} inboxes actives`);

  // ─── Phase 1 : fetch events ────────────────────────────────
  console.log('\n━━━ Phase 1 : fetch /events ━━━');
  const allEvents = await frontPaginate(
    `/events?q[after]=${fromUnix}&q[before]=${toUnix}&limit=100`,
    'events'
  );
  totals.events_seen = allEvents.length;
  console.log(`  ✓ ${allEvents.length} events fetched`);

  // ⚠️ PAS de filtre côté script. La V1 filtrait sur source.data.id qui contient
  // souvent des inbox de ROUTING (ex: inb_ftot3 Zephyr O.S.C interne) et non l'inbox
  // de la conv. Du coup on jetait 27% des inbound légitimes.
  // On garde TOUT en BDD. Le filtrage par boutique se fait à l'usage via
  // sav_conversations.inbox_id (qui pointe la VRAIE inbox de la conv).
  const filteredEvents = allEvents;
  console.log(`  ${filteredEvents.length} events conservés (aucun filtre source)`);

  // ─── Phase 2 : extraire conv_ids + msg_ids ────────────────
  console.log('\n━━━ Phase 2 : extraction conv_ids + msg_ids ━━━');
  const convIds = new Set<string>();
  const msgIds = new Set<string>(); // out_reply ET inbound
  for (const e of filteredEvents) {
    const cid = e.conversation?.id;
    if (cid) convIds.add(cid);
    if (e.type === 'out_reply' || e.type === 'inbound') {
      const mid = e.target?.data?.id;
      if (mid) msgIds.add(mid);
    }
  }
  console.log(`  ${convIds.size} conversations distinctes, ${msgIds.size} messages à fetcher`);

  // ─── Phase 3 : fetch détails messages (pour author + body + attachments) ──
  console.log('\n━━━ Phase 3 : fetch /messages ━━━');
  const msgDetail = new Map<string, any>();
  const msgArray = Array.from(msgIds);
  for (let i = 0; i < msgArray.length; i++) {
    const mid = msgArray[i];
    try {
      const m = await frontFetch(`/messages/${mid}`);
      msgDetail.set(mid, m);
    } catch (e: any) {
      errorDetails.push({ msg_id: mid, step: 'fetch_msg', err: e.message });
      totals.errors++;
    }
    await new Promise(r => setTimeout(r, SLEEP));
    if ((i + 1) % 100 === 0) console.log(`    ... ${i + 1}/${msgArray.length}`);
  }
  console.log(`  ✓ ${msgDetail.size}/${msgArray.length} messages récupérés`);

  // ─── Phase 4 : upsert dans BDD ─────────────────────────────
  console.log('\n━━━ Phase 4 : upsert BDD ━━━');

  // 4.a Upsert conversations (depuis les events qui les référencent)
  // On garde la "dernière" version vue de chaque conv (info dans event.conversation)
  const convData = new Map<string, any>();
  for (const e of filteredEvents) {
    const cid = e.conversation?.id;
    if (cid) convData.set(cid, e.conversation); // dernière vue gagne
  }
  console.log(`  Upsert ${convData.size} conversations...`);
  let i = 0;
  for (const [cid, conv] of convData.entries()) {
    i++;
    const recipient = conv.recipient || {};
    // Trouver inbox de la conv (depuis events liés)
    let convInboxId: string | null = null;
    for (const e of filteredEvents) {
      if (e.conversation?.id !== cid) continue;
      const data = e.source?.data;
      if (Array.isArray(data)) {
        const ibx = data.find((it: any) => it?.id?.startsWith?.('inb_'));
        if (ibx) { convInboxId = ibx.id; break; }
      } else if (data?.id?.startsWith?.('inb_')) {
        convInboxId = data.id; break;
      }
    }
    try {
      await db.query(`
        INSERT INTO sav_conversations (
          id, inbox_id, subject, status, customer_email, customer_name, synced_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (id) DO UPDATE SET
          inbox_id = COALESCE(EXCLUDED.inbox_id, sav_conversations.inbox_id),
          subject = EXCLUDED.subject,
          status = EXCLUDED.status,
          customer_email = COALESCE(EXCLUDED.customer_email, sav_conversations.customer_email),
          customer_name = COALESCE(EXCLUDED.customer_name, sav_conversations.customer_name),
          synced_at = NOW()
      `, [
        cid, convInboxId, conv.subject || '', conv.status || null,
        recipient.handle || null, recipient.name || null,
      ]);
      totals.conversations_upserted++;
    } catch (e: any) {
      errorDetails.push({ conv_id: cid, step: 'upsert_conv', err: e.message });
      totals.errors++;
    }
    if (i % 500 === 0) console.log(`    ... conversations ${i}/${convData.size}`);
  }

  // 4.b Upsert messages (depuis msgDetail) + attachments
  console.log(`  Upsert ${msgDetail.size} messages + attachments...`);
  i = 0;
  for (const [mid, m] of msgDetail.entries()) {
    i++;
    const cid = m.conversation?.id || m._links?.related?.conversation?.split('/').pop();
    if (!cid) continue;
    const isInbound = m.is_inbound === true;
    const authorId = isInbound ? null : (m.author?.id || null);
    const authorEmail = (m.recipients || []).find((r: any) => r.role === 'from')?.handle
                     || m.author?.email || null;
    try {
      await db.query(`
        INSERT INTO sav_messages (
          id, conversation_id, direction, author_email, author_teammate_id,
          created_at, body_text, body_html, text_length, has_attachments, attachment_count, is_draft
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO UPDATE SET
          direction = EXCLUDED.direction, author_email = EXCLUDED.author_email,
          author_teammate_id = EXCLUDED.author_teammate_id, created_at = EXCLUDED.created_at,
          body_text = EXCLUDED.body_text, body_html = EXCLUDED.body_html,
          text_length = EXCLUDED.text_length, has_attachments = EXCLUDED.has_attachments,
          attachment_count = EXCLUDED.attachment_count, is_draft = EXCLUDED.is_draft
      `, [
        mid, cid, isInbound ? 'in' : 'out', authorEmail, authorId,
        tsToIso(m.created_at), m.text || '', m.body || '',
        (m.text || '').length, (m.attachments || []).length > 0, (m.attachments || []).length, !!m.is_draft,
      ]);
      totals.messages_upserted++;

      for (const a of (m.attachments || [])) {
        try {
          await db.query(`
            INSERT INTO sav_attachments (id, message_id, filename, content_type, size_bytes, is_inline, metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (id) DO UPDATE SET
              filename = EXCLUDED.filename, content_type = EXCLUDED.content_type,
              size_bytes = EXCLUDED.size_bytes, is_inline = EXCLUDED.is_inline,
              metadata = EXCLUDED.metadata
          `, [
            a.id, mid, a.filename || '', a.content_type || '', a.size || 0,
            !!(a.metadata?.is_inline), JSON.stringify(a.metadata || {}),
          ]);
          totals.attachments_upserted++;
        } catch (e: any) {
          errorDetails.push({ att_id: a.id, step: 'upsert_att', err: e.message });
          totals.errors++;
        }
      }
    } catch (e: any) {
      errorDetails.push({ msg_id: mid, step: 'upsert_msg', err: e.message });
      totals.errors++;
    }
    if (i % 500 === 0) console.log(`    ... messages ${i}/${msgDetail.size}`);
  }

  // 4.c Upsert events
  console.log(`  Upsert ${filteredEvents.length} events...`);
  i = 0;
  for (const e of filteredEvents) {
    i++;
    const cid = e.conversation?.id;
    if (!cid) continue;
    const src = e.source || {};
    const srcType = src._meta?.type;
    const actorId = srcType === 'teammate' ? src.data?.id : null;
    let targetTeammateId: string | null = null;
    let tagId: string | null = null;
    if ((e.type === 'assign' || e.type === 'unassign') && e.target?.data?.id?.startsWith('tea_')) {
      targetTeammateId = e.target.data.id;
    }
    if ((e.type === 'tag' || e.type === 'untag') && e.target?.data?.id?.startsWith('tag_')) {
      tagId = e.target.data.id;
    }
    try {
      // Events généraux (archive/assign/tag/etc.) — out_reply et inbound et comment ont leur table dédiée
      if (e.type !== 'inbound' && e.type !== 'out_reply' && e.type !== 'comment') {
        await db.query(`
          INSERT INTO sav_events (id, conversation_id, type, actor_teammate_id, target_teammate_id, tag_id, created_at, meta)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type, actor_teammate_id = EXCLUDED.actor_teammate_id,
            target_teammate_id = EXCLUDED.target_teammate_id, tag_id = EXCLUDED.tag_id,
            created_at = EXCLUDED.created_at, meta = EXCLUDED.meta
        `, [
          e.id, cid, e.type, actorId, targetTeammateId, tagId,
          tsToIso(e.emitted_at || e.created_at), JSON.stringify(src._meta || {}),
        ]);
        totals.events_upserted++;
      }

      // Comments inline (Front les expose dans /events type=comment)
      if (e.type === 'comment' && actorId) {
        // body du comment n'est pas dans l'event… on devrait fetch /comments/{id} mais c'est lourd.
        // Pour V1 : on stocke quand même l'event avec body vide (l'event a un id distinct du comment)
        // Le comment_id réel est dans target.data.id
        const cmtId = e.target?.data?.id || `cmt-from-evt-${e.id}`;
        await db.query(`
          INSERT INTO sav_comments (id, conversation_id, author_teammate_id, body_text, created_at)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (id) DO UPDATE SET
            author_teammate_id = EXCLUDED.author_teammate_id,
            body_text = EXCLUDED.body_text,
            created_at = EXCLUDED.created_at
        `, [
          cmtId, cid, actorId, '', tsToIso(e.emitted_at || e.created_at),
        ]);
        totals.comments_upserted++;
      }

      // Lien conversation_tags
      if (e.type === 'tag' && tagId) {
        await db.query(`
          INSERT INTO sav_conversation_tags (conversation_id, tag_id, applied_at, applied_by_teammate_id)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (conversation_id, tag_id, applied_at) DO NOTHING
        `, [cid, tagId, tsToIso(e.emitted_at || e.created_at), actorId]);
        totals.tags_links_upserted++;
      }

      // Lien assignees_history
      if (e.type === 'assign' && targetTeammateId) {
        await db.query(`
          INSERT INTO sav_conversation_assignees_history (conversation_id, teammate_id, assigned_at)
          VALUES ($1,$2,$3)
          ON CONFLICT (conversation_id, teammate_id, assigned_at) DO NOTHING
        `, [cid, targetTeammateId, tsToIso(e.emitted_at || e.created_at)]);
        totals.assignees_links_upserted++;
      }
    } catch (e2: any) {
      errorDetails.push({ event_id: e.id, step: 'upsert_event', err: e2.message });
      totals.errors++;
    }
    if (i % 1000 === 0) console.log(`    ... events ${i}/${filteredEvents.length}`);
  }

  // ─── Phase 5 : post-traitement (timestamps + compteurs sur sav_conversations) ──
  // Calcule depuis les messages/events les agrégats utiles aux requêtes reporting.
  // Idempotent (on peut le rejouer, il recalcule depuis 0 par conv).
  console.log(`\n━━━ Phase 5 : post-traitement timestamps ━━━`);
  await db.query(`
    UPDATE sav_conversations c
    SET
      created_at = COALESCE(stats.first_msg_at, c.created_at),
      first_inbound_at = stats.first_in_at,
      first_outbound_at = stats.first_out_at,
      last_inbound_at = stats.last_in_at,
      last_outbound_at = stats.last_out_at,
      total_inbound_messages = stats.in_count,
      total_outbound_messages = stats.out_count,
      response_time_seconds = CASE
        WHEN stats.first_in_at IS NOT NULL AND stats.first_out_at IS NOT NULL
             AND stats.first_out_at > stats.first_in_at
        THEN EXTRACT(EPOCH FROM (stats.first_out_at - stats.first_in_at))::INT
        ELSE NULL
      END
    FROM (
      SELECT conversation_id,
        MIN(created_at) AS first_msg_at,
        MIN(created_at) FILTER (WHERE direction='in')  AS first_in_at,
        MIN(created_at) FILTER (WHERE direction='out') AS first_out_at,
        MAX(created_at) FILTER (WHERE direction='in')  AS last_in_at,
        MAX(created_at) FILTER (WHERE direction='out') AS last_out_at,
        COUNT(*) FILTER (WHERE direction='in')  AS in_count,
        COUNT(*) FILTER (WHERE direction='out') AS out_count
      FROM sav_messages
      WHERE conversation_id = ANY($1::text[])
      GROUP BY conversation_id
    ) stats
    WHERE c.id = stats.conversation_id
  `, [Array.from(convData.keys())]);

  await db.query(`
    UPDATE sav_conversations c
    SET total_comments = sub.cnt
    FROM (SELECT conversation_id, COUNT(*) AS cnt
          FROM sav_comments
          WHERE conversation_id = ANY($1::text[])
          GROUP BY conversation_id) sub
    WHERE c.id = sub.conversation_id
  `, [Array.from(convData.keys())]);

  await db.query(`
    UPDATE sav_conversations c
    SET
      archived_at = arc.archived_at,
      archived_by_teammate_id = arc.actor_teammate_id
    FROM (
      SELECT DISTINCT ON (conversation_id) conversation_id,
             created_at AS archived_at,
             actor_teammate_id
      FROM sav_events
      WHERE type = 'archive'
        AND conversation_id = ANY($1::text[])
      ORDER BY conversation_id, created_at ASC
    ) arc
    WHERE c.id = arc.conversation_id
  `, [Array.from(convData.keys())]);
  console.log(`  ✓ Post-traitement terminé`);

  // ─── Phase 6 : log sav_sync_log ───────────────────────────
  const duration = Math.round((Date.now() - startMs) / 1000);
  await db.query(`
    UPDATE sav_sync_log SET finished_at=NOW(), status=$1, duration_seconds=$2,
      conversations_seen=$3, conversations_upserted=$4, messages_upserted=$5,
      comments_upserted=$6, events_upserted=$7, errors_count=$8, error_details=$9
    WHERE id=$10
  `, [
    totals.errors === 0 ? 'success' : 'partial',
    duration,
    convData.size,
    totals.conversations_upserted,
    totals.messages_upserted,
    totals.comments_upserted,
    totals.events_upserted,
    totals.errors,
    JSON.stringify(errorDetails.slice(0, 100)),
    syncLogId,
  ]);

  console.log(`\n═══ TERMINÉ en ${duration}s ═══`);
  console.log(`  Events vus               : ${totals.events_seen}`);
  console.log(`  Conversations upsertées  : ${totals.conversations_upserted}`);
  console.log(`  Messages upsertés        : ${totals.messages_upserted}`);
  console.log(`  Comments upsertés        : ${totals.comments_upserted}`);
  console.log(`  Events upsertés          : ${totals.events_upserted}`);
  console.log(`  Attachments upsertés     : ${totals.attachments_upserted}`);
  console.log(`  Tags-links upsertés      : ${totals.tags_links_upserted}`);
  console.log(`  Assignees-links upsertés : ${totals.assignees_links_upserted}`);
  console.log(`  Erreurs                  : ${totals.errors}`);

  await db.end();
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  try {
    await db.query(`UPDATE sav_sync_log SET status='failed', finished_at=NOW(), error_details=$1 WHERE finished_at IS NULL`, [JSON.stringify([{ fatal: String(e) }])]);
  } catch {}
  await db.end().catch(() => {});
  process.exit(1);
});
