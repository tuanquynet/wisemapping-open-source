import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";

import { app } from "../src/app.ts";
import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { signToken, verifyToken } from "../src/util/jwt.ts";
import { createUser } from "./helpers/auth.ts";
import { API, post, get, del } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

async function createOAuthUser(): Promise<{ authHeaders: Record<string, string> }> {
  const email = `google-user-${Bun.nanoseconds()}@example.org`;
  await dbAdapter.run(
    `INSERT INTO account (email, email_lower, firstname, lastname, password_hash, activation_code, created_at, activated_at)
     VALUES (?, ?, 'Google', 'User', 'OAUTH:GOOGLE', '123456789012345678', ?, ?)`,
    [email, email, Date.now(), Date.now()],
  );
  const token = await signToken(email);
  return { authHeaders: { Authorization: `Bearer ${token}` } };
}

describe("POST /api/restful/account/twoFactor/enrollment", () => {
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

  afterAll(() => setConfig(initialConfig));

  test("returns 401 when unauthenticated", async () => {
    const res = await post(`${API}/account/twoFactor/enrollment`, {
      json: { password: "password123" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 404 when TWO_FACTOR_ENABLED is false", async () => {
    setConfig(buildConfig({ JWT_SECRET: VALID_JWT_SECRET, TWO_FACTOR_ENABLED: "false" }));
    const user = await createUser();
    const res = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });
    expect(res.status).toBe(404);
  });

  test("rejects with 400 when password is missing or wrong", async () => {
    const user = await createUser();

    const missing = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: {},
    });
    expect(missing.status).toBe(400);

    const wrong = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { password: "not-the-password" },
    });
    expect(wrong.status).toBe(400);

    const whitespace = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { password: "   " },
    });
    expect(whitespace.status).toBe(400);
  });

  test("creates a pending encrypted enrollment and returns otpauthUri + setupKey on 201", async () => {
    const user = await createUser();

    const res = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { otpauthUri: string; setupKey: string };
    expect(body.setupKey).toBeTruthy();
    expect(body.otpauthUri.startsWith("otpauth://totp/WiseMapping:")).toBe(true);
    expect(body.otpauthUri).toContain(`secret=${body.setupKey}`);

    const row = await dbAdapter.get<{ status: string; secret_cipher: string }>(
      "SELECT status, secret_cipher FROM account_totp WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(row?.status).toBe("pending");
    // Secret is encrypted at rest, never plaintext.
    expect(row?.secret_cipher.startsWith("v1$")).toBe(true);
    expect(row?.secret_cipher).not.toContain(body.setupKey);
  });

  test("re-enrollment replaces a previous pending secret", async () => {
    const user = await createUser();

    const first = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { setupKey: string };

    const second = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { setupKey: string };

    expect(secondBody.setupKey).not.toBe(firstBody.setupKey);

    const rows = await dbAdapter.all<{ status: string }>(
      "SELECT status FROM account_totp WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("pending");
  });
});

describe("DELETE /api/restful/account/twoFactor/enrollment", () => {
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

  afterAll(() => setConfig(initialConfig));

  test("returns 401 when unauthenticated", async () => {
    const res = await del(`${API}/account/twoFactor/enrollment`);
    expect(res.status).toBe(401);
  });

  test("discards a pending enrollment with 204 and leaves status disabled", async () => {
    const user = await createUser();

    const enroll = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });
    expect(enroll.status).toBe(201);

    const abandon = await del(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
    });
    expect(abandon.status).toBe(204);

    const row = await dbAdapter.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM account_totp WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(row?.count).toBe(0);

    // Status endpoint confirms the account remains unprotected.
    const status = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { enabled: boolean; pendingEnrollment: boolean };
    expect(statusBody.enabled).toBe(false);
    expect(statusBody.pendingEnrollment).toBe(false);
  });

  test("abandon is a no-op when no pending enrollment exists (still 204)", async () => {
    const user = await createUser();
    const res = await del(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(204);
  });
});

describe("OAuth account enrollment freshness (D10)", () => {
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

  afterAll(() => setConfig(initialConfig));

  test("fresh OAuth session enrolls without a password", async () => {
    const { authHeaders } = await createOAuthUser();

    const res = await post(`${API}/account/twoFactor/enrollment`, {
      headers: authHeaders,
      json: {},
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { setupKey: string };
    expect(body.setupKey).toBeTruthy();
  });

  test("stale OAuth session (iat older than 5 minutes) is rejected with 400", async () => {
    const email = `stale-google-${Bun.nanoseconds()}@example.org`;
    await dbAdapter.run(
      `INSERT INTO account (email, email_lower, firstname, lastname, password_hash, activation_code, created_at, activated_at)
       VALUES (?, ?, 'Stale', 'Google', 'OAUTH:GOOGLE', '123456789012345678', ?, ?)`,
      [email, email, Date.now(), Date.now()],
    );
    // Sign a token with iat 10 minutes in the past (still unexpired: 1-minute exp window below).
    const nowSeconds = Math.floor(Date.now() / 1000);
    const secret = new TextDecoder().decode(config.jwtKey);
    const staleToken = await sign(
      { sub: email, iat: nowSeconds - 600, exp: nowSeconds + 60 },
      secret,
      "HS256",
    );

    const res = await post(`${API}/account/twoFactor/enrollment`, {
      headers: { Authorization: `Bearer ${staleToken}` },
      json: {},
    });
    expect(res.status).toBe(400);
  });

  test("OAuth session missing iat is rejected with 400", async () => {
    const email = `no-iat-google-${Bun.nanoseconds()}@example.org`;
    await dbAdapter.run(
      `INSERT INTO account (email, email_lower, firstname, lastname, password_hash, activation_code, created_at, activated_at)
       VALUES (?, ?, 'NoIat', 'Google', 'OAUTH:GOOGLE', '123456789012345678', ?, ?)`,
      [email, email, Date.now(), Date.now()],
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const secret = new TextDecoder().decode(config.jwtKey);
    const tokenWithoutIat = await sign(
      { sub: email, exp: nowSeconds + 60 },
      secret,
      "HS256",
    );

    const res = await post(`${API}/account/twoFactor/enrollment`, {
      headers: { Authorization: `Bearer ${tokenWithoutIat}` },
      json: {},
    });
    expect(res.status).toBe(400);
  });
});
