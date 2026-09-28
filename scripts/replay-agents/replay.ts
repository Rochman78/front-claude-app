#!/usr/bin/env tsx
/**
 * Banc de test des agents — rejoue des analyses passées avec les instructions
 * ACTUELLES (ou une variante) et un modèle au choix, sans rien écrire en base.
 *
 * Principe : pour chaque conversation Front, on relit en BDD le message user
 * de la dernière analyse (« [Analyse demandée] … » — il contient déjà le fil
 * de mails, la consigne gérant et les blocs STOCK injectés à l'époque) et la
 * réponse assistant d'origine (= baseline). On renvoie ce message au modèle
 * avec system = agents.instructions + documents de la boutique, exactement
 * comme /api/plugin/analyze (même buildMessages / buildSystemBlock), puis on
 * passe les deux brouillons dans des vérifications automatiques.
 *
 * Limites connues : pas d'images/PDF clients (non stockés), blocs STOCK figés
 * à la date de l'analyse d'origine, mode chat non rejoué.
 *
 * Usage :
 *   npx tsx scripts/replay-agents/replay.ts                      # cas CLAUDE.md, config prod
 *   npx tsx scripts/replay-agents/replay.ts --cases cnv_a,cnv_b
 *   npx tsx scripts/replay-agents/replay.ts --recent 20           # + 20 analyses récentes
 *   npx tsx scripts/replay-agents/replay.ts --config prod=claude-sonnet-4-6 \
 *        --config think=claude-sonnet-4-6:adaptive --config s5=claude-sonnet-5
 *   npx tsx scripts/replay-agents/replay.ts --instructions-dir agents/generated   # variante d'instructions (<STORE>.md)
 *   --dry-run : liste les cas sans appeler l'API.
 *
 * Coût : ~90 k tokens d'entrée par appel, mis en cache par boutique × config
 * (1re requête = écriture cache, suivantes = lecture). Compter ~0,10-0,40 $
 * par appel Sonnet selon le cache.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { buildMessages, buildSystemBlock } from '../../src/lib/services/claudeService';
import { buildDocumentsText } from '../../src/lib/documentSelector';
import { extraireFilets, buildSurMesureBlock } from '../../src/lib/services/surMesureCalc';

// ─── env ──────────────────────────────────────────────────────────
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ─── args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argValues = (name: string) =>
  args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : []));
const argValue = (name: string) => argValues(name)[0] ?? null;
const DRY = args.includes('--dry-run');
// --sur-mesure : recalcule le bloc « 📐 CALCUL SUR-MESURE » (surMesureCalc.ts)
// et l'insère dans le message rejoué, comme /api/plugin/analyze depuis le 28/09.
const WITH_SM = args.includes('--sur-mesure');

// Cas documentés dans CLAUDE.md (erreurs passées connues)
const DEFAULT_CASES = [
  'cnv_1lfxyqqf', 'cnv_1lh9w3mf', 'cnv_1liirz6f', 'cnv_1ljjlk47', 'cnv_1lktrcev', 'cnv_1llucrrr',
  'cnv_1lmrvoev', 'cnv_1lnflc5z', 'cnv_1lrf14if', 'cnv_1ls66p1z', 'cnv_1m169d07', 'cnv_1m5sm3rr', 'cnv_1mcdaown',
];

// --config nom=modèle[:adaptive|:off][@effort] — ex. s5=claude-sonnet-5@medium,
// think=claude-sonnet-4-6:adaptive@low. Sonnet 5 réfléchit par défaut : la
// réflexion consomme max_tokens, d'où une marge large dès qu'elle est active.
interface Config { name: string; model: string; thinking: boolean; off: boolean; effort?: 'low' | 'medium' | 'high' }
const configs: Config[] = (argValues('--config').length ? argValues('--config') : ['prod=claude-sonnet-4-6']).map((c) => {
  const [name, spec] = c.split('=');
  const [modelMode, effort] = spec.split('@');
  const [model, mode] = modelMode.split(':');
  return { name, model, thinking: mode === 'adaptive', off: mode === 'off', effort: effort as Config['effort'] };
});
const thinksByDefault = (model: string) => /sonnet-5|opus-5|fable/.test(model);

// ─── vérifications automatiques ───────────────────────────────────
type Check = { id: string; ok: boolean; detail?: string };

function brouillonPart(text: string): string {
  const start = text.search(/BROUILLON/i);
  const end = text.search(/\n\s*\**\s*(QUESTIONS|VÉRIFICATION)\b/i);
  return text.slice(start >= 0 ? start : 0, end > start ? end : undefined);
}

// Même heuristique que le garde-fou prix vides d'autoDraftService.ts
const PRICE_KEYWORD_RE = /\b(total|prix|precio|prezzo|preço|preis|prijs|iva|tva|tax|vat|mwst|btw|importe|importo|gesamt|netto|brutto|subtotal|sous[\s-]?total|surface|dimensions?|quantit[éà]|montant)\b/i;
const UNIT_TOKENS_RE = /€|EUR|USD|GBP|CHF|m²|m2|m³|m3|HT|TTC|TVA|IVA|MwSt|BTW|VAT/gi;

function runChecks(store: string, userMsg: string, output: string): Check[] {
  const draft = brouillonPart(output);
  const checks: Check[] = [];
  const firstLine = draft.split('\n').slice(1).map((l) => l.trim()).find((l) => l && !/^[*_#]+$/.test(l)) || '';
  checks.push({ id: 'salutation « Bonjour, » seul', ok: /^\**Bonjour,\**$/.test(firstLine), detail: firstLine.slice(0, 60) });
  checks.push({ id: 'format BROUILLON + QUESTIONS', ok: /BROUILLON/i.test(output) && /QUESTIONS|Pas de question/i.test(output) });
  const empty = draft.split('\n').filter((line) => {
    const m = line.trim().match(/^([^:\n]{1,80}):\s*(.*)$/);
    if (!m || !PRICE_KEYWORD_RE.test(m[1]) || /\d/.test(m[2])) return false;
    return !/[a-zA-Zàâäéèêëîïôöùûüçñáíóú]{4,}/.test(m[2].replace(UNIT_TOKENS_RE, ''));
  });
  checks.push({ id: 'pas de prix vide', ok: empty.length === 0, detail: empty[0]?.trim() });
  const cocoContext = store === 'COCO' || /\bcoco\b/i.test(userMsg);
  if (cocoContext) {
    const sm = draft.match(/[^.\n]*sur[- ]mesure[^.\n]*/i);
    checks.push({ id: 'coco : pas de sur-mesure proposé', ok: !sm, detail: sm?.[0].trim().slice(0, 120) });
  }
  const frais = draft.match(/[^.\n]*(à nos frais|pris en charge (par nous|à nos frais)|vous n'avez rien à régler)[^.\n]*/i);
  checks.push({ id: 'pas de « retour à nos frais »', ok: !frais, detail: frais?.[0].trim().slice(0, 120) });
  const noAvail = /STOCK SUFFISANT/.test(userMsg);
  const dispo = draft.match(/[^.\n]*(disponible immédiatement|en stock)[^.\n]*/i);
  if (!noAvail && !/STOCK PARTIEL/.test(userMsg)) {
    checks.push({ id: 'pas de disponibilité sans bloc stock', ok: !dispo, detail: dispo?.[0].trim().slice(0, 120) });
  }
  const foreign = draft.match(/\b(usted|gracias|vielen dank|grazie|obrigad[oa]|bedankt|thank you|Sehr geehrte|Estimad[oa])\b/i);
  checks.push({ id: 'brouillon 100 % français', ok: !foreign, detail: foreign?.[0] });
  return checks;
}

// ─── main ─────────────────────────────────────────────────────────
async function main() {
  const dbUrl = process.env.DATABASE_URL!;
  const db = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();

  let caseIds = argValue('--cases')?.split(',').map((s) => s.trim()) ?? DEFAULT_CASES;
  const recent = parseInt(argValue('--recent') || '0', 10);
  if (recent > 0) {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (c.front_conversation_id) c.front_conversation_id, m.created_at
         FROM claude_messages m JOIN claude_conversations c ON c.id = m.conversation_id
        WHERE m.role = 'user' AND m.content LIKE '%[Analyse demandée]%'
        ORDER BY c.front_conversation_id, m.created_at DESC`
    );
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    caseIds = [...new Set([...caseIds, ...rows.slice(0, recent).map((r) => r.front_conversation_id)])];
  }

  // Charge chaque cas : dernière analyse + réponse d'origine
  type Case = { cnv: string; store: string; agentId: string; user: string; baseline: string; date: string };
  const cases: Case[] = [];
  for (const cnv of caseIds) {
    const { rows } = await db.query(
      `SELECT a.store_code, a.id AS agent_id, m.conversation_id, m.content, m.created_at
         FROM claude_messages m
         JOIN claude_conversations c ON c.id = m.conversation_id
         JOIN agents a ON a.id = c.agent_id
        WHERE c.front_conversation_id = $1 AND m.role = 'user' AND m.content LIKE '%[Analyse demandée]%'
        ORDER BY m.created_at DESC LIMIT 1`,
      [cnv]
    );
    if (!rows[0]) { console.warn(`⏭  ${cnv} : aucune analyse stockée`); continue; }
    const r = rows[0];
    const { rows: ans } = await db.query(
      `SELECT content FROM claude_messages WHERE conversation_id = $1 AND role = 'assistant' AND created_at > $2 ORDER BY created_at LIMIT 1`,
      [r.conversation_id, r.created_at]
    );
    cases.push({ cnv, store: r.store_code, agentId: r.agent_id, user: r.content, baseline: ans[0]?.content ?? '', date: r.created_at });
  }
  console.log(`${cases.length} cas × ${configs.length} config(s) = ${cases.length * configs.length} appels`);
  if (DRY) { cases.forEach((c) => console.log(`  ${c.cnv} ${c.store} ${c.date}`)); await db.end(); return; }

  // Prompt système + documents par boutique (comme /api/plugin/analyze)
  const promptCache = new Map<string, { system: string; documents: string; grille?: string; standards?: string }>();
  const instructionsDir = argValue('--instructions-dir');
  async function promptFor(c: Case) {
    if (promptCache.has(c.store)) return promptCache.get(c.store)!;
    const { rows: [agent] } = await db.query('SELECT instructions FROM agents WHERE id = $1', [c.agentId]);
    const { rows: files } = await db.query('SELECT name, content FROM agent_files WHERE agent_id = $1', [c.agentId]);
    const { rows: shared } = await db.query('SELECT name, content, assigned_to FROM shared_files');
    const sharedOk = shared.filter((f) => {
      if (f.assigned_to === 'all') return true;
      try { const ids = JSON.parse(f.assigned_to); return Array.isArray(ids) && ids.includes(c.agentId); } catch { return false; }
    });
    let system = agent.instructions as string;
    const override = instructionsDir && join(instructionsDir, `${c.store}.md`);
    if (override && existsSync(override)) system = readFileSync(override, 'utf-8');
    const documents = buildDocumentsText([
      ...files.map((f) => ({ name: f.name, content: f.content, shared: false })),
      ...sharedOk.map((f) => ({ name: f.name, content: f.content, shared: true })),
    ]);
    const p = {
      system,
      documents,
      grille: files.find((f) => f.name === 'prix-ht-sur-mesure.txt')?.content as string | undefined,
      standards: files.find((f) => f.name === 'prix-ht-standards.txt')?.content as string | undefined,
    };
    promptCache.set(c.store, p);
    return p;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  type Result = { cnv: string; store: string; config: string; output: string; checks: Check[]; ms: number; usage: string };
  const results: Result[] = [];
  const baselineChecks = new Map<string, Check[]>();

  for (const c of cases) {
    baselineChecks.set(c.cnv, c.baseline ? runChecks(c.store, c.user, c.baseline) : []);
    const { system, documents, grille, standards } = await promptFor(c);
    let userMsg = c.user;
    if (WITH_SM && c.store !== 'COCO' && grille && standards) {
      const block = buildSurMesureBlock(await extraireFilets(c.user), grille, standards);
      if (block) {
        // même position qu'en prod : après les blocs stock, avant le rappel final
        const reminder = userMsg.lastIndexOf('\n\n══════════════════════════════════════════════════════\n🚨 RAPPEL FINAL');
        userMsg = reminder >= 0 ? `${userMsg.slice(0, reminder)}\n\n${block}${userMsg.slice(reminder)}` : `${userMsg}\n\n${block}`;
        console.log(`📐 ${c.cnv} : bloc sur-mesure injecté\n${block.split('\n').slice(3, -4).join('\n')}`);
      }
    }
    for (const cfg of configs) {
      const t0 = Date.now();
      try {
        const stream = client.messages.stream({
          model: cfg.model,
          max_tokens: cfg.thinking || (thinksByDefault(cfg.model) && !cfg.off) ? 32000 : 4096,
          ...(cfg.effort ? { output_config: { effort: cfg.effort } } : {}),
          system: buildSystemBlock(system),
          messages: buildMessages([{ role: 'user', content: userMsg }], documents),
          ...(cfg.thinking ? { thinking: { type: 'adaptive' as const } } : cfg.off ? { thinking: { type: 'disabled' as const } } : {}),
        });
        const msg = await stream.finalMessage();
        const output = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
        const u = msg.usage;
        if (msg.stop_reason === 'max_tokens') console.warn(`⚠️ ${c.cnv} [${cfg.name}] tronqué (max_tokens)`);
        const usage = `in=${u.input_tokens} cache_w=${u.cache_creation_input_tokens ?? 0} cache_r=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`;
        const checks = runChecks(c.store, userMsg, output);
        results.push({ cnv: c.cnv, store: c.store, config: cfg.name, output, checks, ms: Date.now() - t0, usage });
        console.log(`✔ ${c.cnv} ${c.store} [${cfg.name}] ${checks.filter((k) => k.ok).length}/${checks.length} ok — ${Math.round((Date.now() - t0) / 1000)} s — ${usage}`);
      } catch (err) {
        console.error(`✖ ${c.cnv} [${cfg.name}]`, err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err);
      }
    }
  }
  await db.end();

  // ─── rapport ──────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const outDir = join('scripts', 'replay-agents', 'runs');
  mkdirSync(outDir, { recursive: true });
  const score = (ch: Check[]) => (ch.length ? `${ch.filter((k) => k.ok).length}/${ch.length}` : '—');
  const lines: string[] = [`# Rejeu agents — ${ts}`, '', `Configs : ${configs.map((c) => `${c.name} = ${c.model}${c.thinking ? ' + réflexion' : ''}${c.effort ? ` (effort ${c.effort})` : ''}`).join(' · ')}`, ''];
  lines.push(`| Cas | Boutique | Origine | ${configs.map((c) => c.name).join(' | ')} |`, `|---|---|---|${configs.map(() => '---').join('|')}|`);
  for (const c of cases) {
    lines.push(`| ${c.cnv} | ${c.store} | ${score(baselineChecks.get(c.cnv)!)} | ${configs.map((cfg) => score(results.find((r) => r.cnv === c.cnv && r.config === cfg.name)?.checks ?? [])).join(' | ')} |`);
  }
  for (const c of cases) {
    lines.push('', `## ${c.cnv} (${c.store}, analyse du ${c.date.slice(0, 10)})`, '');
    const block = (title: string, text: string, ch: Check[]) => {
      lines.push(`### ${title}`, '');
      for (const k of ch.filter((x) => !x.ok)) lines.push(`- ❌ ${k.id}${k.detail ? ` — « ${k.detail} »` : ''}`);
      lines.push('', '```', text.trim(), '```', '');
    };
    block('Origine (prod à l’époque)', c.baseline || '(aucune réponse stockée)', baselineChecks.get(c.cnv)!);
    for (const r of results.filter((x) => x.cnv === c.cnv)) block(`${r.config} — ${Math.round(r.ms / 1000)} s — ${r.usage}`, r.output, r.checks);
  }
  const file = join(outDir, `${ts}.md`);
  writeFileSync(file, lines.join('\n'));
  console.log(`\nRapport : ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
