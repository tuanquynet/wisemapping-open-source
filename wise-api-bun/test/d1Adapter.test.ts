import { describe, expect, test } from "bun:test";

import { createD1Adapter } from "../src/db/d1Adapter.ts";
import type { DbAdapter } from "../src/db/adapter.ts";

/**
 * Task 6.2: `createD1Adapter` wraps Cloudflare D1's native `D1Database` binding
 * into the async `DbAdapter` interface.
 */
function createMockD1() {
  const statementsExecuted: { sql: string; params: unknown[] }[] = [];

  function createStmt(sql: string, params: unknown[] = []) {
    return {
      bind(...newParams: unknown[]) {
        return createStmt(sql, newParams);
      },
      async first<T>() {
        statementsExecuted.push({ sql, params });
        if (sql.includes("WHERE id = 999")) return null;
        return { id: 1, email: "d1@example.com" } as T;
      },
      async all<T>() {
        statementsExecuted.push({ sql, params });
        return {
          results: [{ id: 1, email: "d1@example.com" }, { id: 2, email: "d2@example.com" }] as T[],
          success: true,
        };
      },
      async run() {
        statementsExecuted.push({ sql, params });
        return { success: true };
      },
    };
  }

  return {
    statementsExecuted,
    prepare(sql: string) {
      return createStmt(sql, []);
    },
    async batch<T>(statements: any[]) {
      return statements.map((_s, idx) => ({
        results: idx === 0 ? [{ id: 42, title: "Batch Map" }] : [],
        success: true,
      }));
    },
  } as any;
}

describe("createD1Adapter", () => {
  test("get executes prepare().bind().first() and returns row or null", async () => {
    const mockD1 = createMockD1();
    const adapter: DbAdapter = createD1Adapter(mockD1);

    const row = await adapter.get<{ id: number; email: string }>(
      "SELECT * FROM account WHERE email = ?1",
      ["d1@example.com"],
    );
    expect(row).toEqual({ id: 1, email: "d1@example.com" });
    expect(mockD1.statementsExecuted[0]).toEqual({
      sql: "SELECT * FROM account WHERE email = ?1",
      params: ["d1@example.com"],
    });

    const nullRow = await adapter.get("SELECT * FROM account WHERE id = 999", []);
    expect(nullRow).toBeNull();
  });

  test("all executes prepare().bind().all() and extracts results array", async () => {
    const mockD1 = createMockD1();
    const adapter: DbAdapter = createD1Adapter(mockD1);

    const rows = await adapter.all<{ id: number; email: string }>(
      "SELECT * FROM account ORDER BY id",
    );
    expect(rows).toEqual([
      { id: 1, email: "d1@example.com" },
      { id: 2, email: "d2@example.com" },
    ]);
  });

  test("run executes prepare().bind().run()", async () => {
    const mockD1 = createMockD1();
    const adapter: DbAdapter = createD1Adapter(mockD1);

    await adapter.run("UPDATE account SET locale = ?1 WHERE id = ?2", ["es", 1]);
    expect(mockD1.statementsExecuted[0]).toEqual({
      sql: "UPDATE account SET locale = ?1 WHERE id = ?2",
      params: ["es", 1],
    });
  });

  test("batch maps statements to d1.batch and returns per-statement results T[][]", async () => {
    const mockD1 = createMockD1();
    const adapter: DbAdapter = createD1Adapter(mockD1);

    const results = await adapter.batch<{ id: number; title: string }>([
      { sql: "INSERT INTO mindmap (title) VALUES (?1) RETURNING *", params: ["Batch Map"] },
      { sql: "INSERT INTO mindmap_xml (mindmap_id, xml) VALUES (?1, ?2)", params: [42, "<xml/>"] },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual([{ id: 42, title: "Batch Map" }]);
    expect(results[1]).toEqual([]);
  });
});
