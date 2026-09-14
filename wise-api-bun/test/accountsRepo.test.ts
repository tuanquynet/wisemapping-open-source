import { beforeEach, describe, expect, test } from "bun:test";

import * as accounts from "../src/db/repos/accounts.ts";
import { db } from "../src/db/client.bun.ts";
import { API, json, post } from "./helpers/client.ts";
import { login } from "./helpers/auth.ts";
import { resetDb } from "./helpers/db.ts";

beforeEach(() => resetDb());

/**
 * Placeholder accounts are created when a map is shared with an email that has
 * no account. Registration must then UPGRADE that row rather than insert a
 * second one -- otherwise the collaborations granted before signup are orphaned
 * and the new account sees none of the maps shared with it.
 *
 * M4 depends on this, so it is tested at the repository level now.
 */
describe("invitee placeholder upgrade", () => {
  test("a placeholder cannot authenticate", async () => {
    await accounts.createPlaceholder("invited@example.org");

    const res = await post(`${API}/authenticate`, {
      json: { email: "invited@example.org", password: "password123" },
    });
    expect(res.status).toBe(401);
  });

  test("registration upgrades the placeholder in place, keeping its id", async () => {
    const placeholder = await accounts.createPlaceholder("invited@example.org");
    expect(placeholder.isRegistered).toBe(false);

    const res = await post(`${API}/users/`, {
      json: {
        email: "invited@example.org",
        firstname: "Invited",
        lastname: "Person",
        password: "password123",
        acceptedTerms: true,
      },
    });
    expect(res.status).toBe(201);

    // Same id -- this is what preserves rows that reference the account.
    expect(res.headers.get("ResourceId")).toBe(String(placeholder.id));

    const rows = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM account`)
      .get()!;
    expect(rows.n).toBe(1);

    const upgraded = (await accounts.findById(placeholder.id))!;
    expect(upgraded.isRegistered).toBe(true);
    expect(upgraded.firstname).toBe("Invited");
    expect(await login("invited@example.org", "password123")).toBeTruthy();
  });

  test("registration is case-insensitive when matching a placeholder", async () => {
    const placeholder = await accounts.createPlaceholder("Invited@Example.org");

    const res = await post(`${API}/users/`, {
      json: {
        email: "invited@example.org",
        firstname: "Invited",
        lastname: "Person",
        password: "password123",
        acceptedTerms: true,
      },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("ResourceId")).toBe(String(placeholder.id));
  });

  test("a registered account is never overwritten by re-registration", async () => {
    await post(`${API}/users/`, {
      json: {
        email: "taken@example.org",
        firstname: "First",
        lastname: "Owner",
        password: "password123",
        acceptedTerms: true,
      },
    });

    const res = await post(`${API}/users/`, {
      json: {
        email: "taken@example.org",
        firstname: "Second",
        lastname: "Impostor",
        password: "different456",
        acceptedTerms: true,
      },
    });

    expect(res.status).toBe(400);
    expect((await json(res)).fieldErrors.email).toContain("already in use");
    // The original credentials still work; nothing was clobbered.
    expect(await login("taken@example.org", "password123")).toBeTruthy();
  });

  test("createOrUpgrade rejects re-registering an already-registered account", async () => {
    // Exercises the ON CONFLICT(email_lower) DO UPDATE ... WHERE password_hash
    // IS NULL guard directly: the guard must leave the real account untouched
    // and reject, not silently overwrite it. authService.register() already
    // rejects this earlier via a pre-check, so this path is otherwise
    // untested -- verified empirically against a real constraint violation in
    // a throwaway script before this rewrite landed (see tasks/plan.md).
    const newAccount = {
      email: "taken@example.org",
      firstname: "First",
      lastname: "Owner",
      passwordHash: "irrelevant-hash-1",
      locale: null,
      activationCode: null,
      activatedAt: Date.now(),
    };
    await accounts.createOrUpgrade(newAccount);

    await expect(
      accounts.createOrUpgrade({
        ...newAccount,
        firstname: "Second",
        lastname: "Impostor",
        passwordHash: "irrelevant-hash-2",
      }),
    ).rejects.toThrow(/already registered/);

    const stillOriginal = await accounts.findByEmail("taken@example.org");
    expect(stillOriginal?.firstname).toBe("First");
  });
});

describe("profile column allowlist", () => {
  test("refuses to write a column outside the allowlist", async () => {
    const user = await accounts.createPlaceholder("x@example.org");
    // The allowlist is what makes the interpolated column name in
    // updateProfileField safe; verify it actually rejects.
    await expect(
      accounts.updateProfileField(
        user.id,
        "password_hash" as unknown as accounts.ProfileColumn,
        "injected",
      ),
    ).rejects.toThrow(/non-profile column/);
  });
});

describe("upsertGoogleAccount", () => {
  test("creates a new account with OAUTH:GOOGLE and active status", async () => {
    const account = await accounts.upsertGoogleAccount({
      email: "newgoogle@example.com",
      firstname: "Google",
      lastname: "User",
    });

    expect(account.id).toBeGreaterThan(0);
    expect(account.email).toBe("newgoogle@example.com");
    expect(account.firstname).toBe("Google");
    expect(account.lastname).toBe("User");
    expect(account.isRegistered).toBe(true);
    expect(account.activatedAt).toBeInstanceOf(Date);
    expect(account.locale).toBe("en");

    const hash = await accounts.passwordHashOf(account.id);
    expect(hash).toBe("OAUTH:GOOGLE");
  });

  test("derives firstname fallback from email prefix or User when empty", async () => {
    const account1 = await accounts.upsertGoogleAccount({
      email: "fallbackuser@example.com",
      firstname: "   ",
      lastname: "   ",
    });
    expect(account1.firstname).toBe("fallbackuser");
    expect(account1.lastname).toBe("");

    const account2 = await accounts.upsertGoogleAccount({
      email: " @example.com",
      firstname: "",
      lastname: "",
    });
    expect(account2.firstname).toBe("User");
  });

  test("upgrades an invitee placeholder preserving account ID and collaborations", async () => {
    const placeholder = await accounts.createPlaceholder("invited@example.org");
    expect(placeholder.isRegistered).toBe(false);
    expect(await accounts.passwordHashOf(placeholder.id)).toBeNull();

    // Create an owner account and mindmap to link a collaboration to the placeholder
    const owner = await accounts.createOrUpgrade({
      email: "owner@example.org",
      firstname: "Map",
      lastname: "Owner",
      passwordHash: "HASH",
      locale: "en",
      activationCode: null,
      activatedAt: Date.now(),
    });

    const now = Date.now();
    const mapRow = db
      .query<{ id: number }, [string, number, number, number, number, string]>(
        `INSERT INTO mindmap (title, creator_id, last_editor_id, created_at, edited_at, source_type)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
      )
      .get("Shared Map", owner.id, owner.id, now, now, "local")!;

    db.run(
      `INSERT INTO collaboration (mindmap_id, account_id, role, created_at)
       VALUES (?1, ?2, 'editor', ?3)`,
      [mapRow.id, placeholder.id, now],
    );

    const upgraded = await accounts.upsertGoogleAccount({
      email: " INVITED@example.org ",
      firstname: "Google",
      lastname: "Invitee",
    });

    // Account ID must be preserved
    expect(upgraded.id).toBe(placeholder.id);
    expect(upgraded.email).toBe("invited@example.org");
    expect(upgraded.firstname).toBe("Google");
    expect(upgraded.lastname).toBe("Invitee");
    expect(upgraded.isRegistered).toBe(true);
    expect(upgraded.activatedAt).toBeInstanceOf(Date);
    expect(await accounts.passwordHashOf(upgraded.id)).toBe("OAUTH:GOOGLE");

    // Only 2 accounts exist: owner and upgraded placeholder
    const countRow = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM account`)
      .get()!;
    expect(countRow.n).toBe(2);

    // Collaboration is intact and references the same upgraded account id
    const collab = db
      .query<{ account_id: number; role: string }, [number]>(
        `SELECT account_id, role FROM collaboration WHERE mindmap_id = ?1`,
      )
      .get(mapRow.id)!;
    expect(collab.account_id).toBe(placeholder.id);
    expect(collab.role).toBe("editor");
  });

  test("upgrades placeholder while preserving existing non-empty names", async () => {
    const now = Date.now();
    const row = db
      .query<{ id: number }, [string, string, string, string, number]>(
        `INSERT INTO account (email, email_lower, firstname, lastname, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
      )
      .get("namedplaceholder@example.org", "namedplaceholder@example.org", "ExistingFirst", "ExistingLast", now)!;

    const upgraded = await accounts.upsertGoogleAccount({
      email: "namedplaceholder@example.org",
      firstname: "GoogleFirst",
      lastname: "GoogleLast",
    });

    expect(upgraded.id).toBe(row.id);
    expect(upgraded.firstname).toBe("ExistingFirst");
    expect(upgraded.lastname).toBe("ExistingLast");
    expect(await accounts.passwordHashOf(upgraded.id)).toBe("OAUTH:GOOGLE");
  });

  test("auto-links existing inactive password account preserving password_hash and activating", async () => {
    const inactive = await accounts.createOrUpgrade({
      email: "passworduser@example.com",
      firstname: "Existing",
      lastname: "PasswordUser",
      passwordHash: "BCRYPT_SECRET_HASH",
      locale: "es",
      activationCode: "ACT123",
      activatedAt: null,
    });
    expect(inactive.activatedAt).toBeNull();

    const linked = await accounts.upsertGoogleAccount({
      email: "passworduser@example.com",
      firstname: "DifferentFirst",
      lastname: "DifferentLast",
    });

    expect(linked.id).toBe(inactive.id);
    // Name is preserved from original account
    expect(linked.firstname).toBe("Existing");
    expect(linked.lastname).toBe("PasswordUser");
    // Account is now activated
    expect(linked.activatedAt).toBeInstanceOf(Date);
    // Password hash is NOT overwritten
    expect(await accounts.passwordHashOf(linked.id)).toBe("BCRYPT_SECRET_HASH");
  });

  test("auto-links existing active password account preserving password_hash and activation timestamp", async () => {
    const originalActivatedAt = 1600000000000;
    const active = await accounts.createOrUpgrade({
      email: "activepass@example.com",
      firstname: "Active",
      lastname: "User",
      passwordHash: "BCRYPT_ACTIVE_HASH",
      locale: "fr",
      activationCode: null,
      activatedAt: originalActivatedAt,
    });

    const linked = await accounts.upsertGoogleAccount({
      email: " ACTIVEPASS@example.com ",
      firstname: "NewFirst",
      lastname: "NewLast",
    });

    expect(linked.id).toBe(active.id);
    expect(linked.firstname).toBe("Active");
    expect(linked.lastname).toBe("User");
    expect(linked.activatedAt?.getTime()).toBe(originalActivatedAt);
    expect(await accounts.passwordHashOf(linked.id)).toBe("BCRYPT_ACTIVE_HASH");
  });
});
