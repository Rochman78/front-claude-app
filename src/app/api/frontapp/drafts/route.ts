import { NextRequest, NextResponse } from 'next/server';

const FRONT_API_URL = 'https://api2.frontapp.com';

export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get('conversation_id');
  if (!conversationId) return NextResponse.json({ has_draft: false });

  try {
    const resp = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/drafts`, {
      headers: {
        Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) return NextResponse.json({ has_draft: false });

    const data = await resp.json();
    const drafts = (data._results || []) as Record<string, unknown>[];
    const sharedDrafts = drafts.filter((d) => d.draft_mode === 'shared');
    return NextResponse.json({ has_draft: sharedDrafts.length > 0 });
  } catch {
    return NextResponse.json({ has_draft: false });
  }
}
