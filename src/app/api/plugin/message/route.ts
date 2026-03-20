import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';
import { createChatStream } from '@/lib/services/claudeService';
import { selectDocumentNames, filterRelevantFiles, buildDocumentsText } from '@/lib/documentSelector';

/**
 * POST /api/plugin/message
 * Envoie un message dans une conversation Claude existante (échange plugin).
 *
 * Body: {
 *   conversationId: string,  — ID de la conversation en BDD
 *   message: string          — message de l'utilisateur
 * }
 *
 * Retourne un stream texte (réponse Claude).
 */
export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY non configurée' }, { status: 500 });
    }

    await initDB();
    const { conversationId, message } = await req.json();

    if (!conversationId || !message) {
      return NextResponse.json({ error: 'conversationId et message requis' }, { status: 400 });
    }

    // 1. Charger la conversation et son agent
    const { rows: convRows } = await pool.query(
      'SELECT * FROM claude_conversations WHERE id = $1',
      [conversationId]
    );

    if (convRows.length === 0) {
      return NextResponse.json({ error: 'Conversation introuvable' }, { status: 404 });
    }

    const conversation = convRows[0];

    const { rows: agentRows } = await pool.query(
      'SELECT * FROM agents WHERE id = $1',
      [conversation.agent_id]
    );

    if (agentRows.length === 0) {
      return NextResponse.json({ error: 'Agent introuvable' }, { status: 404 });
    }

    const agent = agentRows[0];

    // 2. Charger les documents (même logique que analyze, pour le prompt caching)
    const { rows: agentFiles } = await pool.query(
      'SELECT name, content FROM agent_files WHERE agent_id = $1',
      [agent.id]
    );

    const { rows: sharedFilesRaw } = await pool.query(
      'SELECT name, content, assigned_to FROM shared_files'
    );
    const sharedFiles = sharedFilesRaw.filter((f) => {
      if (f.assigned_to === 'all') return true;
      try {
        const ids = JSON.parse(f.assigned_to);
        return Array.isArray(ids) && ids.includes(agent.id);
      } catch {
        return false;
      }
    });

    const allFiles = [
      ...agentFiles.map((f) => ({ name: f.name, content: f.content, shared: false })),
      ...sharedFiles.map((f) => ({ name: f.name, content: f.content, shared: true })),
    ];

    // Récupérer le premier message user pour la sélection de docs
    const { rows: firstMsg } = await pool.query(
      "SELECT content FROM claude_messages WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at LIMIT 1",
      [conversationId]
    );
    const emailContent = firstMsg[0]?.content || '';
    const relevantDocNames = selectDocumentNames(emailContent);
    const filteredFiles = filterRelevantFiles(allFiles, relevantDocNames);
    const documents = buildDocumentsText(filteredFiles);

    // 3. Charger l'historique (limité si trop long)
    const { rows: historyRaw } = await pool.query(
      'SELECT role, content FROM claude_messages WHERE conversation_id = $1 ORDER BY created_at',
      [conversationId]
    );
    // Si > 50 messages, garder le premier + les 20 derniers
    let history = historyRaw;
    if (history.length > 50) {
      console.warn(`[plugin/message] historique trop long (${history.length} msgs), trim à 21`);
      history = [history[0], ...history.slice(-20)];
    }

    // 4. Sauvegarder le message user
    const userMsgId = crypto.randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      'INSERT INTO claude_messages (id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)',
      [userMsgId, conversationId, 'user', message, now]
    );

    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // 5. Appeler Claude en streaming
    const systemPrompt = agent.instructions || 'Tu es un assistant service client.';

    const { stream } = createChatStream({
      systemPrompt,
      messages,
      model: 'sonnet',
      documents,
    });

    // 6. Passthrough : streamer au client + sauvegarder en BDD
    let fullResponse = '';

    const passthrough = new ReadableStream({
      async start(controller) {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            fullResponse += text;
            controller.enqueue(value);
          }
        } finally {
          if (fullResponse && !fullResponse.startsWith('__ERROR__')) {
            const assistantMsgId = crypto.randomUUID();
            const savedAt = new Date().toISOString();
            await pool.query(
              'INSERT INTO claude_messages (id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)',
              [assistantMsgId, conversationId, 'assistant', fullResponse, savedAt]
            );
            await pool.query(
              'UPDATE claude_conversations SET updated_at = $1 WHERE id = $2',
              [savedAt, conversationId]
            );
          }
          controller.close();
        }
      },
    });

    console.log(`[plugin/message] conv=${conversationId} history=${history.length} msgs`);

    return new Response(passthrough, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('[plugin/message] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
