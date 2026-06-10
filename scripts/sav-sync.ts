#!/usr/bin/env tsx
/**
 * SAV SYNC — Aspire les données Front API → tables sav_*
 *
 * Usage :
 *   tsx scripts/sav-sync.ts                       # sync 7 derniers jours (défaut)
 *   tsx scripts/sav-sync.ts --days 1              # sync 1 dernier jour
 *   tsx scripts/sav-sync.ts --from 2026-06-02 --to 2026-06-09
 *   tsx scripts/sav-sync.ts --inbox LFC           # une seule boutique
 *   tsx scripts/sav-sync.ts --dry-run             # ne touche pas la BDD
 *
 * Étapes par inbox :
 *   1. Liste les conversations de la fenêtre (paginé)
 *   2. Pour chaque conv : fetch messages + comments + events
 *   3. Calcule les champs dérivés (first_inbound_at, response_time, etc.)
 *   4. Upsert dans toutes les tables (idempotent)
 *   5. Log dans sav_sync_log
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

// Charge .env manuellement (évite dépendance dotenv)
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

const days  = parseInt(arg('days') || '7', 10);
const from  = arg('from');
const to    = arg('to');
const onlyInbox = arg('inbox');
const dryRun = hasFlag('dry-run');

const now = new Date();
const fromDate = from ? new Date(from) : new Date(now.getTime() - days * 86400000);
const toDate   = to   ? new Date(to)   : now;

console.log(`═══ SAV SYNC ═══`);
console.log(`  fenêtre : ${fromDate.toISOString()} → ${toDate.toISOString()}`);
console.log(`  inbox   : ${onlyInbox || 'TOUTES actives'}`);
console.log(`  dry-run : ${dryRun}`);
console.log('');

// ─── Front API helper avec retry exponentiel borné ─────────────
// 3 retries max sur 429/5xx, exponentiel 1s/2s/4s. Au-delà on throw → l'appelant décide.
async function frontFetch(path: string, retries = 3): Promise<any> {
  const url = path.startsWith('http') ? path : `${FRONT_API}${path}`;
  let lastErr: string = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
        // Timeout 45s — sans ça, une requête lente Front bloque toute la sync indéfiniment
        signal: AbortSignal.timeout(45_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `${res.status}`;
        if (attempt === retries) break;
        const wait = 1000 * Math.pow(2, attempt);
        console.warn(`  ⚠️  ${res.status} sur ${path.slice(0, 80)} → retry ${attempt + 1}/${retries} dans ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Front API ${res.status} sur ${path}: ${(await res.text()).slice(0, 200)}`);
      }
      return await res.json();
    } catch (err: any) {
      lastErr = err.message || String(err);
      if (attempt === retries) break;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw new Error(`Front API échec définitif après ${retries + 1} tentatives sur ${path.slice(0, 100)} : ${lastErr}`);
}

// Pagination : si une page intermédiaire échoue, on log et on retourne ce qu'on a.
// Évite que toute la sync se bloque sur 1 page foireuse de Front.
async function frontFetchAll(path: string, label: string = ''): Promise<any[]> {
  const items: any[] = [];
  let url: string | undefined = path;
  let pageNum = 0;
  while (url) {
    pageNum++;
    const t0 = Date.now();
    process.stdout.write(`    [fetch p${pageNum}${label ? ' ' + label : ''}] start...\n`);
    try {
      const d = await frontFetch(url);
      const got = (d._results || []).length;
      items.push(...(d._results || []));
      url = d._pagination?.next;
      process.stdout.write(`    [fetch p${pageNum}${label ? ' ' + label : ''}] ok +${got} items in ${Date.now() - t0}ms${url ? ' (next page)' : ' (last)'}\n`);
    } catch (err: any) {
      process.stdout.write(`  ⚠️  pagination${label ? ' ' + label : ''} : page ${pageNum} a échoué après ${Date.now() - t0}ms (${err.message.slice(0, 150)}) — on continue avec ${items.length} items déjà récupérés\n`);
      break;
    }
  }
  return items;
}

// ─── DB helper ─────────────────────────────────────────────────
const db = new Client({
  connectionString: DB_URL,
  ssl: DB_URL!.includes('render.com') ? { rejectUnauthorized: false } : undefined,
});

async function q(sql: string, params: any[] = []): Promise<any[]> {
  if (dryRun && /^(INSERT|UPDATE|DELETE)/i.test(sql.trim())) return [];
  const r = await db.query(sql, params);
  return r.rows;
}

// ─── Helpers de transformation ─────────────────────────────────
function tsToIso(unix: number | undefined | null): string | null {
  if (!unix) return null;
  return new Date(unix * 1000).toISOString();
}

function detectLanguage(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase().slice(0, 500);
  // Mots-clés simples (suffisant pour démarrer, on raffinera avec Claude plus tard si besoin)
  if (/\b(bonjour|merci|cordialement|filet|devis)\b/.test(lower)) return 'FR';
  if (/\b(hallo|guten|danke|tarnnetz|bestellung)\b/.test(lower)) return 'DE';
  if (/\b(goedendag|hartelijk|camouflagenet|bestelling)\b/.test(lower)) return 'NL';
  if (/\b(hola|gracias|saludos|red de camuflaje|pedido)\b/.test(lower)) return 'ES';
  if (/\b(buongiorno|grazie|saluti|rete mimetica|ordine)\b/.test(lower)) return 'IT';
  if (/\b(hello|thanks|regards|order|please)\b/.test(lower)) return 'EN';
  return null;
}

function detectCountry(language: string | null, customerEmail: string | null): string | null {
  if (!language) return null;
  const map: Record<string, string> = { FR: 'FR', DE: 'DE', NL: 'NL', ES: 'ES', IT: 'IT', EN: 'GB' };
  return map[language] || null;
}

function isNoise(subject: string, body: string, senderEmail: string | null): boolean {
  const text = `${subject || ''} ${body || ''}`.toLowerCase();
  if (!text.trim()) return true;
  if (/no-?reply|newsletter|notification|automated/i.test(senderEmail || '')) return true;
  if (text.length < 30 && /^(test|ok|merci|thanks)$/i.test(text.trim())) return true;
  return false;
}

function computeBusinessSeconds(fromIso: string, toIso: string, holidays: Set<string>): number {
  // Heures ouvrées : 8h30 → 17h30, Lun-Ven, hors fériés (32 400 secondes/jour ouvré)
  const start = new Date(fromIso);
  const end   = new Date(toIso);
  if (end <= start) return 0;
  const businessSecondsPerDay = 9 * 3600;
  const isBusinessDay = (d: Date) => {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return false;
    const iso = d.toISOString().slice(0, 10);
    return !holidays.has(iso);
  };
  const businessStartHour = 8.5;
  const businessEndHour   = 17.5;
  const secondsInDay = (d: Date) => {
    if (!isBusinessDay(d)) return 0;
    const dayStart = new Date(d); dayStart.setUTCHours(Math.floor(businessStartHour), (businessStartHour % 1) * 60, 0, 0);
    const dayEnd   = new Date(d); dayEnd.setUTCHours(Math.floor(businessEndHour),   (businessEndHour % 1) * 60, 0, 0);
    return Math.max(0, (dayEnd.getTime() - dayStart.getTime()) / 1000);
  };
  // Approximation : on compte les jours ouvrés entiers entre les bornes, + fragments aux bornes
  let cur = new Date(start);
  let total = 0;
  while (cur < end) {
    const nextDay = new Date(cur); nextDay.setUTCHours(24, 0, 0, 0);
    const segEnd = nextDay < end ? nextDay : end;
    if (isBusinessDay(cur)) {
      const dayStart = new Date(cur); dayStart.setUTCHours(Math.floor(businessStartHour), (businessStartHour % 1) * 60, 0, 0);
      const dayEnd   = new Date(cur); dayEnd.setUTCHours(Math.floor(businessEndHour),   (businessEndHour % 1) * 60, 0, 0);
      const s = cur < dayStart ? dayStart : cur;
      const e = segEnd > dayEnd ? dayEnd : segEnd;
      if (e > s) total += (e.getTime() - s.getTime()) / 1000;
    }
    cur = nextDay;
  }
  return Math.round(total);
}

// ─── Sync principal ────────────────────────────────────────────
let totals = {
  conversations_seen: 0,
  conversations_upserted: 0,
  messages_upserted: 0,
  comments_upserted: 0,
  events_upserted: 0,
  attachments_upserted: 0,
  errors: 0,
};
const errorDetails: any[] = [];

async function syncConversation(conv: any, inboxId: string, storeCode: string, holidays: Set<string>) {
  const convId = conv.id;
  totals.conversations_seen++;

  // Messages
  let messages: any[] = [];
  try {
    messages = await frontFetchAll(`/conversations/${convId}/messages`);
  } catch (e: any) {
    errorDetails.push({ conv: convId, step: 'messages', err: e.message });
    totals.errors++;
    return;
  }
  messages.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

  // Comments
  let comments: any[] = [];
  try {
    comments = await frontFetchAll(`/conversations/${convId}/comments`);
  } catch (e: any) {
    errorDetails.push({ conv: convId, step: 'comments', err: e.message });
    totals.errors++;
  }

  // Events
  let events: any[] = [];
  try {
    events = await frontFetchAll(`/conversations/${convId}/events?limit=100`);
  } catch (e: any) {
    errorDetails.push({ conv: convId, step: 'events', err: e.message });
    totals.errors++;
  }

  // Champs dérivés
  const firstMsg = messages[0];
  const firstInbound  = messages.find(m => m.is_inbound === true);
  const firstOutbound = messages.find(m => m.is_inbound === false);
  const lastInbound   = [...messages].reverse().find(m => m.is_inbound === true);
  const lastOutbound  = [...messages].reverse().find(m => m.is_inbound === false);

  const createdAt        = tsToIso(firstMsg?.created_at);
  const firstInboundAt   = tsToIso(firstInbound?.created_at);
  const firstOutboundAt  = tsToIso(firstOutbound?.created_at);
  const lastInboundAt    = tsToIso(lastInbound?.created_at);
  const lastOutboundAt   = tsToIso(lastOutbound?.created_at);
  const lastEventAt      = events.length > 0
    ? tsToIso(events[events.length - 1].emitted_at || events[events.length - 1].created_at)
    : null;

  const archiveEvent = events.find(e => e.type === 'archive');
  const archivedAt   = archiveEvent ? tsToIso(archiveEvent.emitted_at || archiveEvent.created_at) : null;
  const archivedBy   = archiveEvent?.source?.data?.id || null;

  let responseTimeSec: number | null = null;
  let responseTimeBusSec: number | null = null;
  if (firstInboundAt && firstOutboundAt && firstOutboundAt > firstInboundAt) {
    responseTimeSec = Math.round((new Date(firstOutboundAt).getTime() - new Date(firstInboundAt).getTime()) / 1000);
    responseTimeBusSec = computeBusinessSeconds(firstInboundAt, firstOutboundAt, holidays);
  }
  const isWithinSla = responseTimeBusSec !== null ? responseTimeBusSec < 24 * 3600 : null;

  // Détection langue + pays + bruit (depuis le 1er msg client)
  const firstInboundBody = firstInbound?.text || firstInbound?.body || '';
  const language = detectLanguage(firstInboundBody);
  const customerEmail = firstInbound?.recipients?.find((r: any) => r.role === 'from')?.handle
                    || (typeof firstInbound?.from === 'string' ? firstInbound.from : null);
  const customerName  = firstInbound?.recipients?.find((r: any) => r.role === 'from')?.name || null;
  const customerCountry = detectCountry(language, customerEmail);
  const noise = isNoise(conv.subject || '', firstInboundBody, customerEmail);

  const assigneeId = conv.assignee?.id || null;

  // Upsert conversation
  const inboundCount  = messages.filter(m => m.is_inbound === true).length;
  const outboundCount = messages.filter(m => m.is_inbound === false).length;

  await q(`
    INSERT INTO sav_conversations (
      id, inbox_id, store_code, subject, status, assignee_id, language,
      customer_email, customer_name, customer_country,
      created_at, first_inbound_at, first_outbound_at,
      last_inbound_at, last_outbound_at, last_event_at,
      archived_at, archived_by_teammate_id,
      response_time_seconds, response_time_business_seconds, is_within_sla, is_noise,
      total_inbound_messages, total_outbound_messages, total_comments, total_events,
      synced_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      inbox_id=EXCLUDED.inbox_id, store_code=EXCLUDED.store_code, subject=EXCLUDED.subject,
      status=EXCLUDED.status, assignee_id=EXCLUDED.assignee_id, language=EXCLUDED.language,
      customer_email=EXCLUDED.customer_email, customer_name=EXCLUDED.customer_name, customer_country=EXCLUDED.customer_country,
      created_at=EXCLUDED.created_at, first_inbound_at=EXCLUDED.first_inbound_at, first_outbound_at=EXCLUDED.first_outbound_at,
      last_inbound_at=EXCLUDED.last_inbound_at, last_outbound_at=EXCLUDED.last_outbound_at, last_event_at=EXCLUDED.last_event_at,
      archived_at=EXCLUDED.archived_at, archived_by_teammate_id=EXCLUDED.archived_by_teammate_id,
      response_time_seconds=EXCLUDED.response_time_seconds, response_time_business_seconds=EXCLUDED.response_time_business_seconds,
      is_within_sla=EXCLUDED.is_within_sla, is_noise=EXCLUDED.is_noise,
      total_inbound_messages=EXCLUDED.total_inbound_messages, total_outbound_messages=EXCLUDED.total_outbound_messages,
      total_comments=EXCLUDED.total_comments, total_events=EXCLUDED.total_events,
      synced_at=NOW()
  `, [
    convId, inboxId, storeCode, conv.subject || '', conv.status || 'unassigned', assigneeId, language,
    customerEmail, customerName, customerCountry,
    createdAt, firstInboundAt, firstOutboundAt,
    lastInboundAt, lastOutboundAt, lastEventAt,
    archivedAt, archivedBy,
    responseTimeSec, responseTimeBusSec, isWithinSla, noise,
    inboundCount, outboundCount, comments.length, events.length
  ]);
  totals.conversations_upserted++;

  // Upsert messages
  for (const m of messages) {
    const authorTeammate = m.is_inbound ? null : (m.author?.id || null);
    const authorEmail    = m.recipients?.find((r: any) => r.role === 'from')?.handle
                        || (typeof m.author?.email === 'string' ? m.author.email : null);
    const body = m.text || '';
    const html = m.body || '';
    const hasAtt = (m.attachments || []).length > 0;
    await q(`
      INSERT INTO sav_messages (id, conversation_id, direction, author_email, author_teammate_id,
        created_at, body_text, body_html, text_length, has_attachments, attachment_count, is_draft)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        direction=EXCLUDED.direction, author_email=EXCLUDED.author_email,
        author_teammate_id=EXCLUDED.author_teammate_id, created_at=EXCLUDED.created_at,
        body_text=EXCLUDED.body_text, body_html=EXCLUDED.body_html,
        text_length=EXCLUDED.text_length, has_attachments=EXCLUDED.has_attachments,
        attachment_count=EXCLUDED.attachment_count, is_draft=EXCLUDED.is_draft
    `, [
      m.id, convId, m.is_inbound ? 'in' : 'out', authorEmail, authorTeammate,
      tsToIso(m.created_at), body, html, body.length, hasAtt, (m.attachments || []).length, !!m.is_draft
    ]);
    totals.messages_upserted++;

    // Attachments
    for (const a of (m.attachments || [])) {
      await q(`
        INSERT INTO sav_attachments (id, message_id, filename, content_type, size_bytes, is_inline, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET
          filename=EXCLUDED.filename, content_type=EXCLUDED.content_type,
          size_bytes=EXCLUDED.size_bytes, is_inline=EXCLUDED.is_inline, metadata=EXCLUDED.metadata
      `, [
        a.id, m.id, a.filename || '', a.content_type || '', a.size || 0,
        !!(a.metadata?.is_inline), JSON.stringify(a.metadata || {})
      ]);
      totals.attachments_upserted++;
    }
  }

  // Upsert comments
  for (const c of comments) {
    await q(`
      INSERT INTO sav_comments (id, conversation_id, author_teammate_id, body_text, created_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET
        author_teammate_id=EXCLUDED.author_teammate_id, body_text=EXCLUDED.body_text, created_at=EXCLUDED.created_at
    `, [
      c.id, convId, c.author?.id || null, c.body || '', tsToIso(c.posted_at || c.created_at)
    ]);
    totals.comments_upserted++;
  }

  // Upsert events
  for (const e of events) {
    const actor = e.source?.data?.id && e.source?._meta?.type === 'teammate' ? e.source.data.id : null;
    let target: string | null = null;
    let tagId: string | null = null;
    if (e.type === 'assign' || e.type === 'unassign') {
      target = e.target?.data?.id || null;
    } else if (e.type === 'tag' || e.type === 'untag') {
      tagId = e.target?.data?.id || null;
    }
    await q(`
      INSERT INTO sav_events (id, conversation_id, type, actor_teammate_id, target_teammate_id, tag_id, created_at, meta)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET
        type=EXCLUDED.type, actor_teammate_id=EXCLUDED.actor_teammate_id,
        target_teammate_id=EXCLUDED.target_teammate_id, tag_id=EXCLUDED.tag_id,
        created_at=EXCLUDED.created_at, meta=EXCLUDED.meta
    `, [
      e.id, convId, e.type, actor, target, tagId,
      tsToIso(e.emitted_at || e.created_at), JSON.stringify(e._meta || {})
    ]);
    totals.events_upserted++;
  }
}

async function main() {
  await db.connect();

  // Sync log start
  let syncLogId: number | null = null;
  if (!dryRun) {
    const r = await db.query(
      `INSERT INTO sav_sync_log (started_at, status) VALUES (NOW(), 'in_progress') RETURNING id`
    );
    syncLogId = r.rows[0].id;
  }
  const startTime = Date.now();

  // Holidays en mémoire
  const hRows = (await db.query(`SELECT date FROM sav_holidays`)).rows;
  const holidays = new Set<string>(hRows.map(r => r.date.toISOString().slice(0, 10)));
  console.log(`  ${holidays.size} jours fériés chargés`);

  // Inboxes actives
  const where = onlyInbox
    ? `WHERE store_code = $1 AND is_active = true`
    : `WHERE is_active = true`;
  const ibxs = (await db.query(
    `SELECT id, store_code, name FROM sav_inboxes ${where} ORDER BY store_code`,
    onlyInbox ? [onlyInbox] : []
  )).rows;
  console.log(`  ${ibxs.length} inboxes actives à traiter\n`);

  const fromUnix = Math.floor(fromDate.getTime() / 1000);
  const toUnix   = Math.floor(toDate.getTime() / 1000);

  for (const ibx of ibxs) {
    console.log(`━━━ ${ibx.store_code} (${ibx.name}) ━━━`);
    const ibxStart = Date.now();

    // STRATÉGIE : on liste les EVENTS de la fenêtre (filtre date qui marche
    // vraiment côté Front), on extrait les conversation.id uniques, et on
    // sync UNIQUEMENT ces convs ciblées. Évite de fetcher 4000+ convs
    // historiques inutiles (cas vu sur LFC avec /inboxes/{id}/conversations).
    const eventsQuery = `q[after]=${fromUnix}&q[before]=${toUnix}&q[source_id]=${ibx.id}&limit=100`;
    let events: any[] = [];
    try {
      events = await frontFetchAll(`/events?${eventsQuery}`, `events ${ibx.store_code}`);
    } catch (e: any) {
      console.error(`  ❌ liste events : ${e.message}`);
      errorDetails.push({ inbox: ibx.store_code, step: 'list-events', err: e.message });
      totals.errors++;
      continue;
    }
    console.log(`  ${events.length} events récupérés sur la fenêtre`);

    // Extraire les conv_id uniques. On filtre aussi par source_id côté script
    // au cas où le filtre Front q[source_id] ne soit pas fiable.
    const convIds = new Set<string>();
    for (const e of events) {
      const convId = e.conversation?.id;
      if (!convId) continue;
      // Sécurité : ne garder que les events dont la source est bien notre inbox
      const sourceId = e.source?.data?.id;
      if (sourceId && sourceId !== ibx.id) continue;
      convIds.add(convId);
    }
    console.log(`  ${convIds.size} conversations uniques à synchroniser`);

    let done = 0;
    for (const convId of convIds) {
      // Fetch les détails de la conversation
      let conv: any;
      try {
        conv = await frontFetch(`/conversations/${convId}`);
      } catch (e: any) {
        console.error(`    ❌ ${convId} (fetch conv) : ${e.message}`);
        errorDetails.push({ conv: convId, step: 'fetch', err: e.message });
        totals.errors++;
        done++;
        continue;
      }
      try {
        await syncConversation(conv, ibx.id, ibx.store_code, holidays);
      } catch (e: any) {
        console.error(`    ❌ ${convId} (sync) : ${e.message}`);
        errorDetails.push({ conv: convId, step: 'sync', err: e.message });
        totals.errors++;
      }
      done++;
      if (done % 20 === 0) process.stdout.write(`    ... ${done}/${convIds.size}\n`);
    }
    const dur = Math.round((Date.now() - ibxStart) / 1000);
    console.log(`  ✅ ${ibx.store_code} terminé en ${dur}s\n`);
  }

  const duration = Math.round((Date.now() - startTime) / 1000);

  // Sync log end
  if (syncLogId && !dryRun) {
    await db.query(
      `UPDATE sav_sync_log SET finished_at=NOW(), status=$1, duration_seconds=$2,
         conversations_seen=$3, conversations_upserted=$4, messages_upserted=$5,
         comments_upserted=$6, events_upserted=$7, errors_count=$8, error_details=$9
       WHERE id=$10`,
      [
        totals.errors === 0 ? 'success' : 'partial',
        duration,
        totals.conversations_seen,
        totals.conversations_upserted,
        totals.messages_upserted,
        totals.comments_upserted,
        totals.events_upserted,
        totals.errors,
        JSON.stringify(errorDetails.slice(0, 50)),
        syncLogId,
      ]
    );
  }

  console.log(`\n═══ TERMINÉ en ${duration}s ═══`);
  console.log(`  Conversations vues       : ${totals.conversations_seen}`);
  console.log(`  Conversations upsertées  : ${totals.conversations_upserted}`);
  console.log(`  Messages upsertés        : ${totals.messages_upserted}`);
  console.log(`  Comments upsertés        : ${totals.comments_upserted}`);
  console.log(`  Events upsertés          : ${totals.events_upserted}`);
  console.log(`  Attachments upsertés     : ${totals.attachments_upserted}`);
  console.log(`  Erreurs                  : ${totals.errors}`);

  await db.end();
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await db.end().catch(() => {});
  process.exit(1);
});
