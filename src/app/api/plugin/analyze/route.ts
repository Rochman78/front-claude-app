import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';
import { createChatStream } from '@/lib/services/claudeService';
import { buildDocumentsText } from '@/lib/documentSelector';
import { getStoreByCode } from '@/lib/stores';
import { getConversationImages } from '@/lib/services/frontappService';
import { getStockBySkuList } from '@/lib/services/octopiaService';
import { callClaude } from '@/lib/services/claudeService';

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
    const { storeCode, customerEmail, customerName, mailContent, frontConversationId, subject, channel, forceFresh } = await req.json();

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

    // Charger TOUS les documents (l'agent a toujours accès à tout)
    const documents = buildDocumentsText(allFiles);

    const systemPromptSize = (agent.instructions || '').length;
    const docsSize = documents.length;
    console.log(`[plugin/analyze] store=${storeCode} agent=${agent.name} docs=${allFiles.length} [${allFiles.map(f => f.name).join(', ')}]`);
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

    // 5. Identifier les SKUs pertinents via Haiku + vérifier stock Octopia (non bloquant)
    let stockInfo = '';
    try {
      // Extraire les SKUs des produits catalogue correspondant à la demande client
      const catalogueDoc = allFiles.find((f) => f.name.toLowerCase().includes('catalogue'));
      if (catalogueDoc && process.env.OCTOPIA_SELLER_ID) {
        const skuExtractPrompt = `Tu es un assistant qui identifie les produits demandés par le client dans un mail, et qui retrouve les SKU correspondants dans le catalogue.

MAIL DU CLIENT :
${mailContent.substring(0, 2000)}

CATALOGUE (extrait) :
${catalogueDoc.content.substring(0, 8000)}

RÈGLES :
- Identifie les produits CATALOGUE STANDARD que le client demande (couleur, taille, finition)
- Retrouve le SKU (code EAN 13 chiffres commençant par 37) dans le catalogue
- Si le client demande du sur mesure (dimensions non standard), ne retourne AUCUN SKU
- Retourne UNIQUEMENT les SKU trouvés, un par ligne, format : SKU|nom_produit|quantité_demandée
- Si aucun produit catalogue identifié, retourne : AUCUN

Exemple de réponse :
3760388670833|Filet camouflage noir 2x2|5
3760388670796|Filet camouflage noir 2x3|3`;

        console.log('[plugin/analyze] calling Haiku to extract SKUs from mail...');
        const skuResult = await callClaude(
          [{ role: 'user', content: skuExtractPrompt }],
          { model: 'claude-haiku-4-5-20251001', maxTokens: 500 }
        );

        if (skuResult && !skuResult.includes('AUCUN')) {
          const skuLines = skuResult.trim().split('\n').filter((l) => l.includes('|'));
          const skuMap: Record<string, { name: string; qtyDemanded: string }> = {};
          for (const line of skuLines) {
            const [sku, name, qty] = line.split('|');
            if (sku && /^37\d{11}$/.test(sku.trim())) {
              skuMap[sku.trim()] = { name: (name || '').trim(), qtyDemanded: (qty || '?').trim() };
            }
          }

          const skus = Object.keys(skuMap);
          if (skus.length > 0 && skus.length <= 20) {
            console.log(`[plugin/analyze] Haiku found ${skus.length} SKUs, checking Octopia stock...`);
            const stockData = await getStockBySkuList(skus);
            const stockLines: string[] = [];
            for (const sku of skus) {
              const available = stockData[sku];
              const info = skuMap[sku];
              if (available !== undefined) {
                stockLines.push(`  SKU ${sku} | ${info.name} | demandé: ${info.qtyDemanded} | en stock: ${available}`);
              } else {
                stockLines.push(`  SKU ${sku} | ${info.name} | demandé: ${info.qtyDemanded} | stock: non trouvé sur Octopia`);
              }
            }
            stockInfo = `\n\n[STOCK OCTOPIA — données temps réel — USAGE INTERNE UNIQUEMENT]\n${stockLines.join('\n')}\n\nATTENTION : ces infos stock sont pour le GÉRANT uniquement. NE PAS les inclure dans le brouillon du mail client. Les mentionner UNIQUEMENT dans la section QUESTIONS à la fin.`;
            console.log(`[plugin/analyze] stock info ready: ${skus.length} products`);
          }
        } else {
          console.log('[plugin/analyze] Haiku: no catalogue SKUs identified (custom/quote request)');
        }
      }
    } catch (err) {
      console.warn('[plugin/analyze] stock check failed (non-blocking):', err);
    }

    // 6. Construire le message utilisateur avec le contexte mail + stock
    // forceFresh : ignore l'historique précédent (utilisé par l'auto-draft pour
    // toujours partir d'une analyse vierge même si la conv a déjà été traitée).
    const isResume = !forceFresh && existingMessages.length > 0;
    const userMessage = isResume
      ? `[Suite de la conversation] Le client a répondu. Voici le fil de mails COMPLET et MIS À JOUR (les messages les plus récents sont les plus importants). Tiens compte de tout ce que tu as échangé avec le gérant précédemment et propose un nouveau brouillon cohérent avec le déroulé de la conversation. Donne plus de poids aux messages les plus récents du client.\n\nClient : ${customerName || ''} (${customerEmail || ''})\n\n${mailContent}${stockInfo}`
      : `[Analyse demandée] Voici le fil de mails du client ${customerName || ''} (${customerEmail || ''}) :\n\n${mailContent}${stockInfo}`;

    // Sauvegarder le message user en BDD
    const userMsgId = crypto.randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      'INSERT INTO claude_messages (id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)',
      [userMsgId, conversation.id, 'user', userMessage, now]
    );

    // Limiter l'historique : si > 50 messages, garder le premier + les 20 derniers.
    // En mode forceFresh, on ignore complètement l'historique pour partir vierge.
    let trimmedHistory = forceFresh ? [] : existingMessages.map((m) => ({ role: m.role, content: m.content }));
    if (trimmedHistory.length > 50) {
      console.warn(`[plugin/analyze] historique trop long (${trimmedHistory.length} msgs), trim à 21`);
      trimmedHistory = [trimmedHistory[0], ...trimmedHistory.slice(-20)];
    }

    const messages = [
      ...trimmedHistory,
      { role: 'user', content: userMessage },
    ];

    // 6. Appeler Claude en streaming
    let systemPrompt = agent.instructions || `Tu es l'assistant service client de ${store.name}. Analyse le mail du client et propose un brouillon de réponse.`;

    // Adapter le prompt pour le canal chat (réponses plus courtes et directes)
    if (channel === 'chat') {
      systemPrompt += `\n\n═══════════════════════════════════════\nMODE CHAT (CONVERSATION EN DIRECT)\n═══════════════════════════════════════\n\nCette conversation vient du CHAT EN DIRECT (pas d'un email). Adapte ton style :\n- Réponses COURTES et DIRECTES, comme un chat en temps réel\n- Pas de formules longues ni de paragraphes développés\n- Tutoiement ou vouvoiement selon ce que le client utilise\n- Commence par "Bonjour [Prénom]," puis va droit au but\n- Pas de "Nous vous remercions pour votre message" ni de formules d'introduction longues\n- Maximum 3-4 phrases par réponse sauf si un chiffrage détaillé est nécessaire\n- Ton conversationnel, chaleureux mais efficace`;
    }

    // Récupérer les images depuis l'API Front (côté backend, plus fiable que le SDK client)
    let imageBlocks: { data: string; mediaType: string; name: string }[] = [];
    try {
      imageBlocks = await getConversationImages(frontConversationId);
    } catch (err) {
      console.warn('[plugin/analyze] image extraction failed:', err);
    }

    console.log(`[plugin/analyze] === CLAUDE API CALL ===`);
    console.log(`[plugin/analyze] system prompt: ${systemPrompt.length} chars`);
    console.log(`[plugin/analyze] documents: ${allFiles.length} files, ${documents.length} chars`);
    console.log(`[plugin/analyze] history: ${existingMessages.length} existing + 1 new = ${messages.length} messages`);
    console.log(`[plugin/analyze] mail content: ${mailContent.length} chars`);
    console.log(`[plugin/analyze] images: ${imageBlocks.length}`);
    console.log(`[plugin/analyze] total input estimate: ~${Math.round((systemPrompt.length + documents.length + messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)) / 4)} tokens + ${imageBlocks.length} images`);

    const { stream } = createChatStream({
      systemPrompt,
      messages,
      model: 'sonnet',
      documents,
      images: imageBlocks.length > 0 ? imageBlocks : undefined,
    });

    // 7. Collecter la réponse pour la sauvegarder en BDD, tout en streamant au client
    // Si le client se déconnecte (change de mail), le backend CONTINUE à lire Claude et sauvegarde
    let fullResponse = '';
    let clientDisconnected = false;

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
            // Envoyer au client, ignorer si déconnecté
            if (!clientDisconnected) {
              try {
                controller.enqueue(value);
              } catch {
                clientDisconnected = true;
                console.log(`[plugin/analyze] client disconnected, continuing Claude stream for BDD save`);
              }
            }
          }
        } finally {
          // Sauvegarder la réponse complète de Claude en BDD (même si client déconnecté)
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
            console.log(`[plugin/analyze] response saved (${fullResponse.length} chars, clientDisconnected=${clientDisconnected})`);
          }
          try { controller.close(); } catch { /* already closed */ }
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
    const rawMessage = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('[plugin/analyze] error:', rawMessage);
    let message = rawMessage;
    if (rawMessage.includes('Overloaded') || rawMessage.includes('overloaded')) {
      message = 'Les serveurs Claude sont temporairement surchargés. Réessayez dans quelques secondes.';
    } else if (rawMessage.includes('ENOTFOUND') || rawMessage.includes('ECONNREFUSED')) {
      message = 'Impossible de se connecter à la base de données. Contactez l\'administrateur.';
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
