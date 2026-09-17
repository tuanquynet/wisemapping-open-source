import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { createUser } from "./helpers/auth.ts";
import { API, post } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

describe("Dedicated 2FA Reset Permission (Story 4.1, FR29, FR35, D13, AR15)", () => {
  const initialConfig = getConfig();

  beforeEach(() => {
    resetDb();
  });

  afterAll(() => setConfig(initialConfig));

  test("returns 401 when unauthenticated", async () => {
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY,
        TWO_FACTOR_RESET_EMAILS: "operator@example.com",
      }),
    );

    const res = await post(`${API}/admin/users/123/twoFactor/reset`, {
      json: {},
    });
    expect(res.status).toBe(401);
  });

  test("returns 404 when TWO_FACTOR_ENABLED is false", async () => {
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "false",
        TWO_FACTOR_RESET_EMAILS: "operator@example.com",
      }),
    );
    const user = await createUser({ email: "operator@example.com" });

    const res = await post(`${API}/admin/users/123/twoFactor/reset`, {
      headers: user.authHeaders,
      json: {},
    });
    expect(res.status).toBe(404);
  });

  test("caller named in TWO_FACTOR_RESET_EMAILS is authorized (FR29)", async () => {
    const operatorEmail = "operator.reset@example.com";
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY,
        ADMIN_EMAIL: "general.admin@example.com",
        TWO_FACTOR_RESET_EMAILS: `other@example.com, ${operatorEmail}`,
      }),
    );

    // Operator is NOT the general admin (general.admin@example.com)
    const operator = await createUser({ email: operatorEmail });

    const res = await post(`${API}/admin/users/123/twoFactor/reset`, {
      headers: operator.authHeaders,
      json: {},
    });
    // Passes permission check (not 403) and reaches handler validation
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  test("ordinary admin not in TWO_FACTOR_RESET_EMAILS is refused with 403 (FR35, D13, AR15)", async () => {
    const generalAdminEmail = "general.admin@example.com";
    const resetOperatorEmail = "dedicated.operator@example.com";

    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY,
        ADMIN_EMAIL: generalAdminEmail,
        // Allowlist explicitly does NOT include general.admin@example.com
        TWO_FACTOR_RESET_EMAILS: resetOperatorEmail,
      }),
    );

    const generalAdmin = await createUser({ email: generalAdminEmail });

    const res = await post(`${API}/admin/users/123/twoFactor/reset`, {
      headers: generalAdmin.authHeaders,
      json: {},
    });
    // Ordinary admin rights MUST NOT confer 2FA reset authority
    expect(res.status).toBe(403);
  });

  test("regular non-admin user is refused with 403 (FR35)", async () => {
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY,
        ADMIN_EMAIL: "admin@example.com",
        TWO_FACTOR_RESET_EMAILS: "operator@example.com",
      }),
    );

    const regularUser = await createUser({ email: "regular.user@example.com" });

    const res = await post(`${API}/admin/users/123/twoFactor/reset`, {
      headers: regularUser.authHeaders,
      json: {},
    });
    expect(res.status).toBe(403);
  });

  test("empty allowlist fails closed and rejects all callers (FR35)", async () => {
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY,
        ADMIN_EMAIL: "",
        TWO_FACTOR_RESET_EMAILS: "",
      }),
    );

    const caller = await createUser({ email: "anyone@example.com" });

    const res = await post(`${API}/admin/users/123/twoFactor/reset`, {
      headers: caller.authHeaders,
      json: {},
    });
    expect(res.status).toBe(403);
  });

  test("denied attempt logs security_event with actor details and reason (FR36)", async () => {
    const deniedEmail = "denied.caller@example.com";
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY,
        TWO_FACTOR_RESET_EMAILS: "only.operator@example.com",
      }),
    );

    const caller = await createUser({ email: deniedEmail });

    const res = await post(`${API}/admin/users/999/twoFactor/reset`, {
      headers: caller.authHeaders,
      json: {},
    });
    expect(res.status).toBe(403);

    const event = await dbAdapter.get<{
      action: string;
      outcome: string;
      reason: string;
      actor_email: string;
    }>(
      "SELECT action, outcome, reason, actor_email FROM security_event WHERE actor_email = ? ORDER BY id DESC LIMIT 1",
      [deniedEmail],
    );

    expect(event).toBeTruthy();
    expect(event?.action).toBe("admin_reset_denied");
    expect(event?.outcome).toBe("failure");
    expect(event?.reason).toBe("forbidden_permission");
    expect(event?.actor_email).toBe(deniedEmail);
  });

  test("email matching is case-insensitive and trims whitespace (FR29)", async () => {
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY,
        TWO_FACTOR_RESET_EMAILS: "  CaseInsensitive.Operator@Example.com  ",
      }),
    );

    const operator = await createUser({ email: "caseinsensitive.operator@example.com" });

    const res = await post(`${API}/admin/users/123/twoFactor/reset`, {
      headers: operator.authHeaders,
      json: {},
    });
    // Passes permission check (not 403) and reaches handler validation
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });
});
