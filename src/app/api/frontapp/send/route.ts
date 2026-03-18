import { NextRequest, NextResponse } from 'next/server';

const FRONT_API_URL = 'https://api2.frontapp.com';

export async function POST(req: NextRequest) {
  try {
    if (!process.env.FRONT_API_TOKEN) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN non configuré' }, { status: 500 });
    }

    const { conversationId, body } = await req.json();

    if (!conversationId || !body) {
      return NextResponse.json({ error: 'conversationId et body requis' }, { status: 400 });
    }

    const headers = {
      Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // Fetch conversation to get channel_id and author_id
    const convRes = await fetch(`${FRONT_API_URL}/conversations/${conversationId}`, { headers });
    if (!convRes.ok) {
      const errorText = await convRes.text();
      return NextResponse.json(
        { error: `Impossible de récupérer la conversation: ${convRes.status} - ${errorText}` },
        { status: convRes.status }
      );
    }

    const conv = await convRes.json();

    // Get channel_id from the conversation's links
    const channelUrl = conv._links?.related?.inboxes;
    let channelId = '';

    // Try to get from last_message's metadata
    if (conv.last_message?.metadata?.headers?.['x-front-channel-id']) {
      channelId = conv.last_message.metadata.headers['x-front-channel-id'];
    }

    // Fallback: get inboxes for this conversation and use the first one's channel
    if (!channelId && channelUrl) {
      const inboxesRes = await fetch(channelUrl, { headers });
      if (inboxesRes.ok) {
        const inboxesData = await inboxesRes.json();
        const inboxes = inboxesData._results || [];
        if (inboxes.length > 0) {
          // Get channels for this inbox
          const inboxId = inboxes[0].id;
          const channelsRes = await fetch(`${FRONT_API_URL}/inboxes/${inboxId}/channels`, { headers });
          if (channelsRes.ok) {
            const channelsData = await channelsRes.json();
            const channels = channelsData._results || [];
            if (channels.length > 0) {
              channelId = channels[0].id;
            }
          }
        }
      }
    }

    if (!channelId) {
      return NextResponse.json(
        { error: 'Impossible de trouver le channel_id pour cette conversation' },
        { status: 400 }
      );
    }

    // Get the assignee or first teammate as author
    const authorId = conv.assignee?.id || conv.last_message?.author?.id;

    const draftBody: Record<string, unknown> = {
      body,
      channel_id: channelId,
    };

    if (authorId) {
      draftBody.author_id = authorId;
    }

    // Create draft on the conversation
    const response = await fetch(
      `${FRONT_API_URL}/conversations/${conversationId}/drafts`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(draftBody),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `FrontApp API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    const text = await response.text();
    const data = text ? JSON.parse(text) : { success: true };
    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('FrontApp send error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
