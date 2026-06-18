#!/usr/bin/env tsx
/**
 * Analyse Claude Haiku des mails inbound de la veille.
 *
 * - Fetch tous les sav_messages direction='in' AND is_draft=false reçus hier
 *   (00:00 → 23:59 UTC) qui n'ont pas encore d'entrée dans sav_message_analysis
 *   pour prompt_version='v1'.
 * - Appel Claude Haiku par batch de 10 en parallèle.
 * - Insère le résultat dans sav_message_analysis.
 * - Met à jour sav_conversations.demand_type + summary si pas encore renseignés
 *   (= premier mail de la conv qu'on analyse).
 *
 * Usage :
 *   tsx scripts/analyze-yesterday.ts
 *     → veille (hier 00:00 → 23:59 UTC) - comportement cron par défaut
 *
 *   tsx scripts/analyze-yesterday.ts --dry-run
 *     → n'insère RIEN, log les analyses pour valider le prompt sur de vrais mails
 *
 *   tsx scripts/analyze-yesterday.ts --date 2026-06-17
 *     → une journée précise (raccourci pour --from=X --to=X)
 *
 *   tsx scripts/analyze-yesterday.ts --from=2026-06-10 --to=2026-06-17
 *   tsx scripts/analyze-yesterday.ts --from 2026-06-10 --to 2026-06-17
 *     → plage de dates inclusive (rattrapage manuel)
 *
 *   tsx scripts/analyze-yesterday.ts --limit 10
 *     → cap à N mails (combinable avec les autres pour test rapide)
 *
 * Coût indicatif Haiku 4.5 ($1 input / $5 output par M tokens) :
 *   ~2K tokens in + 200 out par mail × 358 mails ≈ 0.43 € / jour
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import Anthropic from '@anthropic-ai/sdk';

// ─── env loader (même pattern que les autres scripts) ─────────────
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

const MODEL = 'claude-haiku-4-5';
const PROMPT_VERSION = 'v1';
const BATCH_SIZE = 10;
const BODY_MAX_CHARS = 3000;

// ─── args ─────────────────────────────────────────────────────────
// Supporte les deux formats : `--flag value` (séparé) ET `--flag=value` (collé).
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
  if (!ISO_DATE_RE.test(v)) {
    console.error(`❌ ${name} doit être au format YYYY-MM-DD (reçu : ${v})`);
    process.exit(1);
  }
  return v;
}

const dryRun = args.includes('--dry-run');
const dateArg = requireIsoDate('--date', argValue('--date'));
const fromArg = requireIsoDate('--from', argValue('--from'));
const toArg   = requireIsoDate('--to',   argValue('--to'));
const limitArgRaw = argValue('--limit');
const limitArg = limitArgRaw !== null ? parseInt(limitArgRaw, 10) : null;

// Validation combinaisons exclusives.
if ((fromArg && !toArg) || (!fromArg && toArg)) {
  console.error('❌ --from et --to doivent être fournis ensemble');
  process.exit(1);
}
if (dateArg && (fromArg || toArg)) {
  console.error('❌ --date est incompatible avec --from/--to (utilisez l\'un OU l\'autre)');
  process.exit(1);
}

// ─── fenêtre temporelle ───────────────────────────────────────────
//   Priorité : --from/--to  >  --date  >  veille UTC.
function computeRange(): { from: string; to: string; label: string } {
  if (fromArg && toArg) {
    if (fromArg > toArg) {
      console.error(`❌ --from (${fromArg}) doit être ≤ --to (${toArg})`);
      process.exit(1);
    }
    return {
      from: `${fromArg} 00:00:00+00`,
      to:   `${toArg} 23:59:59.999999+00`,
      label: fromArg === toArg ? fromArg : `${fromArg} → ${toArg}`,
    };
  }
  if (dateArg) {
    return {
      from: `${dateArg} 00:00:00+00`,
      to:   `${dateArg} 23:59:59.999999+00`,
      label: dateArg,
    };
  }
  // Défaut : veille UTC.
  const now = new Date();
  const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const iso = y.toISOString().slice(0, 10);
  return {
    from: `${iso} 00:00:00+00`,
    to:   `${iso} 23:59:59.999999+00`,
    label: iso,
  };
}

// ─── prompt système ───────────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es un assistant d'analyse SAV pour une boutique e-commerce vendant des filets de camouflage et toiles d'ombrage en Europe (France, Espagne, Allemagne, Pays-Bas, Italie, Portugal).

Analyse le mail client ci-dessous et réponds UNIQUEMENT en JSON valide, sans aucun texte autour.

IMPORTANT : ignore les parties quotées du mail (tout ce qui suit "________________________________", "De :", "From:", "-----Original Message-----" ou toute citation du mail précédent). Analyse uniquement le nouveau message écrit par le client.

Format de réponse JSON attendu :
{
  "category": "livraison|retour_remboursement|question_produit|devis|reclamation_qualite|probleme_commande|question_usage_montage|demarchage_spam|autre",
  "sentiment": "positif|neutre|négatif|très_négatif",
  "urgency": true|false,
  "summary": "1 phrase max en français résumant la demande",
  "tags": ["tag1", "tag2"],
  "language": "fr|es|de|nl|it|pt|en|autre"
}

Règles :
- urgency=true si le client mentionne un chantier bloqué, événement imminent, délai critique, ou exprime une forte impatience
- sentiment très_négatif = colère explicite, menace de chargeback/litige/avis négatif
- sentiment négatif = insatisfaction claire, frustration, plainte
- tags : 2-4 mots-clés courts en français décrivant le problème précis (ex: "colis_abimé", "délai_dépassé", "mauvaise_taille", "concurrent_mentionné", "demande_remboursement")
- Pour les mails de démarchage commercial ou spam : category="demarchage_spam", sentiment="neutre"
- Le summary doit toujours être en français même si le mail est dans une autre langue`;

// ─── types ─────────────────────────────────────────────────────────
interface MsgRow {
  id: string;
  conversation_id: string;
  body_text: string;
  created_at: Date;
  store_code: string | null;
  language: string | null;
  conv_demand_type: string | null;
}

interface Analysis {
  category: string;
  sentiment: 'positif' | 'neutre' | 'négatif' | 'très_négatif';
  urgency: boolean;
  summary: string;
  tags: string[];
  language: string;
}

const SENTIMENTS = ['positif', 'neutre', 'négatif', 'très_négatif'] as const;
const LANGS = ['fr', 'es', 'de', 'nl', 'it', 'pt', 'en', 'autre'] as const;

// Parse + valide la réponse JSON renvoyée par Claude. Throw si invalide.
function parseAnalysis(raw: string): Analysis {
  // Claude répond parfois entouré de ```json … ``` malgré la consigne, on tolère.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const obj = JSON.parse(cleaned);
  if (typeof obj !== 'object' || obj === null) throw new Error('not an object');
  if (typeof obj.category !== 'string') throw new Error('category missing');
  if (!SENTIMENTS.includes(obj.sentiment)) throw new Error(`sentiment invalide: ${obj.sentiment}`);
  if (typeof obj.urgency !== 'boolean') throw new Error('urgency missing');
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

  console.log(`═══ analyze-yesterday — ${range.label} ═══`);
  console.log(`  fenêtre : ${range.from} → ${range.to}`);
  console.log(`  model   : ${MODEL} (prompt ${PROMPT_VERSION})`);
  if (dryRun)   console.log(`  mode    : DRY-RUN (aucun INSERT)`);
  if (limitArg) console.log(`  limit   : ${limitArg}`);

  // Fetch les mails à analyser.
  const limitClause = limitArg ? `LIMIT ${limitArg}` : '';
  const r = await db.query<MsgRow>(`
    SELECT m.id, m.conversation_id, m.body_text, m.created_at,
           c.store_code, c.language, c.demand_type AS conv_demand_type
    FROM sav_messages m
    JOIN sav_conversations c ON c.id = m.conversation_id
    WHERE m.direction = 'in'
      AND m.is_draft = false
      AND m.created_at >= $1::timestamptz
      AND m.created_at <= $2::timestamptz
      AND m.body_text IS NOT NULL
      AND LENGTH(m.body_text) > 0
      -- Exclut les expéditeurs auto/spam connus (économie API Claude).
      -- Patterns universels (noreply*) + domaines spécifiques (services
      -- de reviews, marketplaces, notifications) qui n'ont jamais à être
      -- analysés comme conversation client.
      AND COALESCE(c.customer_email, '') !~* '(noreply|no-reply|donotreply|do-not-reply|@loox\.io|@yotpo\.com|@trustpilot\.com|@pinterest\.com|@etsy\.com)'
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

  let ok = 0, errors = 0, convUpdated = 0;
  let totalInputChars = 0, totalOutputChars = 0;
  const t0 = Date.now();

  // Analyse un mail. Throw en cas d'erreur Claude/JSON.
  async function analyzeOne(m: MsgRow): Promise<Analysis> {
    const body = m.body_text.slice(0, BODY_MAX_CHARS);
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: body }],
    });
    const txt = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('');
    totalInputChars += body.length;
    totalOutputChars += txt.length;
    return parseAnalysis(txt);
  }

  // Traitement en batch de N en parallèle.
  for (let i = 0; i < msgs.length; i += BATCH_SIZE) {
    const batch = msgs.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async m => {
      const a = await analyzeOne(m);
      return { m, a };
    }));

    for (const r of results) {
      if (r.status === 'rejected') {
        errors++;
        if (errors <= 5) console.warn(`    ⚠️  ${r.reason instanceof Error ? r.reason.message : r.reason}`);
        continue;
      }
      const { m, a } = r.value;
      if (dryRun) {
        ok++;
        if (ok <= 10) console.log(`    ✓ [${m.store_code}] ${a.sentiment}${a.urgency ? ' 🚨' : ''} · ${a.category} · ${a.summary}`);
        continue;
      }
      try {
        await db.query(`
          INSERT INTO sav_message_analysis
            (message_id, conversation_id, prompt_version, category, sentiment, urgency, summary, tags, language, raw_response)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (message_id, prompt_version) DO NOTHING
        `, [
          m.id, m.conversation_id, PROMPT_VERSION,
          a.category, a.sentiment, a.urgency, a.summary, a.tags, a.language,
          JSON.stringify(a),
        ]);
        // Met à jour la conv si pas encore catégorisée (1er mail analysé)
        if (!m.conv_demand_type) {
          const upd = await db.query(`
            UPDATE sav_conversations
            SET demand_type = $2, summary = $3
            WHERE id = $1 AND demand_type IS NULL
          `, [m.conversation_id, a.category, a.summary]);
          if ((upd.rowCount ?? 0) > 0) convUpdated++;
        }
        ok++;
      } catch (e: unknown) {
        errors++;
        if (errors <= 5) console.warn(`    ⚠️  INSERT ${m.id} : ${(e as Error).message}`);
      }
    }

    if ((i + BATCH_SIZE) < msgs.length) {
      const done = Math.min(i + BATCH_SIZE, msgs.length);
      const eta = Math.round((msgs.length - done) * (Date.now() - t0) / done / 1000);
      console.log(`    … ${done}/${msgs.length} (ok=${ok} err=${errors}) ETA ~${eta}s`);
    }
  }

  // Coût indicatif. Approx : ~3.5 chars = 1 token (langues européennes).
  const inTokens = totalInputChars / 3.5;
  const outTokens = totalOutputChars / 3.5;
  const cost = (inTokens * 1 + outTokens * 5) / 1_000_000;  // Haiku 4.5 : $1 in / $5 out

  console.log(`\n═══ FIN ═══`);
  console.log(`  Analysés       : ${ok}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`  Conv updated   : ${convUpdated} (demand_type + summary)`);
  console.log(`  Erreurs        : ${errors}`);
  console.log(`  Durée          : ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`  Coût estimé    : ~$${cost.toFixed(3)} (${Math.round(inTokens)} in + ${Math.round(outTokens)} out tokens)`);
  console.log(`[analyze] ✓ ${ok} mails analysés, ${errors} erreurs, coût estimé ~$${cost.toFixed(3)}`);

  await db.end();
}

main().catch(e => { console.error('❌ FATAL', e); process.exit(1); });
