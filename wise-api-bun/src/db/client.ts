import type { DbAdapter } from "./adapter.ts";

/**
 * Shared runtime-agnostic database adapter holder (Task 6.2, tasks/plan.md).
 *
 * All 6 repositories (`accounts`, `collaborations`, `history`, `labels`,
 * `mindmaps`, `mindmapXml`) import `dbAdapter` from this module.
 *
 * On Bun, `client.bun.ts` initializes this with `BunSqliteAdapter`.
 * On Cloudflare Workers, `workers.ts` initializes this with `D1Adapter`
 * wrapping `c.env.DB`.
 */

let activeAdapter: DbAdapter | null = null;

export function setDbAdapter(adapter: DbAdapter): void {
  activeAdapter = adapter;
}

export function getDbAdapter(): DbAdapter {
  if (activeAdapter === null) {
    throw new Error(
      "DbAdapter has not been initialized. Ensure client.bun.ts is imported on Bun or setDbAdapter() is called on Workers.",
    );
  }
  return activeAdapter;
}

export const dbAdapter: DbAdapter = {
  get: (sql, params) => getDbAdapter().get(sql, params),
  all: (sql, params) => getDbAdapter().all(sql, params),
  run: (sql, params) => getDbAdapter().run(sql, params),
  batch: (stmts) => getDbAdapter().batch(stmts),
};
