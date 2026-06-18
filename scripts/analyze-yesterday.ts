#!/usr/bin/env tsx
/**
 * Analyse Claude Sonnet 4.6 (via Message Batches API) des mails inbound de la
 * veille. v2 — ajout de la dimension gravité business (escalation_level)
 * distincte du sentiment.
 *
 * Avantages Batch API :
 *   - 50% moins cher (analyse nocturne non urgente, on a tout le temps)
 *   - prompt caching automatique sur le system prompt (5 min TTL largement
 *     suffisant pour traiter ~350 requests)
 *
 * Usage :
 *   tsx scripts/analyze-yesterday.ts
 *   tsx scripts/analyze-yesterday.ts --dry-run
 *   tsx scripts/analyze-yesterday.ts --date 2026-06-17
 *   tsx scripts/analyze-yesterday.ts --from=2026-06-10 --to=2026-06-17
 *   tsx scripts/analyze-yesterday.ts --limit 10
 *
 * Coût estimé (Sonnet 4.6 batch + cache) :
 *   ~$3 input / $15 output par M tokens × 50% batch = $1.50/in et $7.50/out
 *   System prompt ~700 tokens cached → facturé 1x au lieu de N fois.
 *   358 mails × (300 in user + 250 out) ≈ 350K in + 90K out
 *   ≈ $0.50/jour ≈ $15/mois.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import Anthropic from '@anthropic-ai/sdk';

// ─── env loader ───────────────────────────────────────────────────
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const DB_URL = process.env.DATABASE_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!DB_URL) { console.error('❌ DATABASE_URL manquant'); process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error('❌ ANTHROPIC_API_KEY manquant'); process.exit(1); }

const MODEL = 'claude-sonnet-4-6';
const PROMPT_VERSION = 'v2';
const BODY_MAX_CHARS = 3000;
const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 60 * 60_000;  // 1h max (cron 3h dispo)

// ─── args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(name: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    if (args[i] === name && i + 1 < args.length) return args[i + 1];
  }
  return null;
}
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function requireIsoDate(name: string, v: string | null): string | null {
  if (v === null) return null;
  if (!ISO_DATE_RE.test(v)) { console.error(`❌ ${name} doit être YYYY-MM-DD (reçu : ${v})`); process.exit(1); }
  return v;
}
const dryRun = args.includes('--dry-run');
const dateArg = requireIsoDate('--date', argValue('--date'));
const fromArg = requireIsoDate('--from', argValue('--from'));
const toArg   = requireIsoDate('--to',   argValue('--to'));
const limitArgRaw = argValue('--limit');
const limitArg = limitArgRaw !== null ? parseInt(limitArgRaw, 10) : null;
if ((fromArg && !toArg) || (!fromArg && toArg)) {
  console.error('❌ --from et --to doivent être fournis ensemble'); process.exit(1);
}
if (dateArg && (fromArg || toArg)) {
  console.error('❌ --date est incompatible avec --from/--to'); process.exit(1);
}

function computeRange(): { from: string; to: string; label: string } {
  if (fromArg && toArg) {
    if (fromArg > toArg) { console.error(`❌ --from (${fromArg}) doit être ≤ --to (${toArg})`); process.exit(1); }
    return { from: `${fromArg} 00:00:00+00`, to: `${toArg} 23:59:59.999999+00`,
             label: fromArg === toArg ? fromArg : `${fromArg} → ${toArg}` };
  }
  if (dateArg) return { from: `${dateArg} 00:00:00+00`, to: `${dateArg} 23:59:59.999999+00`, label: dateArg };
  const now = new Date();
  const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const iso = y.toISOString().slice(0, 10);
  return { from: `${iso} 00:00:00+00`, to: `${iso} 23:59:59.999999+00`, label: iso };
}

// ─── system prompt v2 ─────────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es un assistant d'analyse SAV pour une boutique e-commerce vendant des filets de camouflage et toiles d'ombrage en Europe (FR, ES, DE, NL, IT, PT).

Analyse le mail client et réponds UNIQUEMENT en JSON valide, sans aucun texte autour.

IMPORTANT : ignore les parties quotées (tout ce qui suit "____________", "De :", "From:", "-----Original Message-----", ou toute citation du mail précédent). Analyse uniquement le nouveau message du client.

Format JSON attendu :
{
  "category": "livraison|retour_remboursement|question_produit|devis|reclamation_qualite|probleme_commande|question_usage_montage|demarchage_spam|autre",
  "sentiment": "positif|neutre|négatif|très_négatif",
  "urgency": true|false,
  "escalation_level": "aucun|surveiller|critique",
  "escalation_reasons": ["..."],
  "summary": "1 phrase max en français",
  "tags": ["..."],
  "language": "fr|es|de|nl|it|pt|en|autre"
}

DISTINCTION CLÉ — sentiment ≠ gravité :
- sentiment = l'émotion exprimée (ton du message)
- escalation_level = le risque business, INDÉPENDAMMENT du ton. Un client parfaitement calme qui annonce un chargeback est "critique".

Règles escalation_level :
- "critique" : menace de chargeback/opposition bancaire, menace d'action juridique (avocat, mise en demeure, tribunal), menace de signalement (DGCCRF, répression des fraudes), menace explicite d'avis public négatif (Trustpilot, Google, avis Amazon), OU colis non reçu avec montant élevé.
- "surveiller" : client qui relance pour la 2e/3e fois sans résolution, insatisfaction qui monte, demande de remboursement contestée, ton qui se durcit.
- "aucun" : tout le reste.

escalation_reasons : liste de tags courts parmi (ou similaires) :
"menace_chargeback", "menace_juridique", "menace_avis_public", "mention_dgccrf", "colis_non_recu", "relance_multiple", "remboursement_conteste".

Règles urgency (STRICT — ne pas sur-déclencher) :
- urgency=true UNIQUEMENT si délai réellement bloquant et explicite : chantier/installation arrêté, événement daté imminent, commande pro avec deadline.
- NE PAS mettre urgency=true juste parce que le client veut une réponse "rapidement" ou est impatient. L'impatience banale n'est pas une urgence.

Règles sentiment :
- très_négatif : colère explicite, agressivité, menace.
- négatif : insatisfaction ou frustration claire.
- Un client poli mais ferme qui pose une réclamation factuelle = neutre ou négatif selon le fond, PAS très_négatif.

Démarchage commercial / spam : category="demarchage_spam", sentiment="neutre", escalation_level="aucun".
summary toujours en français même si le mail est dans une autre langue.`;

// ─── types ─────────────────────────────────────────────────────────
interface MsgRow {
  id: string;
  conversation_id: string;
  body_text: string;
  store_code: string | null;
  conv_demand_type: string | null;
}
interface Analysis {
  category: string;
  sentiment: 'positif' | 'neutre' | 'négatif' | 'très_négatif';
  urgency: boolean;
  escalation_level: 'aucun' | 'surveiller' | 'critique';
  escalation_reasons: string[];
  summary: string;
  tags: string[];
  language: string;
}
const SENTIMENTS = ['positif', 'neutre', 'négatif', 'très_négatif'] as const;
const LANGS = ['fr', 'es', 'de', 'nl', 'it', 'pt', 'en', 'autre'] as const;
const ESCALATIONS = ['aucun', 'surveiller', 'critique'] as const;

function parseAnalysis(raw: string): Analysis {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const obj = JSON.parse(cleaned);
  if (typeof obj !== 'object' || obj === null) throw new Error('not an object');
  if (typeof obj.category !== 'string') throw new Error('category missing');
  if (!SENTIMENTS.includes(obj.sentiment)) throw new Error(`sentiment invalide: ${obj.sentiment}`);
  if (typeof obj.urgency !== 'boolean') throw new Error('urgency missing');
  if (!ESCALATIONS.includes(obj.escalation_level)) throw new Error(`escalation_level invalide: ${obj.escalation_level}`);
  if (!Array.isArray(obj.escalation_reasons)) throw new Error('escalation_reasons not array');
  if (typeof obj.summary !== 'string') throw new Error('summary missing');
  if (!Array.isArray(obj.tags)) throw new Error('tags not array');
  if (!LANGS.includes(obj.language)) throw new Error(`language invalide: ${obj.language}`);
  return obj as Analysis;
}

// ─── main ──────────────────────────────────────────────────────────
async function main() {
  const range = computeRange();
  const db = new Client({
    connectionString: DB_URL,
    ssl: DB_URL!.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  console.log(`═══ analyze-yesterday v2 — ${range.label} ═══`);
  console.log(`  fenêtre : ${range.from} → ${range.to}`);
  console.log(`  model   : ${MODEL} (prompt ${PROMPT_VERSION}, Batch API)`);
  if (dryRun)   console.log(`  mode    : DRY-RUN (aucun INSERT)`);
  if (limitArg) console.log(`  limit   : ${limitArg}`);

  const limitClause = limitArg ? `LIMIT ${limitArg}` : '';
  const r = await db.query<MsgRow>(`
    SELECT m.id, m.conversation_id, m.body_text,
           c.store_code, c.demand_type AS conv_demand_type
    FROM sav_messages m
    JOIN sav_conversations c ON c.id = m.conversation_id
    WHERE m.direction = 'in'
      AND m.is_draft = false
      AND m.created_at >= $1::timestamptz
      AND m.created_at <= $2::timestamptz
      AND m.body_text IS NOT NULL
      AND LENGTH(m.body_text) > 0
      AND COALESCE(c.customer_email, '') !~* '(noreply|no-reply|donotreply|do-not-reply|@loox\\.io|@yotpo\\.com|@trustpilot\\.com|@pinterest\\.com|@etsy\\.com)'
      AND NOT EXISTS (
        SELECT 1 FROM sav_message_analysis a
        WHERE a.message_id = m.id AND a.prompt_version = $3
      )
    ORDER BY m.created_at
    ${limitClause}
  `, [range.from, range.to, PROMPT_VERSION]);

  const msgs = r.rows;
  console.log(`\n  ${msgs.length} mails à analyser\n`);
  if (msgs.length === 0) { await db.end(); return; }

  // ─── Construit les requêtes batch ────────────────────────────
  // System prompt marqué cache_control: ephemeral → facturé 1× sur tout le batch
  // (cache 5min largement suffisant pour traiter ~350 requests en quelques secondes
  // côté Anthropic).
  const requests = msgs.map(m => ({
    custom_id: m.id,
    params: {
      model: MODEL,
      max_tokens: 600,
      system: [{
        type: 'text' as const,
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' as const },
      }],
      messages: [{ role: 'user' as const, content: m.body_text.slice(0, BODY_MAX_CHARS) }],
    },
  }));

  console.log(`  → soumission batch (${requests.length} requests)…`);
  const t0 = Date.now();
  const batch = await anthropic.messages.batches.create({ requests });
  console.log(`  batch créé : ${batch.id} (status=${batch.processing_status})`);

  // ─── Poll jusqu'à completion ─────────────────────────────────
  let current = batch;
  while (current.processing_status !== 'ended') {
    if (Date.now() - t0 > POLL_TIMEOUT_MS) {
      throw new Error(`Timeout après ${Math.round(POLL_TIMEOUT_MS / 60000)} min — batch ${batch.id} toujours ${current.processing_status}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    current = await anthropic.messages.batches.retrieve(batch.id);
    const counts = current.request_counts;
    console.log(`  … ${current.processing_status} : succeeded=${counts.succeeded} errored=${counts.errored} processing=${counts.processing} canceled=${counts.canceled} expired=${counts.expired}`);
  }
  console.log(`  ✓ batch terminé en ${Math.round((Date.now() - t0) / 1000)}s`);

  // ─── Récupère + parse les résultats ───────────────────────────
  let ok = 0, errors = 0, critiques = 0, surveiller = 0, convUpdated = 0;
  let cachedInputTokens = 0, freshInputTokens = 0, outputTokens = 0;
  const msgById = new Map(msgs.map(m => [m.id, m]));

  const resultsStream = await anthropic.messages.batches.results(batch.id);
  for await (const entry of resultsStream) {
    const msg = msgById.get(entry.custom_id);
    if (!msg) continue;

    if (entry.result.type !== 'succeeded') {
      errors++;
      if (errors <= 5) console.warn(`    ⚠️  ${entry.custom_id} : ${entry.result.type}`);
      continue;
    }

    const message = entry.result.message;
    // Track usage (cache_read_input_tokens = input tokens facturés -90%)
    const usage = message.usage;
    cachedInputTokens += usage.cache_read_input_tokens || 0;
    freshInputTokens += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    outputTokens += usage.output_tokens || 0;

    const txt = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('');

    let a: Analysis;
    try {
      a = parseAnalysis(txt);
    } catch (e: unknown) {
      errors++;
      if (errors <= 5) console.warn(`    ⚠️  parse ${entry.custom_id} : ${(e as Error).message}`);
      continue;
    }

    if (a.escalation_level === 'critique') critiques++;
    if (a.escalation_level === 'surveiller') surveiller++;

    if (dryRun) {
      ok++;
      if (ok <= 15) {
        console.log(`    ✓ [${msg.store_code}] ${a.sentiment}${a.urgency ? ' 🚨' : ''}${a.escalation_level !== 'aucun' ? ` · ⚠ ${a.escalation_level}` : ''} · ${a.category} · ${a.summary}`);
        if (a.escalation_reasons.length > 0) console.log(`      reasons: ${a.escalation_reasons.join(', ')}`);
      }
      continue;
    }

    try {
      // UPSERT — DO UPDATE permet une ré-analyse propre après ajustement du
      // prompt (incrémenter prompt_version reste la voie principale, mais
      // au sein d'une même version on peut re-jouer sans contrainte).
      await db.query(`
        INSERT INTO sav_message_analysis
          (message_id, conversation_id, prompt_version, category, sentiment,
           urgency, escalation_level, escalation_reasons,
           summary, tags, language, raw_response, analyzed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
        ON CONFLICT (message_id, prompt_version) DO UPDATE SET
          category = EXCLUDED.category,
          sentiment = EXCLUDED.sentiment,
          urgency = EXCLUDED.urgency,
          escalation_level = EXCLUDED.escalation_level,
          escalation_reasons = EXCLUDED.escalation_reasons,
          summary = EXCLUDED.summary,
          tags = EXCLUDED.tags,
          language = EXCLUDED.language,
          raw_response = EXCLUDED.raw_response,
          analyzed_at = NOW()
      `, [
        msg.id, msg.conversation_id, PROMPT_VERSION,
        a.category, a.sentiment, a.urgency,
        a.escalation_level, a.escalation_reasons,
        a.summary, a.tags, a.language,
        JSON.stringify(a),
      ]);
      // Update systématique de la conv (écrase éventuelles valeurs v1) : la
      // conv ne porte qu'un état courant, la v2 est l'autorité.
      const upd = await db.query(`
        UPDATE sav_conversations
        SET demand_type = $2, summary = $3
        WHERE id = $1
          AND (demand_type IS DISTINCT FROM $2 OR summary IS DISTINCT FROM $3)
      `, [msg.conversation_id, a.category, a.summary]);
      if ((upd.rowCount ?? 0) > 0) convUpdated++;
      ok++;
    } catch (e: unknown) {
      errors++;
      if (errors <= 5) console.warn(`    ⚠️  INSERT ${msg.id} : ${(e as Error).message}`);
    }
  }

  // Coût indicatif. Sonnet 4.6 via Batch API : 50% du tarif standard.
  //   input : $3/M × 0.5 = $1.50/M
  //   output : $15/M × 0.5 = $7.50/M
  //   cache read : $0.30/M × 0.5 = $0.15/M (10% du prix input fresh, 50% batch)
  const cost = (freshInputTokens * 1.50 + cachedInputTokens * 0.15 + outputTokens * 7.50) / 1_000_000;

  console.log(`\n═══ FIN ═══`);
  console.log(`  Analysés       : ${ok}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`  ⚠ Critiques    : ${critiques}`);
  console.log(`  ⚠ À surveiller : ${surveiller}`);
  console.log(`  Conv updated   : ${convUpdated} (demand_type + summary)`);
  console.log(`  Erreurs        : ${errors}`);
  console.log(`  Tokens input   : ${freshInputTokens} fresh + ${cachedInputTokens} cached (réduction ${Math.round(cachedInputTokens / Math.max(1, freshInputTokens + cachedInputTokens) * 100)}%)`);
  console.log(`  Tokens output  : ${outputTokens}`);
  console.log(`  Coût estimé    : ~$${cost.toFixed(3)} (Sonnet 4.6 batch + cache)`);
  console.log(`  Durée totale   : ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`[analyze v2] ✓ ${ok} analysés (${critiques} critiques, ${surveiller} à surveiller), ${errors} erreurs, coût estimé ~$${cost.toFixed(3)}`);

  // ─── Bonus : comparatif v1 (Haiku) vs v2 (Sonnet) sur la même fenêtre ──
  // Affiché uniquement s'il existe des analyses v1 ET v2 sur la fenêtre.
  // Montre concrètement ce que Sonnet rattrape que Haiku ratait.
  const cmpRes = await db.query<{
    total: string;
    sentiment_changed: string;
    urgency_changed: string;
    new_critique: string;
    new_surveiller: string;
    urgency_disabled: string;
    sentiment_aggravated: string;
  }>(`
    WITH paired AS (
      SELECT v1.message_id,
             v1.sentiment AS s1, v2.sentiment AS s2,
             v1.urgency AS u1,   v2.urgency AS u2,
             COALESCE(v2.escalation_level, 'aucun') AS esc2
      FROM sav_message_analysis v1
      JOIN sav_message_analysis v2
        ON v2.message_id = v1.message_id AND v2.prompt_version = 'v2'
      JOIN sav_messages m ON m.id = v1.message_id
      WHERE v1.prompt_version = 'v1'
        AND m.created_at >= $1::timestamptz
        AND m.created_at <= $2::timestamptz
    )
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE s1 IS DISTINCT FROM s2) AS sentiment_changed,
      COUNT(*) FILTER (WHERE u1 IS DISTINCT FROM u2) AS urgency_changed,
      COUNT(*) FILTER (WHERE u1 = true AND u2 = false) AS urgency_disabled,
      COUNT(*) FILTER (WHERE esc2 = 'critique') AS new_critique,
      COUNT(*) FILTER (WHERE esc2 = 'surveiller') AS new_surveiller,
      COUNT(*) FILTER (WHERE
        CASE s1 WHEN 'positif' THEN 0 WHEN 'neutre' THEN 1 WHEN 'négatif' THEN 2 ELSE 3 END
        <
        CASE s2 WHEN 'positif' THEN 0 WHEN 'neutre' THEN 1 WHEN 'négatif' THEN 2 ELSE 3 END
      ) AS sentiment_aggravated
    FROM paired
  `, [range.from, range.to]);

  const c = cmpRes.rows[0];
  if (c && parseInt(c.total, 10) > 0) {
    const tot = parseInt(c.total, 10);
    console.log(`\n═══ Comparatif Haiku v1 → Sonnet v2 (${tot} mails communs) ═══`);
    console.log(`  Sentiment changé      : ${c.sentiment_changed} (${pct(c.sentiment_changed, tot)}%)`);
    console.log(`    → dont aggravé      : ${c.sentiment_aggravated}`);
    console.log(`  Urgency changée       : ${c.urgency_changed} (${pct(c.urgency_changed, tot)}%)`);
    console.log(`    → faux positifs v1  : ${c.urgency_disabled} (Sonnet a annulé)`);
    console.log(`  🔥 Nouveaux critiques : ${c.new_critique} (invisibles côté Haiku)`);
    console.log(`  ⚠  Nouveaux surveiller: ${c.new_surveiller} (invisibles côté Haiku)`);
  }

  await db.end();
}

function pct(n: string | number, total: number): string {
  const x = typeof n === 'string' ? parseInt(n, 10) : n;
  return total > 0 ? (Math.round((x / total) * 1000) / 10).toString() : '0';
}

main().catch(e => { console.error('❌ FATAL', e); process.exit(1); });
