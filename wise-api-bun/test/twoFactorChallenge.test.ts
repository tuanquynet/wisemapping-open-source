import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";
import { sign } from "hono/jwt";

import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { createUser } from "./helpers/auth.ts";
import { API, post, put, get } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

/** Helper to activate 2FA for a user in tests. */
async function enrollAndActivateUser() {
  const user = await createUser();
  const enrollRes = await post(`${API}/account/twoFactor/enrollment`, {
    headers: user.authHeaders,
    json: { password: user.password },
  });
  const { setupKey } = (await enrollRes.json()) as { setupKey: string };

  const totp = new OTPAuth.TOTP({
    issuer: "WiseMapping",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(setupKey),
  });
  const code = totp.generate();

  const activateRes = await put(`${API}/account/twoFactor/enrollment`, {
    headers: user.authHeaders,
    json: { code },
  });
  expect(activateRes.status).toBe(200);
  const { recoveryCodes } = (await activateRes.json()) as { recoveryCodes: string[] };

  return { user, setupKey, totp, recoveryCodes };
}

describe("POST /api/restful/authenticate 2FA Challenge branch (D11)", () => {
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

  test("non-enrolled user receives legacy 200 bare token and Authorization header (FR39)", async () => {
    const user = await createUser();
    const res = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    expect(res.status).toBe(200);
    const token = await res.text();
    expect(token.startsWith("ey")).toBe(true);
    expect(res.headers.get("Authorization")).toBe(`Bearer ${token}`);
  });

  test("enrolled user receives 202 Accepted challenge envelope (D11, AR13)", async () => {
    const { user } = await enrollAndActivateUser();

    const res = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    expect(res.status).toBe(202);

    const body = (await res.json()) as {
      action: string;
      challengeToken: string;
      expiresInSec: number;
      recoveryAvailable: boolean;
    };
    expect(body.action).toBe("TWO_FACTOR_REQUIRED");
    expect(typeof body.challengeToken).toBe("string");
    expect(body.expiresInSec).toBe(300);
    expect(body.recoveryAvailable).toBe(true);

    // Challenge token MUST NOT be usable as a session token (FR9)
    const protectedRes = await get(`${API}/account`, {
      headers: { Authorization: `Bearer ${body.challengeToken}` },
    });
    expect(protectedRes.status).toBe(401);
  });

  test("enrolled user bypasses 2FA challenge when TWO_FACTOR_ENABLED is false", async () => {
    const { user } = await enrollAndActivateUser();
    setConfig(buildConfig({ JWT_SECRET: VALID_JWT_SECRET, TWO_FACTOR_ENABLED: "false" }));

    const res = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    expect(res.status).toBe(200);
    const token = await res.text();
    expect(token.startsWith("ey")).toBe(true);
  });
});

describe("POST /api/restful/twoFactor/challenge (FR10, D11)", () => {
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

  test("returns 404 when TWO_FACTOR_ENABLED is false", async () => {
    setConfig(buildConfig({ JWT_SECRET: VALID_JWT_SECRET, TWO_FACTOR_ENABLED: "false" }));
    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken: "dummy", code: "123456" },
    });
    expect(res.status).toBe(404);
  });

  test("returns 401 when challengeToken is missing or invalid", async () => {
    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken: "invalid.jwt.token", code: "123456" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 when challengeToken lacks 2fa_challenge pur claim (session token presented)", async () => {
    const user = await createUser();
    const sessionToken = user.authHeaders.Authorization!.replace("Bearer ", "");

    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken: sessionToken, code: "123456" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects with 400 when code is invalid or wrong", async () => {
    const { user } = await enrollAndActivateUser();
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: "000000" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors?.code).toContain("30 seconds");
  });

  test("completes challenge with valid code, issues session token, and records security event", async () => {
    const { user, totp } = await enrollAndActivateUser();
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };
    // Simulate that activation happened in a prior time step so current step is not a replay
    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );


    const validCode = totp.generate();
    const challengeRes = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: validCode },
    });
    expect(challengeRes.status).toBe(200);

    const sessionToken = await challengeRes.text();
    expect(sessionToken.startsWith("ey")).toBe(true);
    expect(challengeRes.headers.get("Authorization")).toBe(`Bearer ${sessionToken}`);

    // Verified session token can access protected endpoints
    const accountRes = await get(`${API}/account`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(accountRes.status).toBe(200);

    // Security event recorded
    const event = await dbAdapter.get<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM security_event WHERE affected_account_id = (SELECT id FROM account WHERE email = ?) AND action = 'challenge_succeeded'",
      [user.email],
    );
    expect(event?.action).toBe("challenge_succeeded");
    expect(event?.outcome).toBe("success");
  });

  test("strips whitespace from code and accepts it", async () => {
    const { user, totp } = await enrollAndActivateUser();
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    const code = totp.generate();
    const formatted = `${code.slice(0, 3)}  ${code.slice(3)}`;

    // Simulate that activation happened in a prior time step
    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );

    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: formatted },
    });
    expect(res.status).toBe(200);
  });

  test("rememberDevice: true creates a trusted_device row with 30-day expiry and emits X-Device-Token header (FR15, AR17, D12)", async () => {
    const { user, totp } = await enrollAndActivateUser();
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );

    const validCode = totp.generate();
    const res = await post(`${API}/twoFactor/challenge`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/120.0" },
      json: { challengeToken, code: validCode, rememberDevice: true },
    });
    expect(res.status).toBe(200);

    const deviceToken = res.headers.get("X-Device-Token");
    expect(deviceToken).toBeTruthy();
    expect(deviceToken!.length).toBeGreaterThanOrEqual(32);

    const deviceRow = await dbAdapter.get<{
      token_hash: string;
      label: string;
      expires_at: number;
    }>(
      "SELECT token_hash, label, expires_at FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(deviceRow).toBeTruthy();
    expect(deviceRow?.label).toContain("Chrome on macOS");
    const thirtyDaysFuture = Date.now() + 29 * 24 * 60 * 60 * 1000;
    expect(deviceRow?.expires_at).toBeGreaterThan(thirtyDaysFuture);
  }, 15000);

  test("rememberDevice: false emits no X-Device-Token header and creates no trusted_device row", async () => {
    const { user, totp } = await enrollAndActivateUser();
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );

    const validCode = totp.generate();
    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: validCode, rememberDevice: false },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Device-Token")).toBeNull();

    const count = await dbAdapter.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(count?.count).toBe(0);
  }, 15000);
});

