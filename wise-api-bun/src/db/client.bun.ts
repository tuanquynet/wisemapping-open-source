import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { config } from "../config.bun.ts";
import { createBunAdapter } from "./bunAdapter.ts";
import { setDbAdapter } from "./client.ts";
import { migrate } from "./migrate.ts";

/**
 * Opens an embedded SQLite database on Bun and applies the pragmas that make
 * SQLite behave sanely for a server process, then runs migrations.
 */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true, strict: true });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA cache_size = -16000");

  migrate(db);
  return db;
}

export const db = openDatabase(config.dbPath);

// Initialize the shared dbAdapter with the Bun adapter on import.
setDbAdapter(createBunAdapter(db));
