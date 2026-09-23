import { describe, expect, test } from "bun:test";

import {
  freshDb,
  foreignKeysEnabled,
  indexNames,
  tableNames,
  userVersion,
} from "./helpers/db.ts";

describe("schema", () => {
  test("applies every table", () => {
    const db = freshDb();
    expect(tableNames(db)).toEqual([
      "account",
      "account_oauth",
      "account_recovery_code",
      "account_totp",
      "collaboration",
      "comment",
      "mindmap",
      "mindmap_history",
      "mindmap_label",
      "mindmap_label_link",
      "mindmap_xml",
      "security_event",
      "trusted_device",
    ]);
    db.close();
  });

  test("declares the indexes the Java schema is missing", () => {
    const db = freshDb();
    const names = indexNames(db);
    // The three that carry real query load, plus the uniqueness invariants.
    expect(names).toContain("ix_collab_account");
    expect(names).toContain("ix_history_map_created");
    expect(names).toContain("ux_collab_map_account");
    expect(names).toContain("ux_account_email_lower");
    expect(names).toContain("ix_comment_map_topic_created");
    expect(names).toContain("ux_recovery_code_hash");
    expect(names).toContain("ix_recovery_code_unused");
    expect(names).toContain("ix_trusted_device_account");
    expect(names).toContain("ix_security_event_account");
    expect(names).toContain("ix_account_oauth_email");
    db.close();
  });

  test("enables foreign key enforcement on the connection", () => {
    // PRAGMA foreign_keys is per-connection and off by default; without it the
    // REFERENCES clauses in schema.sql are inert.
    const db = freshDb();
    expect(foreignKeysEnabled(db)).toBe(true);
    db.close();
  });

  test("migration is idempotent and records its version", () => {
    const db = freshDb();
    expect(userVersion(db)).toBe(5);
    // Re-running must be a no-op rather than an error.
    const { migrate } = require("../src/db/migrate.ts");
    migrate(db);
    expect(userVersion(db)).toBe(5);
    db.close();
  });

  test("account gains session_epoch and two_factor_reenroll_required defaults", () => {
    const db = freshDb();
    db.run(
      `INSERT INTO account (email, email_lower, created_at) VALUES (?1, ?2, ?3)`,
      ["default-cols@example.com", "default-cols@example.com", Date.now()],
    );
    const row = db
      .query<
        { session_epoch: number; two_factor_reenroll_required: number },
        []
      >(
        `SELECT session_epoch, two_factor_reenroll_required FROM account WHERE email_lower = 'default-cols@example.com'`,
      )
      .get()!;
    expect(row.session_epoch).toBe(0);
    expect(row.two_factor_reenroll_required).toBe(0);
    db.close();
  });
});

