import { describe, expect, test } from "bun:test";

import { createBunAdapter } from "../src/db/bunAdapter.ts";
import { freshDb } from "./helpers/db.ts";

/**
 * Task 1.1: the BunSqliteAdapter must satisfy the async DbAdapter interface
 * while preserving bun:sqlite's exact behavior -- these tests are the
 * regression oracle for both this adapter and, later, the D1Adapter, which
 * must satisfy the same contract (see tasks/plan.md Architecture Decision 1).
 */

interface AccountRow {
  email: string;
  email_lower: string;
  created_at: number;
}

const INSERT_ACCOUNT_SQL =
  "INSERT INTO account (email, email_lower, created_at) VALUES (?1, ?2, ?3)";

describe("createBunAdapter", () => {
  test("get returns null when no row matches", async () => {
    const adapter = createBunAdapter(freshDb());
    const row = await adapter.get<AccountRow>(
      "SELECT email, email_lower, created_at FROM account WHERE id = ?1",
      [999],
    );
    expect(row).toBeNull();
  });

  test("get returns a row with multiple bound params applied in order", async () => {
    const adapter = createBunAdapter(freshDb());
    await adapter.run(INSERT_ACCOUNT_SQL, ["User@Example.com", "user@example.com", 1000]);

    const row = await adapter.get<AccountRow>(
      "SELECT email, email_lower, created_at FROM account WHERE email_lower = ?1",
      ["user@example.com"],
    );

    expect(row).toEqual({ email: "User@Example.com", email_lower: "user@example.com", created_at: 1000 });
  });

  test("all returns every matching row in order", async () => {
    const adapter = createBunAdapter(freshDb());
    await adapter.run(INSERT_ACCOUNT_SQL, ["a@x.com", "a@x.com", 1]);
    await adapter.run(INSERT_ACCOUNT_SQL, ["b@x.com", "b@x.com", 2]);

    const rows = await adapter.all<AccountRow>("SELECT email_lower FROM account ORDER BY id", []);

    expect(rows.map((r) => r.email_lower)).toEqual(["a@x.com", "b@x.com"]);
  });

  test("all returns an empty array when nothing matches", async () => {
    const adapter = createBunAdapter(freshDb());
    const rows = await adapter.all<AccountRow>("SELECT * FROM account", []);
    expect(rows).toEqual([]);
  });

  test("run executes a write with no return value", async () => {
    const adapter = createBunAdapter(freshDb());
    const result = await adapter.run(INSERT_ACCOUNT_SQL, ["a@x.com", "a@x.com", 1]);
    expect(result).toBeUndefined();

    const row = await adapter.get<AccountRow>(
      "SELECT email_lower FROM account WHERE email_lower = ?1",
      ["a@x.com"],
    );
    expect(row?.email_lower).toBe("a@x.com");
  });

  test("batch commits every statement atomically", async () => {
    const adapter = createBunAdapter(freshDb());

    await adapter.batch([
      { sql: INSERT_ACCOUNT_SQL, params: ["a@x.com", "a@x.com", 1] },
      { sql: INSERT_ACCOUNT_SQL, params: ["b@x.com", "b@x.com", 2] },
    ]);

    const rows = await adapter.all<AccountRow>("SELECT email_lower FROM account ORDER BY id", []);
    expect(rows.map((r) => r.email_lower)).toEqual(["a@x.com", "b@x.com"]);
  });

  test("batch rolls back every statement, including earlier valid ones, when one fails", async () => {
    const adapter = createBunAdapter(freshDb());

    await expect(
      adapter.batch([
        // Individually valid -- must still be rolled back when statement 2 fails.
        { sql: INSERT_ACCOUNT_SQL, params: ["a@x.com", "dup@x.com", 1] },
        // Violates ux_account_email_lower against the row above.
        { sql: INSERT_ACCOUNT_SQL, params: ["b@x.com", "dup@x.com", 2] },
      ]),
    ).rejects.toThrow();

    const rows = await adapter.all<AccountRow>("SELECT * FROM account", []);
    expect(rows).toHaveLength(0);
  });
});
