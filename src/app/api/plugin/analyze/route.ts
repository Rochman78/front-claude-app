import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';
import { createChatStream } from '@/lib/services/claudeService';
import { buildDocumentsText } from '@/lib/documentSelector';
import { getStoreByCode } from '@/lib/stores';
import { getConversationImages } from '@/lib/services/frontappService';
import { getStockBySkuList } from '@/lib/services/octopiaService';
import { callClaude } from '@/lib/services/claudeService';
import { dedupeRepeatedBlocks } from '@/lib/mailDedup';

// Rappel final ajouté en queue de message user, juste avant que Claude
// rédige. Position dictée par le "recency bias" des LLM : les instructions
// en fin de prompt sont mieux respectées que celles en début. Ce rappel
// prévient la dérive vers la langue du mail client (cas Suex S.r.l. IT,
// Cenci Noleggi Mamà IT, etc.) que la règle dans agents.instructions ne
// suffisait pas à corriger sur des fils saturés en langue étrangère.
const LANGUE_REMINDER = `

══════════════════════════════════════════════════════
🚨 RAPPEL FINAL — À APPLIQUER MAINTENANT, AVANT DE RÉDIGER

Tu rédiges TOUT en FRANÇAIS : brouillon, QUESTIONS, notes, exemples, du premier mot au dernier.

Le mail client ci-dessus peut être rédigé en italien, allemand, espagnol, néerlandais, portugais, anglais — PEU IMPORTE. Ta réponse reste 100 % EN FRANÇAIS.

Si tu sens que tu vas commencer une phrase dans une autre langue parce que le contexte est saturé d'une autre langue : STOP. Réécris en français.

La traduction sera faite automatiquement par le code au moment du push dans Front App.
══════════════════════════════════════════════════════`;


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
      // Extraire les SKUs des produits standards correspondant à la demande client.
      // Source = prix-ht-standards.txt depuis le 15/06/2026 (catalogue-XXX.txt supprimé,
      // redondant — prix-ht-standards.txt contient déjà SKU + TTC + HT par TVA).
      const standardsDoc = allFiles.find((f) => f.name === 'prix-ht-standards.txt');
      if (!standardsDoc) {
        console.warn('[plugin/analyze] prix-ht-standards.txt introuvable → stock check sauté');
      }
      if (standardsDoc && process.env.OCTOPIA_SELLER_ID) {
        const skuExtractPrompt = `Tu es un assistant qui identifie les produits demandés par le client dans un mail, et qui retrouve les SKU correspondants dans la liste des produits standards.

MAIL DU CLIENT :
${mailContent.substring(0, 4000)}

LISTE DES PRODUITS STANDARDS (format colonnes : Nom | Variante | SKU | TTC | HT par taux TVA) :
${standardsDoc.content.substring(0, 35000)}

RÈGLES :
- La liste contient des filets standards (par couleur / matière / taille) ET des accessoires (mâts, kits de fixation, cordes, colliers, etc.). Parcourir TOUTE la liste.
- Identifier les produits CATALOGUE STANDARD que le client demande (couleur, taille, finition, ou accessoire précis).
- Vérifier ATTENTIVEMENT que la COULEUR ET la TAILLE demandées correspondent EXACTEMENT à une ligne avant de retourner un SKU. Les tailles sont RÉVERSIBLES (3x4 = 4x3). Si la correspondance n'est pas exacte (taille proche, couleur proche), NE PAS retourner de SKU — ne JAMAIS inventer ni proposer un SKU "approchant".
- Si le client demande du sur mesure (dimensions non standard), ne retourner AUCUN SKU.
- Retourner UNIQUEMENT les SKU trouvés, un par ligne, format : SKU|nom_produit|quantité_demandée
- Si aucun produit standard identifié, retourner : AUCUN

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

            type StockRow = { sku: string; name: string; qtyDemanded: number; available: number | null };
            const rows: StockRow[] = skus.map((sku) => {
              const info = skuMap[sku];
              const qty = parseInt(info.qtyDemanded.replace(/\D/g, ''), 10);
              const av = stockData[sku];
              return {
                sku,
                name: info.name,
                qtyDemanded: Number.isFinite(qty) && qty > 0 ? qty : 1,
                available: typeof av === 'number' ? av : null,
              };
            });

            const ruptures = rows.filter((r) => r.available === 0);
            const partials = rows.filter((r) => r.available !== null && r.available !== 0 && r.available < r.qtyDemanded);
            const sufficient = rows.filter((r) => r.available !== null && r.available >= r.qtyDemanded);
            const unknown = rows.filter((r) => r.available === null);

            const blocks: string[] = [];

            if (ruptures.length > 0) {
              blocks.push(
                `══════════════════════════════════════════════════════
🚨 RUPTURE STOCK — PROCESS OBLIGATOIRE

Le(s) SKU catalogue correspondant à la demande du client sont ACTUELLEMENT EN RUPTURE :
${ruptures.map((r) => `  • SKU ${r.sku} | ${r.name} | stock : 0 | client demande : ${r.qtyDemanded}`).join('\n')}

TU DOIS :
1. NE PAS proposer ces produits au prix catalogue.
2. Dans le BROUILLON, informer poliment le client que la référence est actuellement en rupture sur notre site.
3. PROPOSER DIRECTEMENT un filet SUR-MESURE aux dimensions exactes demandées (utiliser prix-ht-sur-mesure.txt : forme × finition × tranche surface du devis pour le HT/m², puis chiffrer complètement HT / TVA / TTC).
4. SI le produit n'a pas d'équivalent sur-mesure (fibre de coco, accessoires, cordes, mâts, kits de fixation), proposer en plus l'inscription à la notification de réassort sur la fiche produit du site (mécanisme existant — règle "réassort site bouton").
5. NE PAS mentionner de quantité restante puisque stock = 0.
══════════════════════════════════════════════════════`
              );
            }

            if (partials.length > 0) {
              blocks.push(
                `══════════════════════════════════════════════════════
⚠️ STOCK PARTIEL — PROCESS OBLIGATOIRE

Stock < quantité demandée :
${partials.map((r) => `  • SKU ${r.sku} | ${r.name} | stock : ${r.available} | client demande : ${r.qtyDemanded}`).join('\n')}

TU DOIS :
1. Chiffrer le standard catalogue normalement.
2. Mentionner EXPLICITEMENT dans le brouillon le stock immédiat disponible et le solde à fabriquer en sur-mesure.
3. Formulation type : « Nous avons actuellement X unités en stock immédiat sur les Y demandées. Pour le solde de Z unités, nous pouvons les fabriquer sur mesure aux mêmes dimensions (délai d'environ 21 jours). Souhaitez-vous procéder ainsi ou ajuster votre commande ? »
4. NE PAS chiffrer le sur-mesure avant la confirmation du client.
══════════════════════════════════════════════════════`
              );
            }

            if (sufficient.length > 0) {
              blocks.push(
                `══════════════════════════════════════════════════════
ℹ️ STOCK SUFFISANT — MENTIONNER LA QUANTITÉ RESTANTE (bonus client)

Stock suffisant pour la demande :
${sufficient.map((r) => `  • SKU ${r.sku} | ${r.name} | stock : ${r.available} | client demande : ${r.qtyDemanded}`).join('\n')}

TU DOIS :
1. Chiffrer normalement au tarif catalogue.
2. MENTIONNER dans le brouillon la quantité restante en stock après son achat — info préventive pour le client en cas de rupture imminente (Charles 17/06/2026 : "comme ça si rupture dans les prochains jours il aura eu l'info").
3. Formulation type : « Il nous reste actuellement N unités en stock après votre commande. » (où N = stock − qté demandée).
══════════════════════════════════════════════════════`
              );
            }

            if (unknown.length > 0) {
              blocks.push(
                `══════════════════════════════════════════════════════
⚠️ STOCK INCONNU — Octopia n'a pas retourné de stock pour :
${unknown.map((r) => `  • SKU ${r.sku} | ${r.name}`).join('\n')}
Signale ces SKU en QUESTIONS au gérant et ne tranche pas (chiffre catalogue par défaut, mais demande confirmation stock).
══════════════════════════════════════════════════════`
              );
            }

            stockInfo = `\n\n${blocks.join('\n\n')}`;
            console.log(`[plugin/analyze] stock blocks: rupture=${ruptures.length} partial=${partials.length} sufficient=${sufficient.length} unknown=${unknown.length}`);
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
    // Dédupe les signatures email et citations longues répétées avant l'envoi
    // à Claude (cf cas Suex S.r.l. : 5 répétitions × 1500 chars de signature
    // italienne saturaient le contexte et faisaient dériver Claude vers l'IT).
    const dedupResult = dedupeRepeatedBlocks(mailContent);
    const cleanedMailContent = dedupResult.cleaned;
    if (dedupResult.removed > 0) {
      console.log(`[plugin/analyze] dedupe: ${dedupResult.removed} bloc(s) répété(s) retiré(s), -${dedupResult.bytesSaved} chars`);
    }
    const isResume = !forceFresh && existingMessages.length > 0;
    const userMessage = isResume
      ? `[Suite de la conversation] Le client a répondu. Voici le fil de mails COMPLET et MIS À JOUR (les messages les plus récents sont les plus importants). Tiens compte de tout ce que tu as échangé avec le gérant précédemment et propose un nouveau brouillon cohérent avec le déroulé de la conversation. Donne plus de poids aux messages les plus récents du client.\n\nClient : ${customerName || ''} (${customerEmail || ''})\n\n${cleanedMailContent}${stockInfo}${LANGUE_REMINDER}`
      : `[Analyse demandée] Voici le fil de mails du client ${customerName || ''} (${customerEmail || ''}) :\n\n${cleanedMailContent}${stockInfo}${LANGUE_REMINDER}`;

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
