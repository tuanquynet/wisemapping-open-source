import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { buildConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import type { Env } from "../src/http/env.ts";
import { resetDb } from "./helpers/db.ts";
import { requireTwoFactorEnabled } from "../src/http/middleware/requireTwoFactorEnabled.ts";
import { app } from "../src/app.ts";
import { createUser } from "./helpers/auth.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

describe("requireTwoFactorEnabled middleware", () => {
  beforeEach(() => resetDb());

  test("returns 404 when twoFactorEnabled is false", async () => {
    const testApp = new Hono<Env>();
    testApp.use("*", async (c, next) => {
      c.set(
        "config",
        buildConfig({
          JWT_SECRET: VALID_JWT_SECRET,
          TWO_FACTOR_ENABLED: "false",
        }),
      );
      await next();
    });
    testApp.get("/test-2fa-endpoint", requireTwoFactorEnabled, (c) =>
      c.text("success"),
    );

    const res = await testApp.request("/test-2fa-endpoint");
    expect(res.status).toBe(404);
  });

  test("passes through to handler when twoFactorEnabled is true", async () => {
    const testApp = new Hono<Env>();
    testApp.use("*", async (c, next) => {
      c.set(
        "config",
        buildConfig({
          JWT_SECRET: VALID_JWT_SECRET,
          TWO_FACTOR_ENABLED: "true",
          TWO_FACTOR_SECRET_KEY: VALID_KEY,
        }),
      );
      await next();
    });
    testApp.get("/test-2fa-endpoint", requireTwoFactorEnabled, (c) =>
      c.text("success"),
    );

    const res = await testApp.request("/test-2fa-endpoint");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
  });

  test("returns 404 when c.get('config') is absent and Bun config defaults to disabled", async () => {
    const testApp = new Hono<Env>();
    testApp.get("/fallback-endpoint", requireTwoFactorEnabled, (c) =>
      c.text("success"),
    );

    const res = await testApp.request("/fallback-endpoint");
    expect(res.status).toBe(404);
  });

  test("AC #4: sign-in returns 200 bare token when TWO_FACTOR_ENABLED is false even if account has active enrollment", async () => {
    const user = await createUser();
    const account = await dbAdapter.get<{ id: number }>(
      "SELECT id FROM account WHERE email = ?",
      [user.email],
    );
    const accountId = account!.id;

    // Directly seed active enrollment rows (Story 1.1 schema)
    await dbAdapter.run(
      `INSERT INTO account_totp (account_id, secret_cipher, status, created_at, activated_at)
       VALUES (?, ?, 'active', ?, ?)`,
      [accountId, "v1$dummy$cipher", Date.now(), Date.now()],
    );
    await dbAdapter.run(
      `INSERT INTO account_recovery_code (account_id, code_hash, generation, created_at)
       VALUES (?, 'dummy-hash', 1, ?)`,
      [accountId, Date.now()],
    );

    // Call /api/restful/authenticate
    const res = await app.request("/api/restful/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });

    expect(res.status).toBe(200);
    const token = await res.text();
    expect(token).toBeTruthy();
    expect(res.headers.get("Authorization")).toBe(`Bearer ${token}`);

    // Verify enrollment rows remain completely intact
    const totpRow = await dbAdapter.get<{ status: string }>(
      "SELECT status FROM account_totp WHERE account_id = ?",
      [accountId],
    );
    expect(totpRow?.status).toBe("active");

    const codeRows = await dbAdapter.all<{ id: number }>(
      "SELECT id FROM account_recovery_code WHERE account_id = ?",
      [accountId],
    );
    expect(codeRows.length).toBe(1);
  });
});
