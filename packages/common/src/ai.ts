// Groq (OpenAI-compatible chat completions) for assistant features: RFQ drafting,
// quotation comparison, report summaries, product descriptions. Optional: without
// GROQ_API_KEY every caller falls back to its non-AI behaviour.
import { Logger } from '@nestjs/common';
import type { z } from 'zod';

import { AppError } from './errors.js';

const logger = new Logger('Groq');

export interface AiRequest<T> {
  system: string;
  user: string;
  /** Validates (and types) the JSON the model returns. */
  schema: z.ZodType<T>;
  maxTokens?: number;
  temperature?: number;
}

export class GroqClient {
  constructor(
    private readonly apiKey = process.env.GROQ_API_KEY,
    private readonly model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    private readonly baseUrl = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1',
  ) {}

  get enabled() {
    return Boolean(this.apiKey);
  }

  get modelName() {
    return this.model;
  }

  /** A JSON answer validated against `schema`; throws AppError(503) when unavailable or invalid. */
  async json<T>(req: AiRequest<T>): Promise<T> {
    if (!this.apiKey) throw new AppError(503, 'ai_unavailable', 'The assistant is not configured');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: 'json_object' },
          temperature: req.temperature ?? 0.2,
          max_completion_tokens: req.maxTokens ?? 2000,
          messages: [
            { role: 'system', content: `${req.system}\nAnswer with a single JSON object only.` },
            { role: 'user', content: req.user },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      logger.warn(`Groq request failed: ${(error as Error).message}`);
      throw new AppError(503, 'ai_unavailable', 'The assistant could not be reached; try again');
    }
    const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    if (!res.ok) {
      logger.warn(`Groq ${res.status}: ${body.error?.message ?? 'error'}`);
      throw new AppError(503, 'ai_unavailable', res.status === 429 ? 'The assistant is busy; try again shortly' : 'The assistant could not answer');
    }
    const content = body.choices?.[0]?.message?.content ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AppError(502, 'ai_invalid', 'The assistant gave an unreadable answer; try again');
    }
    const result = req.schema.safeParse(parsed);
    if (!result.success) {
      logger.warn(`Groq answer did not match the schema: ${result.error.message.slice(0, 300)}`);
      throw new AppError(502, 'ai_invalid', 'The assistant gave an incomplete answer; try again');
    }
    return result.data;
  }
}
