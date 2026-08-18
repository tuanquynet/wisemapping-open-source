import type { Database, SQLQueryBindings } from "bun:sqlite";

import type { DbAdapter, Statement } from "./adapter.ts";

/**
 * Wraps a `bun:sqlite` `Database` (synchronous) to satisfy the async
 * `DbAdapter` interface. Every call resolves immediately -- there is no real
 * asynchrony to introduce on Bun, only the interface shape D1 requires.
 *
 * `batch()` reuses `bun:sqlite`'s own `db.transaction()`, which already
 * gives exactly the all-or-nothing guarantee `DbAdapter.batch()` promises.
 *
 * `DbAdapter`'s params are `unknown[]` -- deliberately erased, since a
 * D1Adapter has its own binding-value union -- so every call here casts
 * back to bun:sqlite's `SQLQueryBindings[]` at this one boundary. Callers
 * are trusted to pass values SQLite can bind (string/number/bigint/null/
 * buffer), exactly as the existing repos already do today.
 */
export function createBunAdapter(db: Database): DbAdapter {
  return {
    async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
      const row = db.query<T, SQLQueryBindings[]>(sql).get(...(params as SQLQueryBindings[]));
      return row ?? null;
    },

    async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return db.query<T, SQLQueryBindings[]>(sql).all(...(params as SQLQueryBindings[]));
    },

    async run(sql: string, params: readonly unknown[] = []): Promise<void> {
      db.run(sql, params as SQLQueryBindings[]);
    },

    async batch<T = unknown>(statements: readonly Statement[]): Promise<T[][]> {
      return db.transaction(() => {
        // .query(sql).all(...) (not db.run()) so a RETURNING clause's rows
        // come back -- db.run() only reports {changes, lastInsertRowid}.
        return statements.map((statement) =>
          db
            .query<T, SQLQueryBindings[]>(statement.sql)
            .all(...((statement.params ?? []) as SQLQueryBindings[])),
        );
      })();
    },
  };
}
