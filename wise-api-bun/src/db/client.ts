import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { config } from "../config.ts";
import { migrate } from "./migrate.ts";

/**
 * Opens a database and applies the pragmas that make SQLite behave sanely for
 * a server process, then runs migrations.
 *
 * `foreign_keys` deserves special mention: it is per-connection and OFF by
 * default, so a missing PRAGMA here silently turns every `REFERENCES` clause in
 * schema.sql into documentation.
 */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true, strict: true });

  // WAL lets readers proceed during a write. Not applicable to :memory:, where
  // SQLite silently keeps the default journal mode.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  // Safe under WAL: a crash can lose the last transaction but cannot corrupt.
  db.exec("PRAGMA synchronous = NORMAL");
  // Negative means KiB rather than pages: 16 MB of page cache.
  db.exec("PRAGMA cache_size = -16000");

  migrate(db);
  return db;
}

export const db = openDatabase(config.dbPath);
