import { NextRequest, NextResponse } from 'next/server';
import { frontFetch } from '@/lib/services/frontappService';
import { processAutoDraft } from '@/lib/services/autoDraftService';

/**
 * GET|POST /api/plugin/auto-draft-poll?key=AUTO_DRAFT_SECRET
 * Déclencheur de la v1 : à appeler par un Cron Render (~toutes les 2 min).
 * Liste les conversations récentes de l'inbox LFC taguées "Devis" et lance
 * le brouillon auto pour chacune. Tous les garde-fous (1er mail, idempotence)
 * sont dans processAutoDraft → ré-appeler est sans danger.
 */
const LFC_INBOX_ID = 'inb_ffz87'; // Le Filet de Camouflage

async function run(req: NextRequest) {
  const secret = process.env.AUTO_DRAFT_SECRET;
  if (secret) {
    const key = new URL(req.url).searchParams.get('key');
    if (key !== secret) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const res = await frontFetch(`/inboxes/${LFC_INBOX_ID}/conversations?limit=30`);
    if (!res.ok) {
      return NextResponse.json({ error: `Front list ${res.status}` }, { status: 502 });
    }
    const convs: Record<string, unknown>[] = (await res.json())._results || [];
    const candidates = convs.filter((c) =>
      ((c.tags as Record<string, unknown>[]) || []).some((t) => String(t.name || '').toLowerCase() === 'devis')
    );

    const results = [];
    for (const c of candidates) {
      results.push(await processAutoDraft(c.id as string));
    }

    const drafted = results.filter((r) => r.status === 'drafted').length;
    console.log(`[auto-draft-poll] scanned=${convs.length} candidates=${candidates.length} drafted=${drafted}`);
    return NextResponse.json({ scanned: convs.length, candidates: candidates.length, drafted, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erreur inconnue';
    console.error('[auto-draft-poll] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
