import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';
import { createChatStream } from '@/lib/services/claudeService';
import { selectDocumentNames, filterRelevantFiles, buildDocumentsText } from '@/lib/documentSelector';
import { getStoreByCode } from '@/lib/stores';

/**
 * POST /api/plugin/analyze
 * Analyse un mail client via Claude. Appelé depuis le plugin Front App.
 *
 * Body: {
 *   storeCode: string,         — code boutique (LFC, TAR, etc.)
 *   customerEmail: string,     — email du client
 *   customerName: string,      — nom du client
 *   mailContent: string,       — fil de mails formaté
 *   frontConversationId: string — ID conversation Front App
 *   subject?: string           — sujet du mail
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
    const { storeCode, customerEmail, customerName, mailContent, frontConversationId, subject } = await req.json();

    if (!storeCode || !mailContent || !frontConversationId) {
      return NextResponse.json({ error: 'storeCode, mailContent et frontConversationId requis' }, { status: 400 });
    }

    // 1. Trouver l'agent lié à cette boutique
    const store = getStoreByCode(storeCode);
    if (!store) {
      return NextResponse.json({ error: `Boutique inconnue : ${storeCode}` }, { status: 400 });
    }

    // Chercher par store_code d'abord, puis fallback par email ou nom
    let { rows: agents } = await pool.query(
      'SELECT * FROM agents WHERE store_code = $1 LIMIT 1',
      [storeCode]
    );

    if (agents.length === 0) {
      // Fallback : chercher par email de la boutique dans le champ email de l'agent
      const fallback = await pool.query(
        'SELECT * FROM agents WHERE LOWER(name) LIKE $1 LIMIT 1',
        [`%${store.inboxMatchPattern}%`]
      );
      agents = fallback.rows;
    }

    if (agents.length === 0) {
      return NextResponse.json({ error: `Aucun agent configuré pour la boutique ${storeCode}` }, { status: 404 });
    }

    const agent = agents[0];

    // 2. Charger les fichiers (agent + partagés) et sélectionner les pertinents
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

    const relevantDocNames = selectDocumentNames(mailContent);
    const filteredFiles = filterRelevantFiles(allFiles, relevantDocNames);
    const documents = buildDocumentsText(filteredFiles);

    const systemPromptSize = (agent.instructions || '').length;
    const docsSize = documents.length;
    console.log(`[plugin/analyze] store=${storeCode} agent=${agent.name} docs=${filteredFiles.length}/${allFiles.length} selected=[${filteredFiles.map(f => f.name).join(', ')}]`);
    console.log(`[plugin/analyze] sizes: systemPrompt=${systemPromptSize} chars, documents=${docsSize} chars, total=${systemPromptSize + docsSize} chars (~${Math.round((systemPromptSize + docsSize) / 4)} tokens)`);

    // 3. Récupérer ou créer la conversation en BDD
    const { rows: convRows } = await pool.query(
      'SELECT * FROM claude_conversations WHERE agent_id = $1 AND front_conversation_id = $2',
      [agent.id, frontConversationId]
    );

    let conversation = convRows[0];
    if (!conversation) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await pool.query(
        'INSERT INTO claude_conversations (id, agent_id, front_conversation_id, subject, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, agent.id, frontConversationId, subject || '', now, now]
      );
      conversation = { id, agent_id: agent.id, front_conversation_id: frontConversationId };
    }

    // 4. Charger l'historique existant (si le plugin est rouvert sur le même thread)
    const { rows: existingMessages } = await pool.query(
      'SELECT role, content FROM claude_messages WHERE conversation_id = $1 ORDER BY created_at',
      [conversation.id]
    );

    // 5. Construire le message utilisateur avec le contexte mail
    const userMessage = `Voici le fil de mails du client ${customerName || ''} (${customerEmail || ''}) :\n\n${mailContent}`;

    // Sauvegarder le message user en BDD
    const userMsgId = crypto.randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      'INSERT INTO claude_messages (id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)',
      [userMsgId, conversation.id, 'user', userMessage, now]
    );

    const messages = [
      ...existingMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];

    // 6. Appeler Claude en streaming
    const systemPrompt = agent.instructions || `Tu es l'assistant service client de ${store.name}. Analyse le mail du client et propose un brouillon de réponse.`;

    const { stream } = createChatStream({
      systemPrompt,
      messages,
      model: 'sonnet',
      documents,
    });

    // 7. Collecter la réponse pour la sauvegarder en BDD, tout en streamant au client
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
          // Sauvegarder la réponse complète de Claude en BDD
          if (fullResponse && !fullResponse.startsWith('__ERROR__')) {
            const assistantMsgId = crypto.randomUUID();
            const savedAt = new Date().toISOString();
            await pool.query(
              'INSERT INTO claude_messages (id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)',
              [assistantMsgId, conversation.id, 'assistant', fullResponse, savedAt]
            );
            await pool.query(
              'UPDATE claude_conversations SET updated_at = $1 WHERE id = $2',
              [savedAt, conversation.id]
            );
          }
          controller.close();
        }
      },
    });

    return new Response(passthrough, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Conversation-Id': conversation.id,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('[plugin/analyze] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
