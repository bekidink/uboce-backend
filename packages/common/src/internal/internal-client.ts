import { CORRELATION_HEADER, currentCorrelationId } from '../context.js';

export interface InternalClientOptions {
  /** Identity base URL, e.g. http://localhost:4101 */
  identityUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}

/** An internal call that returned a non-2xx status. */
export class InternalCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    url: string,
  ) {
    super(`Internal call ${url} failed with ${status}`);
  }
}

/**
 * Calls other services' /api/v1/internal routes with a short-lived service
 * token (PRD 5.1, 8.1). Tokens are cached until shortly before they expire.
 */
export class InternalClient {
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(private readonly options: InternalClientOptions) {}

  get<T>(url: string) {
    return this.request<T>('GET', url);
  }

  post<T>(url: string, body: unknown) {
    return this.request<T>('POST', url, body);
  }

  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    // Only idempotent reads are retried; a retried write could apply twice.
    const attempts = method === 'GET' ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(100 * 2 ** attempt + Math.random() * 100);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${await this.serviceToken()}`,
            'content-type': 'application/json',
            [CORRELATION_HEADER]: currentCorrelationId() ?? crypto.randomUUID(),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
        });
        const text = await res.text();
        const parsed = text ? JSON.parse(text) : null;
        if (res.status === 401) this.cached = null;
        if (res.ok) return parsed as T;
        lastError = new InternalCallError(res.status, parsed, url);
        if (res.status < 500) break;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async serviceToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 30_000) return this.cached.token;
    this.pending ??= this.fetchToken().finally(() => (this.pending = null));
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const res = await fetch(`${this.options.identityUrl}/api/v1/internal/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: this.options.clientId, clientSecret: this.options.clientSecret }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
    });
    if (!res.ok) throw new InternalCallError(res.status, await res.text(), 'identity /internal/token');
    const { accessToken, expiresIn } = (await res.json()) as { accessToken: string; expiresIn: number };
    this.cached = { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 };
    return accessToken;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
