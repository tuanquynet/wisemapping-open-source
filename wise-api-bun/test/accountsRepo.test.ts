import { beforeEach, describe, expect, test } from "bun:test";

import * as accounts from "../src/db/repos/accounts.ts";
import { db } from "../src/db/client.ts";
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
    accounts.createPlaceholder("invited@example.org");

    const res = await post(`${API}/authenticate`, {
      json: { email: "invited@example.org", password: "password123" },
    });
    expect(res.status).toBe(401);
  });

  test("registration upgrades the placeholder in place, keeping its id", async () => {
    const placeholder = accounts.createPlaceholder("invited@example.org");
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

    const upgraded = accounts.findById(placeholder.id)!;
    expect(upgraded.isRegistered).toBe(true);
    expect(upgraded.firstname).toBe("Invited");
    expect(await login("invited@example.org", "password123")).toBeTruthy();
  });

  test("registration is case-insensitive when matching a placeholder", async () => {
    const placeholder = accounts.createPlaceholder("Invited@Example.org");

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
});

describe("profile column allowlist", () => {
  test("refuses to write a column outside the allowlist", () => {
    const user = accounts.createPlaceholder("x@example.org");
    // The allowlist is what makes the interpolated column name in
    // updateProfileField safe; verify it actually rejects.
    expect(() =>
      accounts.updateProfileField(
        user.id,
        "password_hash" as unknown as accounts.ProfileColumn,
        "injected",
      ),
    ).toThrow(/non-profile column/);
  });
});