describe("POST /api/restful/twoFactor/challenge with recovery code (FR11, D4, AR31)", () => {
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

  test("consumes a valid recovery code, issues session token, decrements count, and logs event", async () => {
    const { user, recoveryCodes } = await enrollAndActivateUser();
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    const firstCode = recoveryCodes[0]!;
    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: firstCode, type: "recovery" },
    });
    expect(res.status).toBe(200);
    const sessionToken = await res.text();
    expect(sessionToken.startsWith("ey")).toBe(true);
    expect(res.headers.get("Authorization")).toBe(`Bearer ${sessionToken}`);

    // Verify remaining count decremented to 9
    const statusRes = await get(`${API}/account/twoFactor`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const status = (await statusRes.json()) as { recoveryCodesRemaining: number };
    expect(status.recoveryCodesRemaining).toBe(9);

    // Verify security_event recorded
    const event = await dbAdapter.get<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM security_event WHERE affected_account_id = (SELECT id FROM account WHERE email = ?) AND action = 'recovery_code_consumed'",
      [user.email],
    );
    expect(event?.action).toBe("recovery_code_consumed");
    expect(event?.outcome).toBe("success");
  });

  test("normalizes recovery code with lowercase and hyphens (e.g. '4n6k3-p9q2x')", async () => {
    const { user, recoveryCodes } = await enrollAndActivateUser();
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    const raw = recoveryCodes[1]!;
    const formatted = `${raw.slice(0, 5).toLowerCase()}-${raw.slice(5).toLowerCase()}`;

    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: formatted, type: "recovery" },
    });
    expect(res.status).toBe(200);
  });

  test("rejects already-consumed recovery code with 400 and reveals remaining count in copy", async () => {
    const { user, recoveryCodes } = await enrollAndActivateUser();
    const firstAuth = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken: token1 } = (await firstAuth.json()) as { challengeToken: string };

    const codeToUse = recoveryCodes[2]!;
    // First consumption succeeds
    const firstRes = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken: token1, code: codeToUse, type: "recovery" },
    });
    expect(firstRes.status).toBe(200);

    // Second sign-in attempt with the same recovery code
    const secondAuth = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken: token2 } = (await secondAuth.json()) as { challengeToken: string };

    const secondRes = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken: token2, code: codeToUse, type: "recovery" },
    });
    expect(secondRes.status).toBe(400);
    const body = (await secondRes.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors?.code).toContain("already used");
    expect(body.fieldErrors?.code).toContain("9 recovery codes remaining");
  }, 15000);

  test("rejects an invalid recovery code that does not match any hash", async () => {
    const { user } = await enrollAndActivateUser();
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: "ZZZZZ-ZZZZZ", type: "recovery" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors?.code).toContain("Invalid recovery code");
  });
  test("concurrent consumption race: two simultaneous submissions yield exactly one 200 and one 400 (D4, AR31)", async () => {
    const { user, recoveryCodes } = await enrollAndActivateUser();
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    const codeToRace = recoveryCodes[3]!;

    const [res1, res2] = await Promise.all([
      post(`${API}/twoFactor/challenge`, {
        json: { challengeToken, code: codeToRace, type: "recovery" },
      }),
      post(`${API}/twoFactor/challenge`, {
        json: { challengeToken, code: codeToRace, type: "recovery" },
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 400]);
  }, 15000);
});
