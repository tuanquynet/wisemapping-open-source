import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { app } from "../src/app.ts";
import { buildConfig, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { createUser } from "./helpers/auth.ts";
import { API, get } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

describe("GET /api/restful/account/twoFactor", () => {
  const initialConfig = getConfig();

  beforeEach(() => {
    resetDb();
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY,
      }),
    );
  });

  afterAll(() => {
    setConfig(initialConfig);
  });

  test("returns 401 when unauthenticated", async () => {
    const res = await get(`${API}/account/twoFactor`);
    expect(res.status).toBe(401);
  });

  test("returns 404 when TWO_FACTOR_ENABLED is false", async () => {
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "false",
      }),
    );
    const user = await createUser();
    const res = await get(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test("returns default status when user has no 2FA records", async () => {
    const user = await createUser();
    const res = await get(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      enabled: false,
      pendingEnrollment: false,
      recoveryCodesRemaining: 0,
      reenrollRequired: false,
      activatedAt: null,
    });
  });

  test("returns pendingEnrollment: true when account has pending totp row", async () => {
    const user = await createUser();
    const account = await dbAdapter.get<{ id: number }>(
      "SELECT id FROM account WHERE email = ?",
      [user.email],
    );
    const accountId = account!.id;

    await dbAdapter.run(
      `INSERT INTO account_totp (account_id, secret_cipher, status, created_at, activated_at)
       VALUES (?, 'v1$dummy$cipher', 'pending', ?, NULL)`,
      [accountId, Date.now()],
    );

    const res = await get(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      enabled: false,
      pendingEnrollment: true,
      recoveryCodesRemaining: 0,
      reenrollRequired: false,
      activatedAt: null,
    });
  });

  test("returns enabled: true, activatedAt and recoveryCodesRemaining when 2FA is active", async () => {
    const user = await createUser();
    const account = await dbAdapter.get<{ id: number }>(
      "SELECT id FROM account WHERE email = ?",
      [user.email],
    );
    const accountId = account!.id;
    const activatedAt = 1710000000000;

    await dbAdapter.run(
      `INSERT INTO account_totp (account_id, secret_cipher, status, created_at, activated_at)
       VALUES (?, 'v1$dummy$cipher', 'active', ?, ?)`,
      [accountId, activatedAt - 60000, activatedAt],
    );

    // 8 unused codes
    for (let i = 0; i < 8; i++) {
      await dbAdapter.run(
        `INSERT INTO account_recovery_code (account_id, code_hash, generation, created_at)
         VALUES (?, ?, 1, ?)`,
        [accountId, `hash-unused-${i}`, Date.now()],
      );
    }
    // 2 used codes
    for (let i = 0; i < 2; i++) {
      await dbAdapter.run(
        `INSERT INTO account_recovery_code (account_id, code_hash, generation, used_at, created_at)
         VALUES (?, ?, 1, ?, ?)`,
        [accountId, `hash-used-${i}`, Date.now(), Date.now()],
      );
    }

    const res = await get(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      enabled: true,
      pendingEnrollment: false,
      recoveryCodesRemaining: 8,
      reenrollRequired: false,
      activatedAt,
    });
  });

  test("returns reenrollRequired: true when account requires reenrollment", async () => {
    const user = await createUser();
    const account = await dbAdapter.get<{ id: number }>(
      "SELECT id FROM account WHERE email = ?",
      [user.email],
    );
    const accountId = account!.id;

    await dbAdapter.run(
      "UPDATE account SET two_factor_reenroll_required = 1 WHERE id = ?",
      [accountId],
    );

    const res = await get(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reenrollRequired).toBe(true);
  });
});
