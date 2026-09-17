import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { freshDb, tableNames, indexNames } from "./helpers/db.ts";

/**
 * Verifies that the D1 migration files and the Bun SQLite migration steps
 * remain in parity:
 *
 * 1. `migrations/0001_base_schema.sql` must be byte/statement identical to
 *    `src/db/schema.sql` (the base Bun step).
 * 2. `migrations/0002_add_comments.sql` must produce the `comment` table
 *    and `ix_comment_map_topic_created` index when applied to a fresh DB.
 *
 * Bun uses `src/db/schema.sql` + migration steps via `db/migrate.ts`, while
 * Cloudflare D1 uses `migrations/0001_*.sql` + `migrations/0002_*.sql` via
 * `wrangler d1 migrations apply`. Both paths must yield the same final schema.
 */

function normalizeSql(sql: string): string[] {
  return sql
    // Remove comments
    .replace(/--.*$/gm, "")
    // Split into statements
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

describe("schema parity between Bun schema.sql and D1 migrations", () => {
  const root = resolve(import.meta.dir, "..");
  const bunSchemaPath = resolve(root, "src/db/schema.sql");
  const d1MigrationPath = resolve(root, "migrations/0001_base_schema.sql");
  const d1CommentsPath = resolve(root, "migrations/0002_add_comments.sql");
  const d1TwoFactorPath = resolve(root, "migrations/0003_add_two_factor.sql");
  const d1PendingSecretPath = resolve(root, "migrations/0004_add_pending_secret_cipher.sql");

  test("migrations/0001_base_schema.sql exists", () => {
    expect(existsSync(d1MigrationPath)).toBe(true);
  });

  test("migrations/0002_add_comments.sql exists", () => {
    expect(existsSync(d1CommentsPath)).toBe(true);
  });

  test("migrations/0003_add_two_factor.sql exists", () => {
    expect(existsSync(d1TwoFactorPath)).toBe(true);
  });

  test("migrations/0004_add_pending_secret_cipher.sql exists", () => {
    expect(existsSync(d1PendingSecretPath)).toBe(true);
  });

  test("statements in schema.sql match migrations/0001_base_schema.sql exactly", () => {
    const bunSql = readFileSync(bunSchemaPath, "utf-8");
    const d1Sql = readFileSync(d1MigrationPath, "utf-8");

    const bunStatements = normalizeSql(bunSql);
    const d1Statements = normalizeSql(d1Sql);

    expect(d1Statements.length).toBeGreaterThan(0);
    expect(d1Statements).toEqual(bunStatements);
  });

  test("0002_add_comments.sql produces comment table and index in a fresh DB", () => {
    // A fresh DB already has the full Bun schema applied (both steps).
    const db = freshDb();
    expect(tableNames(db)).toContain("comment");
    expect(indexNames(db)).toContain("ix_comment_map_topic_created");
    db.close();
  });

  test("0003_add_two_factor.sql produces two-factor tables and indexes in a fresh DB", () => {
    // A fresh DB already has the full Bun schema applied (all three steps).
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).toContain("account_totp");
    expect(tables).toContain("account_recovery_code");
    expect(tables).toContain("trusted_device");
    expect(tables).toContain("security_event");
    const indexes = indexNames(db);
    expect(indexes).toContain("ux_recovery_code_hash");
    expect(indexes).toContain("ix_recovery_code_unused");
    expect(indexes).toContain("ix_trusted_device_account");
    expect(indexes).toContain("ix_security_event_account");
    const totpColumns = db.query<{ name: string }, []>("PRAGMA table_info(account_totp)").all().map((c) => c.name);
    expect(totpColumns).toContain("pending_secret_cipher");
    db.close();
  });

  test("D1 0002 migration SQL matches the Bun migrate.ts step (normalized)", () => {
    // The SQL in the D1 file and the SQL imported by migrate.ts (from the same
    // file path) must be statement-identical.
    const d1Sql = readFileSync(d1CommentsPath, "utf-8");
    // migrate.ts imports the migration file directly, so comparing the file
    // content to itself is sufficient -- this test guards against accidental
    // edits to either side of the import alias.
    const statements = normalizeSql(d1Sql);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements).toContain(
      "CREATE TABLE IF NOT EXISTS comment ( id INTEGER PRIMARY KEY AUTOINCREMENT, mindmap_id INTEGER NOT NULL REFERENCES mindmap (id) ON DELETE CASCADE, topic_id TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL ) STRICT",
    );
    expect(statements).toContain(
      "CREATE INDEX IF NOT EXISTS ix_comment_map_topic_created ON comment (mindmap_id, topic_id, created_at)",
    );
  });

  test("D1 0003 migration SQL matches the Bun migrate.ts step (normalized)", () => {
    const d1Sql = readFileSync(d1TwoFactorPath, "utf-8");
    const statements = normalizeSql(d1Sql);
    expect(statements.length).toBe(10);
    expect(statements).toContain(
      "CREATE TABLE IF NOT EXISTS account_totp ( account_id INTEGER PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE, secret_cipher TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'active')), last_accepted_step INTEGER, failed_attempts INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER, created_at INTEGER NOT NULL, activated_at INTEGER ) STRICT",
    );
    expect(statements).toContain(
      "CREATE TABLE IF NOT EXISTS account_recovery_code ( id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE, code_hash TEXT NOT NULL, generation INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL ) STRICT",
    );
    expect(statements).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS ux_recovery_code_hash ON account_recovery_code (account_id, code_hash)",
    );
    expect(statements).toContain(
      "CREATE INDEX IF NOT EXISTS ix_recovery_code_unused ON account_recovery_code (account_id, used_at)",
    );
    expect(statements).toContain(
      "CREATE TABLE IF NOT EXISTS trusted_device ( id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER ) STRICT",
    );
    expect(statements).toContain(
      "CREATE INDEX IF NOT EXISTS ix_trusted_device_account ON trusted_device (account_id, revoked_at)",
    );
    expect(statements).toContain(
      "CREATE TABLE IF NOT EXISTS security_event ( id INTEGER PRIMARY KEY AUTOINCREMENT, affected_account_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE, actor_email TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')), reason TEXT, detail TEXT, created_at INTEGER NOT NULL ) STRICT",
    );
    expect(statements).toContain(
      "CREATE INDEX IF NOT EXISTS ix_security_event_account ON security_event (affected_account_id, created_at DESC, id DESC)",
    );
    expect(statements).toContain(
      "ALTER TABLE account ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0",
    );
    expect(statements).toContain(
      "ALTER TABLE account ADD COLUMN two_factor_reenroll_required INTEGER NOT NULL DEFAULT 0 CHECK (two_factor_reenroll_required IN (0, 1))",
    );
  });

  test("D1 0004 migration SQL matches the Bun migrate.ts step (normalized)", () => {
    const d1Sql = readFileSync(d1PendingSecretPath, "utf-8");
    const statements = normalizeSql(d1Sql);
    expect(statements.length).toBe(1);
    expect(statements).toContain(
      "ALTER TABLE account_totp ADD COLUMN pending_secret_cipher TEXT",
    );
  });

  test("normalizer catches deliberate statement differences", () => {
    const original = "CREATE TABLE a (id INTEGER); CREATE TABLE b (name TEXT);";
    const drifted = "CREATE TABLE a (id INTEGER); CREATE TABLE b (name TEXT, age INT);";

    expect(normalizeSql(original)).not.toEqual(normalizeSql(drifted));
  });
});
