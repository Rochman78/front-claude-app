/**
 * Service Claude — centralise la construction des appels à l'API Anthropic.
 */

import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

type MessageParam = Anthropic.Messages.MessageParam;

export interface StreamChatOptions {
  systemPrompt: string;
  messages: { role: string; content: string }[];
  model?: 'sonnet' | string;
  documents?: string;
  maxTokens?: number;
  maxMessages?: number;
}

/**
 * Construit les messages avec documents en prefix (cachés) + historique.
 */
export function buildMessages(messages: { role: string; content: string }[], documents?: string, maxMessages = 10): MessageParam[] {
  const trimmed = messages.slice(-maxMessages);

  const docPrefix: MessageParam[] = documents
    ? [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: `DOCUMENTS DE RÉFÉRENCE (à consulter pour répondre au client) :\n\n${documents}`,
              cache_control: { type: 'ephemeral' as const },
            },
          ],
        },
        {
          role: 'assistant' as const,
          content: 'Bien noté. Je dispose des documents de référence et je suis prêt à analyser le mail du client selon le workflow en 3 étapes.',
        },
      ]
    : [];

  return [
    ...docPrefix,
    ...trimmed.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];
}

/**
 * Construit le system prompt avec cache_control.
 */
export function buildSystemBlock(systemPrompt: string): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: 'text' as const,
      text: systemPrompt || 'Tu es un assistant IA utile.',
      cache_control: { type: 'ephemeral' as const },
    },
  ];
}

/**
 * Résout le model ID à partir du nom court.
 */
export function resolveModel(model?: string): string {
  return model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
}

/**
 * Crée un stream Claude et retourne un ReadableStream pour le client.
 */
export function createChatStream(options: StreamChatOptions): { stream: ReadableStream; promptSize: number } {
  const client = getClient();
  const model = resolveModel(options.model);
  const allMessages = buildMessages(options.messages, options.documents, options.maxMessages);
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
        const stream = await client.messages.stream({
          model,
          max_tokens: options.maxTokens || 4096,
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
        const usage = finalMessage.usage as unknown as Record<string, number>;
        console.log(`[claude] done in ${Date.now() - t0}ms | input=${usage.input_tokens} cache_create=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} output=${usage.output_tokens}`);
      } catch (streamErr) {
        const msg = streamErr instanceof Error ? streamErr.message : 'Erreur stream';
        console.error('[claude] Stream error:', msg);
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
export async function callClaude(messages: MessageParam[], options?: { model?: string; maxTokens?: number; system?: string }): Promise<string> {
  const client = getClient();
  const t0 = Date.now();
  const model = options?.model || 'claude-haiku-4-5-20251001';

  const result = await client.messages.create({
    model,
    max_tokens: options?.maxTokens || 120,
    ...(options?.system ? { system: options.system } : {}),
    messages,
  });

  console.log(`[claude] sync call ${model} in ${Date.now() - t0}ms`);
  return result.content[0].type === 'text' ? result.content[0].text.trim() : '';
}
