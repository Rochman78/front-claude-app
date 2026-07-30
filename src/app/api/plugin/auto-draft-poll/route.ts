import { NextRequest, NextResponse } from 'next/server';
import { frontFetch } from '@/lib/services/frontappService';
import { getStoreByInboxName } from '@/lib/stores';
import { processAutoDraft } from '@/lib/services/autoDraftService';

/**
 * GET|POST /api/plugin/auto-draft-poll?key=AUTO_DRAFT_SECRET
 * Déclencheur : à appeler par un Cron Render (~toutes les 2 min).
 * Parcourt TOUTES les inboxes boutiques (mappées via leur nom → store), repère
 * les conversations récentes taguées "Devis" et lance le brouillon auto pour
 * chacune. Tous les garde-fous (1er mail, idempotence) sont dans processAutoDraft
 * → ré-appeler est sans danger.
 */
async function run(req: NextRequest) {
  const secret = process.env.AUTO_DRAFT_SECRET;
  if (secret) {
    const key = new URL(req.url).searchParams.get('key');
    if (key !== secret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    // 1. Lister les inboxes et ne garder que celles qui correspondent à une boutique
    const inbRes = await frontFetch('/inboxes?limit=100');
    if (!inbRes.ok) return NextResponse.json({ error: `Front inboxes ${inbRes.status}` }, { status: 502 });
    const inboxes: Record<string, unknown>[] = (await inbRes.json())._results || [];
    const shopInboxes = inboxes.filter((i) => getStoreByInboxName(String(i.name || '')));

    // 2. Pour chaque inbox boutique, repérer les conversations Devis récentes.
    // Pagination 2 pages × 100 = 200 conv max par inbox. Couvre :
    //  - les pics d'activité (LFC peut recevoir 100+ conv le week-end avant
    //    le 1er tick du cron du lundi matin)
    //  - les conv qui ont reçu leur tag "Devis" tardivement et sont sorties
    //    du top 100 entre-temps
    // Cas cnv_1lndeyc7 (LFC, 15/06/2026 dimanche 9h50) : 0 entrée auto_drafts
    // → la conv n'avait jamais été scannée.
    const PAGES_PAR_INBOX = 2;
    const results = [];
    let scanned = 0;
    let candidates = 0;
    for (const inb of shopInboxes) {
      const convsForInbox: Record<string, unknown>[] = [];
      let pageToken: string | null = null;
      for (let p = 0; p < PAGES_PAR_INBOX; p++) {
        const url = `/inboxes/${inb.id}/conversations?limit=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
        const convRes = await frontFetch(url);
        if (!convRes.ok) break;
        const data = await convRes.json();
        const page: Record<string, unknown>[] = data._results || [];
        convsForInbox.push(...page);
        const pag = data._pagination as Record<string, unknown> | undefined;
        const next = pag?.next as string | undefined;
        if (!next || page.length === 0) break;
        pageToken = next;
      }
      scanned += convsForInbox.length;
      const tagged = convsForInbox.filter((c) =>
        ((c.tags as Record<string, unknown>[]) || []).some((t) => String(t.name || '').toLowerCase() === 'devis')
      );
      candidates += tagged.length;
      // Throttle 400ms entre chaque conv → étale la charge Front API. Sans ce
      // throttle, le poll tape ~3 appels Front en burst × 30 candidates → on
      // dépasse la limite Front ~100 req/min → 429 en cascade → re-storm à
      // chaque poll (30/07/2026 pattern observé). Avec 400ms × 30 = 12s
      // d'étalement, on reste sous la limite avec marge.
      for (let idx = 0; idx < tagged.length; idx++) {
        if (idx > 0) await new Promise((r) => setTimeout(r, 400));
        results.push(await processAutoDraft(tagged[idx].id as string));
      }
    }

    const drafted = results.filter((r) => r.status === 'drafted').length;
    const sent = results.filter((r) => r.status === 'sent').length;
    const mode = process.env.AUTO_SEND_ENABLED === 'true' ? 'send' : 'draft';
    console.log(`[auto-draft-poll] mode=${mode} inboxes=${shopInboxes.length} scanned=${scanned} candidates=${candidates} drafted=${drafted} sent=${sent}`);
    return NextResponse.json({ mode, shopInboxes: shopInboxes.length, scanned, candidates, drafted, sent, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erreur inconnue';
    console.error('[auto-draft-poll] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
