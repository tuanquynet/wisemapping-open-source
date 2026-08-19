import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Task 6.1: verifies that the D1 migration file (`migrations/0001_base_schema.sql`)
 * and the Bun SQLite schema (`src/db/schema.sql`) remain 100% byte/statement
 * identical.
 *
 * Bun uses `src/db/schema.sql` via `db/migrate.ts`, while Cloudflare D1 uses
 * `migrations/0001_base_schema.sql` via `wrangler d1 migrations apply`.
 * This test fails immediately in CI if one file is modified without updating
 * the other, preventing schema drift between runtimes.
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

  test("migrations/0001_base_schema.sql exists", () => {
    expect(existsSync(d1MigrationPath)).toBe(true);
  });

  test("statements in schema.sql match migrations/0001_base_schema.sql exactly", () => {
    const bunSql = readFileSync(bunSchemaPath, "utf-8");
    const d1Sql = readFileSync(d1MigrationPath, "utf-8");

    const bunStatements = normalizeSql(bunSql);
    const d1Statements = normalizeSql(d1Sql);

    expect(d1Statements.length).toBeGreaterThan(0);
    expect(d1Statements).toEqual(bunStatements);
  });

  test("normalizer catches deliberate statement differences", () => {
    const original = "CREATE TABLE a (id INTEGER); CREATE TABLE b (name TEXT);";
    const drifted = "CREATE TABLE a (id INTEGER); CREATE TABLE b (name TEXT, age INT);";

    expect(normalizeSql(original)).not.toEqual(normalizeSql(drifted));
  });
});