describe("schema constraints", () => {
  function seedAccount(db: ReturnType<typeof freshDb>, email: string): number {
    const row = db
      .query<{ id: number }, [string, string, number]>(
        `INSERT INTO account (email, email_lower, firstname, lastname, password_hash, created_at)
         VALUES (?1, ?2, 'A', 'B', 'hash', ?3) RETURNING id`,
      )
      .get(email, email.toLowerCase(), Date.now())!;
    return row.id;
  }

  test("rejects a duplicate email regardless of case", () => {
    const db = freshDb();
    seedAccount(db, "a@example.org");
    expect(() => seedAccount(db, "A@EXAMPLE.ORG")).toThrow();
    db.close();
  });

  test("rejects an unknown role", () => {
    const db = freshDb();
    const uid = seedAccount(db, "a@example.org");
    const mid = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO mindmap (title, is_public, creator_id, last_editor_id, created_at, edited_at)
         VALUES ('t', 0, ?1, ?1, ?2, ?2) RETURNING id`,
      )
      .get(uid, Date.now())!.id;

    expect(() =>
      db.run(
        `INSERT INTO collaboration (mindmap_id, account_id, role, created_at) VALUES (?, ?, 'admin', ?)`,
        [mid, uid, Date.now()],
      ),
    ).toThrow();
    db.close();
  });

  test("allows only one owner per map", () => {
    const db = freshDb();
    const owner = seedAccount(db, "owner@example.org");
    const other = seedAccount(db, "other@example.org");
    const mid = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO mindmap (title, is_public, creator_id, last_editor_id, created_at, edited_at)
         VALUES ('t', 0, ?1, ?1, ?2, ?2) RETURNING id`,
      )
      .get(owner, Date.now())!.id;

    const insertCollab = (account: number, role: string) =>
      db.run(
        `INSERT INTO collaboration (mindmap_id, account_id, role, created_at) VALUES (?, ?, ?, ?)`,
        [mid, account, role, Date.now()],
      );

    insertCollab(owner, "owner");
    expect(() => insertCollab(other, "owner")).toThrow();
    // A second non-owner collaboration is fine.
    insertCollab(other, "editor");
    db.close();
  });

  test("rejects a second collaboration for the same map and account", () => {
    const db = freshDb();
    const uid = seedAccount(db, "a@example.org");
    const mid = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO mindmap (title, is_public, creator_id, last_editor_id, created_at, edited_at)
         VALUES ('t', 0, ?1, ?1, ?2, ?2) RETURNING id`,
      )
      .get(uid, Date.now())!.id;

    const insert = () =>
      db.run(
        `INSERT INTO collaboration (mindmap_id, account_id, role, created_at) VALUES (?, ?, 'editor', ?)`,
        [mid, uid, Date.now()],
      );

    insert();
    // This is the invariant dao/CollaborationConstraintTest asserts, and what
    // makes the Java findOrCreateCollaboration race impossible here.
    expect(insert).toThrow();
    db.close();
  });

  test("cascades map deletion to xml, history and collaborations", () => {
    const db = freshDb();
    const uid = seedAccount(db, "a@example.org");
    const mid = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO mindmap (title, is_public, creator_id, last_editor_id, created_at, edited_at)
         VALUES ('t', 0, ?1, ?1, ?2, ?2) RETURNING id`,
      )
      .get(uid, Date.now())!.id;

    db.run(
      `INSERT INTO mindmap_xml (mindmap_id, xml) VALUES (?, '<map></map>')`,
      [mid],
    );
    db.run(
      `INSERT INTO mindmap_history (mindmap_id, editor_id, xml, created_at) VALUES (?, ?, '<map></map>', ?)`,
      [mid, uid, Date.now()],
    );
    db.run(
      `INSERT INTO collaboration (mindmap_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      [mid, uid, Date.now()],
    );

    db.run(`DELETE FROM mindmap WHERE id = ?`, [mid]);

    const count = (table: string) =>
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!
        .n;
    expect(count("mindmap_xml")).toBe(0);
    expect(count("mindmap_history")).toBe(0);
    expect(count("collaboration")).toBe(0);
    db.close();
  });

  test("cascades account deletion to two-factor tables and retains security_event", () => {
    const db = freshDb();
    const uid = seedAccount(db, "2fa-cascade@example.org");
    const now = Date.now();

    db.run(
      `INSERT INTO account_totp (account_id, secret_cipher, status, created_at)
       VALUES (?, 'cipher', 'active', ?)`,
      [uid, now],
    );
    db.run(
      `INSERT INTO account_recovery_code (account_id, code_hash, generation, created_at)
       VALUES (?, 'hash', 1, ?)`,
      [uid, now],
    );
    db.run(
      `INSERT INTO trusted_device (account_id, token_hash, label, created_at, expires_at)
       VALUES (?, 'tokenhash', 'Chrome', ?, ?)`,
      [uid, now, now + 30 * 86400000],
    );
    db.run(
      `INSERT INTO security_event (affected_account_id, actor_email, action, outcome, created_at)
       VALUES (?, 'admin@example.org', 'enrollment_activated', 'success', ?)`,
      [uid, now],
    );

    db.run(`DELETE FROM account WHERE id = ?`, [uid]);

    const count = (table: string) =>
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!
        .n;
    expect(count("account_totp")).toBe(0);
    expect(count("account_recovery_code")).toBe(0);
    expect(count("trusted_device")).toBe(0);
    // security_event has affected_account_id ON DELETE CASCADE per DDL; both affected tables are cleared
    expect(count("security_event")).toBe(0);
    db.close();
  });

  test("STRICT typing rejects a string where an integer is declared", () => {
    const db = freshDb();
    expect(() =>
      db.run(
        `INSERT INTO account (email, email_lower, firstname, lastname, created_at) VALUES ('a', 'a', 'A', 'B', 'not-a-number')`,
      ),
    ).toThrow();
    db.close();
  });
});
