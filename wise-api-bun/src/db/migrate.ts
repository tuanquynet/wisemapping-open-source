import type { Database } from "bun:sqlite";

import schemaSql from "./schema.sql" with { type: "text" };
import addCommentsSql from "../../migrations/0002_add_comments.sql" with { type: "text" };

/**
 * Migrations, versioned with `PRAGMA user_version`.
 *
 * Step 0 is the base schema. To evolve it, append an entry -- never edit an
 * existing one, since deployed databases have already run it. Every step is
 * applied inside a transaction, so a failure leaves user_version untouched.
 */
const steps: readonly { readonly description: string; readonly sql: string }[] =
  [
    { description: "base schema", sql: schemaSql },
    { description: "add comment table", sql: addCommentsSql },
  ];
export function migrate(db: Database): void {
  const current = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!.user_version;

  for (let version = current; version < steps.length; version++) {
    const step = steps[version]!;
    db.transaction(() => {
      db.exec(step.sql);
    })();
    // PRAGMA does not accept bound parameters; the value is a loop counter, not input.
    db.exec(`PRAGMA user_version = ${version + 1}`);
  }
}
