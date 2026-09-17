import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";

import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { createUser } from "./helpers/auth.ts";
import { API, post, put, get } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

async function enrollAndActivateUser() {
  const user = await createUser();
  const enrollRes = await post(`${API}/account/twoFactor/enrollment`, {
    headers: user.authHeaders,
    json: { password: user.password },
  });
  expect(enrollRes.status).toBe(201);
  const { setupKey } = (await enrollRes.json()) as { setupKey: string };

  const totp = new OTPAuth.TOTP({
    issuer: "WiseMapping",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(setupKey),
  });

  const activateRes = await put(`${API}/account/twoFactor/enrollment`, {
    headers: user.authHeaders,
    json: { code: totp.generate() },
  });
  expect(activateRes.status).toBe(200);
  const { recoveryCodes } = (await activateRes.json()) as { recoveryCodes: string[] };

  return { user, totp, recoveryCodes };
}

describe("Recovery Codes Regeneration (Story 3.3, FR22, FR24, FR26, FR36)", () => {
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
    const res = await post(`${API}/account/twoFactor/recoveryCodes`, {
      json: { password: "password123" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 404 when TWO_FACTOR_ENABLED is false", async () => {
    setConfig(buildConfig({ JWT_SECRET: VALID_JWT_SECRET, TWO_FACTOR_ENABLED: "false" }));
    const user = await createUser();
    const res = await post(`${API}/account/twoFactor/recoveryCodes`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });
    expect(res.status).toBe(404);
  });

  test("returns 409 Conflict when 2FA is not active", async () => {
    const user = await createUser();
    const res = await post(`${API}/account/twoFactor/recoveryCodes`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });
    expect(res.status).toBe(409);
  });

  test("returns 400 when fresh verification is missing or invalid (FR26)", async () => {
    const { user } = await enrollAndActivateUser();

    // Empty body
    const resEmpty = await post(`${API}/account/twoFactor/recoveryCodes`, {
      headers: user.authHeaders,
      json: {},
    });
    expect(resEmpty.status).toBe(400);

    // Invalid code
    const resWrongCode = await post(`${API}/account/twoFactor/recoveryCodes`, {
      headers: user.authHeaders,
      json: { code: "999999" },
    });
    expect(resWrongCode.status).toBe(400);
  });

  test("regenerates 10 codes, bumps generation, invalidates old codes, and logs event (FR22, FR24, FR36)", async () => {
    const { user, totp, recoveryCodes: oldCodes } = await enrollAndActivateUser();
    expect(oldCodes.length).toBe(10);
    const oldCodeToTest = oldCodes[0]!;

    // Verify initial generation is 1
    const initialRow = await dbAdapter.get<{ generation: number }>(
      "SELECT generation FROM account_recovery_code WHERE account_id = (SELECT id FROM account WHERE email = ?) LIMIT 1",
      [user.email],
    );
    expect(initialRow?.generation).toBe(1);

    // Regenerate using valid current TOTP code
    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    const regenRes = await post(`${API}/account/twoFactor/recoveryCodes`, {
      headers: user.authHeaders,
      json: { code: totp.generate() },
    });
    expect(regenRes.status).toBe(200);
    const { recoveryCodes: newCodes } = (await regenRes.json()) as { recoveryCodes: string[] };

    expect(newCodes.length).toBe(10);
    // All new codes are distinct from old codes
    expect(newCodes).not.toContain(oldCodeToTest);

    // Verify generation bumped to 2
    const bumpedRows = await dbAdapter.all<{ generation: number }>(
      "SELECT generation FROM account_recovery_code WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(bumpedRows.length).toBe(10);
    for (const r of bumpedRows) {
      expect(r.generation).toBe(2);
    }

    // Invalidation check (FR22): Old code is rejected at login challenge
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    expect(authRes.status).toBe(202);
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    const oldChallengeRes = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: oldCodeToTest, type: "recovery" },
    });
    expect(oldChallengeRes.status).toBe(400);

    // New code works at login challenge
    const newCodeToTest = newCodes[0]!;
    const newChallengeRes = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: newCodeToTest, type: "recovery" },
    });
    expect(newChallengeRes.status).toBe(200);

    // Security event recorded
    const event = await dbAdapter.get<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM security_event WHERE affected_account_id = (SELECT id FROM account WHERE email = ?) AND action = 'recovery_codes_regenerated'",
      [user.email],
    );
    expect(event?.action).toBe("recovery_codes_regenerated");
    expect(event?.outcome).toBe("success");

    // Status shows 9 unused remaining (since 1 new code was consumed)
    const statusRes = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    const statusBody = (await statusRes.json()) as { recoveryCodesRemaining: number };
    expect(statusBody.recoveryCodesRemaining).toBe(9);
  });
});
