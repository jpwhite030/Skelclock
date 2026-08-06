/**
 * Database access.
 *
 * Deliberately a bare `query` interface rather than an ORM. Two reasons: the
 * same code has to run against PGlite (local dev and tests, no Docker needed)
 * and against Supabase's Postgres, and the audit triggers in migration 0002
 * depend on transaction-local settings that ORMs tend to hide.
 */

export interface QueryResult<T> {
  rows: T[];
}

export interface Db {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;

  /**
   * Checks out a single connection for the caller's exclusive use.
   *
   * Required for correctness, not performance: with a connection pool, BEGIN
   * and COMMIT issued through `query` can land on different connections, which
   * silently leaves a transaction open on one and commits nothing on the other.
   * Single-connection drivers (PGlite) may omit this and withTransaction falls
   * back to issuing the statements directly.
   */
  connect?(): Promise<PooledDb>;
}

export interface PooledDb extends Db {
  release(): void;
}

export interface TxDb extends Db {
  /** Present only inside withTransaction. */
  readonly inTransaction: true;
}

export class DbError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DbError';
  }
}

/**
 * Who is acting and why, threaded to the audit triggers.
 *
 * `set_local` scopes these to the transaction, so a pooled connection can
 * never leak one request's actor into the next one's audit rows.
 */
export interface AuditContext {
  actorUserId?: string | null;
  reason?: string | null;
}

export async function applyAuditContext(db: Db, ctx: AuditContext): Promise<void> {
  // set_config(..., true) is the function form of SET LOCAL and, unlike SET
  // LOCAL, accepts a parameter — which keeps the reason text parameterised
  // rather than interpolated.
  await db.query('select set_config($1, $2, true)', [
    'skelclock.actor_user_id',
    ctx.actorUserId ?? '',
  ]);
  await db.query('select set_config($1, $2, true)', ['skelclock.reason', ctx.reason ?? '']);
}

export async function withTransaction<T>(
  db: Db,
  fn: (tx: TxDb) => Promise<T>,
  ctx: AuditContext = {},
): Promise<T> {
  // Pin one connection for the whole transaction where the driver supports it.
  // Without this a pool would scatter BEGIN, the writes and COMMIT across
  // different connections and commit nothing.
  const pooled = db.connect ? await db.connect() : null;
  const conn: Db = pooled ?? db;

  await conn.query('begin');
  try {
    const tx = conn as TxDb;
    await applyAuditContext(tx, ctx);
    const result = await fn(tx);
    await conn.query('commit');
    return result;
  } catch (error) {
    try {
      await conn.query('rollback');
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw error;
  } finally {
    pooled?.release();
  }
}

/** First row, or null. Saves a `[0] ?? null` at every call site. */
export async function one<T>(
  db: Db,
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const { rows } = await db.query<T>(text, params);
  return rows[0] ?? null;
}

export async function oneOrFail<T>(
  db: Db,
  text: string,
  params: unknown[],
  what: string,
): Promise<T> {
  const row = await one<T>(db, text, params);
  if (!row) throw new DbError(`${what} not found`);
  return row;
}
