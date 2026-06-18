import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';
import { createChatStream } from '@/lib/services/claudeService';

// Rappel final injecté en queue du message user. Cf analyze/route.ts pour
// la justification (recency bias des LLM contre dérive linguistique).
const LANGUE_REMINDER = `

══════════════════════════════════════════════════════
🚨 RAPPEL FINAL — À APPLIQUER MAINTENANT, AVANT DE RÉDIGER

Tu rédiges TOUT en FRANÇAIS : brouillon, QUESTIONS, notes, exemples, du premier mot au dernier.

Peu importe la langue dans laquelle le client ou le mail précédent est rédigé : ta réponse reste 100 % EN FRANÇAIS.

La traduction sera faite automatiquement par le code au moment du push dans Front App.
══════════════════════════════════════════════════════`;

import { buildDocumentsText } from '@/lib/documentSelector';
import { getConversationImages } from '@/lib/services/frontappService';
import { getStockBySkuList } from '@/lib/services/octopiaService';
import { callClaude } from '@/lib/services/claudeService';

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

    // Charger TOUS les documents (même logique que analyze — l'agent a toujours accès à tout)
    const documents = buildDocumentsText(allFiles);

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

    // 5. Vérifier le stock si le message mentionne un produit (non bloquant).
    // Source = prix-ht-standards.txt depuis le 15/06/2026 (catalogue-XXX.txt supprimé).
    let stockInfo = '';
    try {
      const standardsDoc = allFiles.find((f) => f.name === 'prix-ht-standards.txt');
      if (!standardsDoc) {
        console.warn('[plugin/message] prix-ht-standards.txt introuvable → stock check sauté');
      }
      if (standardsDoc && process.env.OCTOPIA_SELLER_ID) {
        // Construire le contexte : dernier message + historique récent
        const recentContext = history.slice(-4).map((m) => m.content).join('\n') + '\n' + message;
        const skuExtractPrompt = `Tu es un assistant qui identifie les produits standards mentionnés dans une conversation et retrouve les SKU correspondants.

CONVERSATION RÉCENTE :
${recentContext.substring(0, 4000)}

LISTE DES PRODUITS STANDARDS (format colonnes : Nom | Variante | SKU | TTC | HT par taux TVA) :
${standardsDoc.content.substring(0, 35000)}

RÈGLES :
- La liste contient des filets standards (par couleur / matière / taille) ET des accessoires (mâts, kits de fixation, cordes, colliers, etc.). Parcourir TOUTE la liste.
- Identifier les produits CATALOGUE STANDARD mentionnés (couleur, taille, finition, accessoire précis).
- Vérifier ATTENTIVEMENT que la COULEUR ET la TAILLE correspondent EXACTEMENT à une ligne. Les tailles sont RÉVERSIBLES (3x4 = 4x3). Si la correspondance n'est pas exacte, NE PAS retourner de SKU — ne JAMAIS inventer ni proposer un SKU "approchant".
- Retourner UNIQUEMENT les SKU trouvés, un par ligne, format : SKU|nom_produit|quantité_demandée
- Si aucun produit standard identifié, retourner : AUCUN`;

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
            console.log(`[plugin/message] checking stock for ${skus.length} SKUs`);
            const stockData = await getStockBySkuList(skus);
            const stockLines: string[] = [];
            for (const sku of skus) {
              const available = stockData[sku];
              const info = skuMap[sku];
              stockLines.push(available !== undefined
                ? `  SKU ${sku} | ${info.name} | demandé: ${info.qtyDemanded} | en stock: ${available}`
                : `  SKU ${sku} | ${info.name} | demandé: ${info.qtyDemanded} | stock: non trouvé`);
            }
            stockInfo = `\n\n[STOCK OCTOPIA — données temps réel — USAGE INTERNE UNIQUEMENT]\n${stockLines.join('\n')}\nMentionne ces infos dans la section QUESTIONS, pas dans le brouillon client.`;
          }
        }
      }
    } catch (err) {
      console.warn('[plugin/message] stock check failed (non-blocking):', err);
    }

    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message + stockInfo + LANGUE_REMINDER },
    ];

    // 6. Charger les images de la conversation Front (si disponible)
    let imageBlocks: { data: string; mediaType: string; name: string; type: 'image' | 'pdf' }[] = [];
    if (conversation.front_conversation_id) {
      try {
        imageBlocks = await getConversationImages(conversation.front_conversation_id);
        if (imageBlocks.length > 0) {
          console.log(`[plugin/message] ${imageBlocks.length} images loaded for conversation`);
        }
      } catch (err) {
        console.warn('[plugin/message] image loading failed:', err);
      }
    }

    // 6. Appeler Claude en streaming
    const systemPrompt = agent.instructions || 'Tu es un assistant service client.';

    const { stream } = createChatStream({
      systemPrompt,
      messages,
      model: 'sonnet',
      documents,
      images: imageBlocks.length > 0 ? imageBlocks : undefined,
    });

    // 6. Passthrough : streamer au client + sauvegarder en BDD
    // Continue même si le client se déconnecte
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
            if (!clientDisconnected) {
              try {
                controller.enqueue(value);
              } catch {
                clientDisconnected = true;
                console.log(`[plugin/message] client disconnected, continuing for BDD save`);
              }
            }
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
          try { controller.close(); } catch { /* already closed */ }
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
