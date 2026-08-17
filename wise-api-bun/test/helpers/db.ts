import type { Database } from "bun:sqlite";

import { openDatabase, db as appDb } from "../../src/db/client.ts";

/**
 * Clear the shared application database between tests.
 *
 * Repositories bind to the module-level `db` singleton, which under
 * `DB_PATH=:memory:` is one database for the whole test process. Without an
 * explicit reset, ordering between test files would become load-bearing.
 */
export function resetDb(): void {
  appDb.exec("PRAGMA foreign_keys = OFF");
  for (const table of tableNames(appDb)) {
    appDb.run(`DELETE FROM ${table}`);
  }
  // Reset AUTOINCREMENT counters so ids are predictable per test.
  appDb.run(`DELETE FROM sqlite_sequence`);
  appDb.exec("PRAGMA foreign_keys = ON");
}

/**
 * A fresh in-memory database with the full schema applied.
 *
 * Each call is completely isolated -- `:memory:` databases are per-connection --
 * so tests never share state and never need cleanup between cases.
 */
export function freshDb(): Database {
  return openDatabase(":memory:");
}

/** Assert that foreign keys are actually enforced on this connection. */
export function foreignKeysEnabled(db: Database): boolean {
  const row = db
    .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get();
  return row?.foreign_keys === 1;
}

export function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
    .user_version;
}

export function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((r) => r.name);
}

export function indexNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((r) => r.name);
}
