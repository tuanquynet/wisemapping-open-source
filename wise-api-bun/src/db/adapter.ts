/**
 * The minimal async surface every repository needs, satisfied by both the
 * Bun runtime (`bunAdapter.ts`, wrapping synchronous `bun:sqlite`) and
 * Cloudflare D1 (natively async). Repos, services, middleware, and routes
 * migrate to call this interface exclusively in Phase 2+ of the Cloudflare
 * port (tasks/plan.md); until then, `db/client.ts`'s existing `db` export (a
 * raw `bun:sqlite` `Database`) keeps serving every call site unmodified.
 *
 * `batch()` is the only way to express what used to be `db.transaction()`:
 * D1 has no interactive `BEGIN`/`COMMIT` from the Workers binding, only an
 * all-or-nothing list of statements (see Architecture Decision 2 in
 * tasks/plan.md). Both adapters must honor the same all-or-nothing guarantee
 * so a route written against this interface behaves identically on Bun and
 * on Workers.
 */

/** A SQL statement plus its positional (`?1`, `?2`, ...) bind parameters. */
export interface Statement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

export interface DbAdapter {
  /** Runs a query and returns its first row, or `null` if none matched. */
  get<T>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  /** Runs a query and returns every matching row. */
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs a statement with no rows to read back (INSERT/UPDATE/DELETE without RETURNING). */
  run(sql: string, params?: readonly unknown[]): Promise<void>;
  /**
   * Runs every statement atomically: all commit, or none do. Returns one
   * result array per statement, in order -- each populated from that
   * statement's `RETURNING` clause, or empty if it had none. Confirmed
   * against Cloudflare D1's real `batch()`, which returns exactly this
   * shape (`D1Result[]`, each with a `.results` array) before this
   * interface was extended to match it (Task 3.1, tasks/plan.md).
   */
  batch<T = unknown>(statements: readonly Statement[]): Promise<T[][]>;
}
