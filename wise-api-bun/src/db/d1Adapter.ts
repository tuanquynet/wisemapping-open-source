import type { DbAdapter, Statement } from "./adapter.ts";

/**
 * Wraps Cloudflare D1's native `D1Database` binding to satisfy the async
 * `DbAdapter` interface (Task 6.2, tasks/plan.md, Architecture Decision 1).
 */
export function createD1Adapter(d1: D1Database): DbAdapter {
  return {
    async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
      const stmt = d1.prepare(sql);
      const bound = params.length > 0 ? stmt.bind(...params) : stmt;
      const row = await bound.first<T>();
      return row ?? null;
    },

    async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const stmt = d1.prepare(sql);
      const bound = params.length > 0 ? stmt.bind(...params) : stmt;
      const result = await bound.all<T>();
      return result.results ?? [];
    },

    async run(sql: string, params: readonly unknown[] = []): Promise<void> {
      const stmt = d1.prepare(sql);
      const bound = params.length > 0 ? stmt.bind(...params) : stmt;
      await bound.run();
    },

    async batch<T = unknown>(statements: readonly Statement[]): Promise<T[][]> {
      if (statements.length === 0) return [];
      const preparedList = statements.map((s) => {
        const stmt = d1.prepare(s.sql);
        return s.params && s.params.length > 0 ? stmt.bind(...s.params) : stmt;
      });
      const results = await d1.batch<T>(preparedList);
      return results.map((r) => r.results ?? []);
    },
  };
}
