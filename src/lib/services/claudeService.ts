/**
 * Service Claude — centralise la construction des appels à l'API Anthropic.
 */

import Anthropic from '@anthropic-ai/sdk';
import pool from '@/lib/db';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

type MessageParam = Anthropic.Messages.MessageParam;

/**
 * Trace la consommation de chaque appel dans claude_usage (coût par route,
 * boutique, modèle). Best-effort : un échec d'écriture ne bloque jamais l'appel.
 */
export function recordUsage(label: string, model: string, usage: Anthropic.Messages.Usage | undefined, durationMs: number, storeCode = ''): void {
  if (!usage) return;
  pool.query(
    `INSERT INTO claude_usage (label, store_code, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [label, storeCode, model, usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0, usage.output_tokens, durationMs]
  ).catch((e) => console.warn('[claude] recordUsage failed:', e instanceof Error ? e.message : e));
}

export interface ImageAttachment {
  data: string;
  mediaType: string;
  name: string;
  type?: 'image' | 'pdf';
}

export interface StreamChatOptions {
  systemPrompt: string;
  messages: { role: string; content: string }[];
  model?: 'sonnet' | string;
  documents?: string;
  maxTokens?: number;
  maxMessages?: number;
  images?: ImageAttachment[];
  /** Route appelante, pour claude_usage (ex : 'analyze', 'message'). */
  label?: string;
  storeCode?: string;
}

/**
 * Construit les messages avec documents en prefix (cachés) + historique.
 * Si des images sont fournies, elles sont ajoutées au dernier message user.
 */
export function buildMessages(messages: { role: string; content: string }[], documents?: string, maxMessages = 10, images?: ImageAttachment[]): MessageParam[] {
  const trimmed = messages.slice(-maxMessages);

  const docPrefix: MessageParam[] = documents
    ? [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: `DOCUMENTS DE RÉFÉRENCE (à consulter pour répondre au client) :\n\n${documents}`,
              cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
            },
          ],
        },
        {
          role: 'assistant' as const,
          content: 'Bien noté. Je dispose des documents de référence et je suis prêt à analyser le mail du client selon le process décrit dans mes instructions.',
        },
      ]
    : [];

  const mapped = trimmed.map((m, idx) => {
    const isLastUser = m.role === 'user' && idx === trimmed.length - 1;
    // Ajouter les images et PDFs au dernier message user
    if (isLastUser && images && images.length > 0) {
      const attachmentBlocks = images.map((img) => {
        if (img.type === 'pdf') {
          return {
            type: 'document' as const,
            source: {
              type: 'base64' as const,
              media_type: 'application/pdf' as const,
              data: img.data,
            },
          };
        }
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: img.data,
          },
        };
      });
      return {
        role: m.role as 'user' | 'assistant',
        content: [
          ...attachmentBlocks,
          { type: 'text' as const, text: m.content },
        ],
      };
    }
    return {
      role: m.role as 'user' | 'assistant',
      content: m.content,
    };
  });

  return [...docPrefix, ...mapped];
}

/**
 * Construit le system prompt avec cache_control.
 */
export function buildSystemBlock(systemPrompt: string): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: 'text' as const,
      text: systemPrompt || 'Tu es un assistant IA utile.',
      cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
    },
  ];
}

/**
 * Résout le model ID à partir du nom court.
 */
// Modèle principal des brouillons (analyze, message, auto-draft, chat).
// Sonnet 5 en effort « low » retenu le 28/09/2026 après rejeu de 31 conversations
// (scripts/replay-agents/) : moins d'erreurs graves que Sonnet 4.6, pas de
// raisonnement qui fuit dans la sortie, plus rapide. Retour arrière sans
// déploiement : CLAUDE_MAIN_MODEL=claude-sonnet-4-6 sur Render.
const MAIN_MODEL = process.env.CLAUDE_MAIN_MODEL || 'claude-sonnet-5';
const MAIN_EFFORT = (process.env.CLAUDE_MAIN_EFFORT || 'low') as 'low' | 'medium' | 'high';

/** Sonnet 5 / Opus 5 / Fable réfléchissent par défaut : la réflexion consomme
 *  max_tokens et se règle par l'effort (Sonnet 4.6 : ni l'un ni l'autre). */
function thinksByDefault(model: string): boolean {
  return /sonnet-5|opus-5|fable/.test(model);
}

export function resolveModel(model?: string): string {
  return model === 'sonnet' ? MAIN_MODEL : 'claude-haiku-4-5-20251001';
}

/**
 * Crée un stream Claude et retourne un ReadableStream pour le client.
 */
export function createChatStream(options: StreamChatOptions): { stream: ReadableStream; promptSize: number } {
  const client = getClient();
  const model = resolveModel(options.model);
  const allMessages = buildMessages(options.messages, options.documents, options.maxMessages, options.images);
  const systemBlock = buildSystemBlock(options.systemPrompt);

  const promptSize = (options.systemPrompt || '').length +
    (options.documents || '').length +
    options.messages.slice(-(options.maxMessages || 10)).reduce((n, m) => n + m.content.length, 0);

  console.log(`[claude] model=${model} prompt=${promptSize} chars (docs=${options.documents ? 'yes' : 'no'}, cache=on)`);
  const t0 = Date.now();

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        const thinks = thinksByDefault(model);
        const stream = await client.messages.stream({
          model,
          // Marge pour la réflexion (sinon brouillon tronqué, cf. rejeu 28/09/2026)
          max_tokens: thinks ? Math.max(options.maxTokens || 0, 16000) : options.maxTokens || 4096,
          ...(thinks ? { output_config: { effort: MAIN_EFFORT } } : {}),
          system: systemBlock,
          messages: allMessages,
        });

        let firstChunk = true;
        for await (const chunk of stream) {
          if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
            if (firstChunk) { console.log(`[claude] first token in ${Date.now() - t0}ms`); firstChunk = false; }
            controller.enqueue(encoder.encode(chunk.delta.text));
          }
        }

        const finalMessage = await stream.finalMessage();
        recordUsage(options.label || 'stream', model, finalMessage.usage, Date.now() - t0, options.storeCode);
        const usage = finalMessage.usage as unknown as Record<string, number>;
        console.log(`[claude] done in ${Date.now() - t0}ms | stop=${finalMessage.stop_reason} | input=${usage.input_tokens} cache_create=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} output=${usage.output_tokens}`);
      } catch (streamErr) {
        const rawMsg = streamErr instanceof Error ? streamErr.message : 'Erreur stream';
        console.error('[claude] Stream error:', rawMsg);
        // Traduire les erreurs API en messages lisibles
        let msg = rawMsg;
        if (rawMsg.includes('Overloaded') || rawMsg.includes('overloaded')) {
          msg = 'Les serveurs Claude sont temporairement surchargés. Réessayez dans quelques secondes.';
        } else if (rawMsg.includes('credit') || rawMsg.includes('billing') || rawMsg.includes('balance')) {
          msg = 'Erreur de facturation — crédits API insuffisants.';
          console.error('[claude] BILLING ERROR — ne pas réessayer');
        } else if (rawMsg.includes('rate_limit') || rawMsg.includes('rate limit')) {
          msg = 'Trop de requêtes simultanées. Réessayez dans quelques secondes.';
        }
        controller.enqueue(encoder.encode(`__ERROR__${msg}`));
      } finally {
        controller.close();
      }
    },
  });

  return { stream: readable, promptSize };
}

/**
 * Appel Claude simple (non-streaming) — utilisé pour les analyses rapides.
 */
export async function callClaude(messages: MessageParam[], options?: { model?: string; maxTokens?: number; system?: string; label?: string; storeCode?: string }): Promise<string> {
  const client = getClient();
  const t0 = Date.now();
  const model = options?.model || 'claude-haiku-4-5-20251001';

  const result = await client.messages.create({
    model,
    max_tokens: options?.maxTokens || 120,
    ...(options?.system ? { system: options.system } : {}),
    messages,
  });

  recordUsage(options?.label || 'sync', model, result.usage, Date.now() - t0, options?.storeCode);
  console.log(`[claude] sync call ${model} in ${Date.now() - t0}ms`);
  return result.content[0].type === 'text' ? result.content[0].text.trim() : '';
}
