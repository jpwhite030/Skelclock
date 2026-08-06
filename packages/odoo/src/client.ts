/**
 * Minimal Odoo JSON-RPC client.
 *
 * JSON-RPC rather than XML-RPC deliberately: the /jsonrpc endpoint is present
 * on Odoo Online, Odoo.sh and self-hosted from v12 onward, it needs no XML
 * dependency, and it is the endpoint least likely to be firewalled off on a
 * hosted instance. Everything goes through `executeKw`, which is the single
 * call Odoo exposes for arbitrary model access.
 */

export interface OdooConfig {
  /** e.g. https://skelscaff.odoo.com — no trailing slash. */
  url: string;
  db: string;
  username: string;
  /** An API key from Settings > Users > Account Security. Not the password. */
  apiKey: string;
  timeoutMs?: number;
}

export class OdooError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
    /** True when retrying could plausibly succeed (network, 5xx, timeout). */
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'OdooError';
  }
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: {
    message: string;
    data?: { message?: string; name?: string; debug?: string };
  };
}

export class OdooClient {
  private uid: number | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly config: OdooConfig) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    if (!config.url) throw new OdooError('ODOO_URL is not set');
    if (!config.db) throw new OdooError('ODOO_DB is not set');
  }

  private async rpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.config.url.replace(/\/+$/, '')}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: { service, method, args },
          // Odoo ignores id but the spec wants one; a constant is fine because
          // we never pipeline more than one call per request.
          id: 1,
        }),
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      throw new OdooError(
        aborted ? `Odoo request timed out after ${this.timeoutMs}ms` : `Cannot reach Odoo at ${this.config.url}`,
        cause,
        true, // network problems are exactly what the retry queue is for
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new OdooError(
        `Odoo returned HTTP ${response.status}`,
        await response.text().catch(() => undefined),
        response.status >= 500 || response.status === 429,
      );
    }

    const body = (await response.json()) as JsonRpcResponse<T>;

    if (body.error) {
      // Odoo buries the useful text a couple of levels down; surface the most
      // specific string we can so the office sees "Access denied" rather than
      // "Odoo Server Error" on the retry screen.
      const detail = body.error.data?.message ?? body.error.message;
      throw new OdooError(detail, body.error.data, false);
    }

    return body.result as T;
  }

  /** Logs in and caches the uid. Safe to call repeatedly. */
  async authenticate(): Promise<number> {
    if (this.uid !== null) return this.uid;

    const uid = await this.rpc<number | false>('common', 'authenticate', [
      this.config.db,
      this.config.username,
      this.config.apiKey,
      {},
    ]);

    if (typeof uid !== 'number' || uid === 0) {
      throw new OdooError(
        `Odoo rejected the credentials for "${this.config.username}" on database "${this.config.db}". ` +
          'Check ODOO_DB and that ODOO_API_KEY is an API key rather than a password.',
      );
    }

    this.uid = uid;
    return uid;
  }

  async version(): Promise<Record<string, unknown>> {
    return this.rpc('common', 'version', []);
  }

  async executeKw<T>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<T> {
    const uid = await this.authenticate();
    return this.rpc<T>('object', 'execute_kw', [
      this.config.db,
      uid,
      this.config.apiKey,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  searchRead<T>(
    model: string,
    domain: unknown[],
    fields: string[],
    options: { limit?: number; offset?: number; order?: string } = {},
  ): Promise<T[]> {
    return this.executeKw<T[]>(model, 'search_read', [domain], { fields, ...options });
  }

  create(model: string, values: Record<string, unknown>): Promise<number> {
    return this.executeKw<number>(model, 'create', [values]);
  }

  write(model: string, ids: number[], values: Record<string, unknown>): Promise<boolean> {
    return this.executeKw<boolean>(model, 'write', [ids, values]);
  }

  /** True when the model exists and this user may read it. */
  async modelExists(model: string): Promise<boolean> {
    try {
      await this.executeKw(model, 'fields_get', [], { attributes: ['type'] });
      return true;
    } catch {
      return false;
    }
  }

  /** Field names available on a model — used to probe an unfamiliar instance. */
  async fieldsOf(model: string): Promise<string[]> {
    const fields = await this.executeKw<Record<string, unknown>>(model, 'fields_get', [], {
      attributes: ['type', 'string'],
    });
    return Object.keys(fields).sort();
  }
}

// --- date handling ----------------------------------------------------------
// Odoo stores datetimes as naive UTC strings and will silently misinterpret an
// ISO string with an offset. Getting this wrong shifts every shift in the
// system by the AEST offset, so it lives in one place with tests on it.

export function toOdooDatetime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new OdooError(`Not a valid datetime: ${iso}`);
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function fromOdooDatetime(value: string): string {
  return `${value.replace(' ', 'T')}Z`;
}

export function toOdooDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new OdooError(`Not a valid date: ${iso}`);
  return new Date(ms).toISOString().slice(0, 10);
}
