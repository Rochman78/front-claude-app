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

    // 2. Pour chaque inbox boutique, repérer les conversations Devis récentes
    const results = [];
    let scanned = 0;
    let candidates = 0;
    for (const inb of shopInboxes) {
      const convRes = await frontFetch(`/inboxes/${inb.id}/conversations?limit=30`);
      if (!convRes.ok) continue;
      const convs: Record<string, unknown>[] = (await convRes.json())._results || [];
      scanned += convs.length;
      const tagged = convs.filter((c) =>
        ((c.tags as Record<string, unknown>[]) || []).some((t) => String(t.name || '').toLowerCase() === 'devis')
      );
      candidates += tagged.length;
      for (const c of tagged) {
        results.push(await processAutoDraft(c.id as string));
      }
    }

    const drafted = results.filter((r) => r.status === 'drafted').length;
    console.log(`[auto-draft-poll] inboxes=${shopInboxes.length} scanned=${scanned} candidates=${candidates} drafted=${drafted}`);
    return NextResponse.json({ shopInboxes: shopInboxes.length, scanned, candidates, drafted, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erreur inconnue';
    console.error('[auto-draft-poll] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
