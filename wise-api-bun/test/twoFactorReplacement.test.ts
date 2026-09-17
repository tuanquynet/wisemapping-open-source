import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";

import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { createUser } from "./helpers/auth.ts";
import { API, del, get, post, put } from "./helpers/client.ts";
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
  const { setupKey: key1 } = (await enrollRes.json()) as { setupKey: string };

  const totp1 = new OTPAuth.TOTP({
    issuer: "WiseMapping",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(key1),
  });

  const activateRes = await put(`${API}/account/twoFactor/enrollment`, {
    headers: user.authHeaders,
    json: { code: totp1.generate() },
  });
  expect(activateRes.status).toBe(200);
  const { recoveryCodes } = (await activateRes.json()) as { recoveryCodes: string[] };

  return { user, totp1, key1, recoveryCodes };
}

describe("Authenticator Replacement (Story 3.2, FR23, FR24, FR26, FR36)", () => {
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

  test("requires fresh verification (code or password) when 2FA is active (FR26)", async () => {
    const { user, totp1 } = await enrollAndActivateUser();

    // Missing verification
    const resNoAuth = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: {},
    });
    expect(resNoAuth.status).toBe(400);

    // Invalid code
    const resWrongCode = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: "999999" },
    });
    expect(resWrongCode.status).toBe(400);

    // Valid current TOTP code passes fresh verification
    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    const resValidCode = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: totp1.generate() },
    });
    expect(resValidCode.status).toBe(201);
    const body = (await resValidCode.json()) as { setupKey: string; otpauthUri: string };
    expect(body.setupKey).toBeTruthy();
    expect(body.otpauthUri).toContain("WiseMapping");
  });

  test("fresh verification accepts a valid recovery code (FR26)", async () => {
    const { user, recoveryCodes } = await enrollAndActivateUser();
    const recoveryCode = recoveryCodes[0]!;

    const res = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: recoveryCode },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { setupKey: string };
    expect(body.setupKey).toBeTruthy();

    // Status confirms 9 recovery codes remain (one was consumed for fresh verification)
    const status = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    const statusBody = (await status.json()) as { recoveryCodesRemaining: number };
    expect(statusBody.recoveryCodesRemaining).toBe(9);
  });

  test("existing authenticator continues to satisfy login challenges while replacement is pending (FR23)", async () => {
    const { user, totp1 } = await enrollAndActivateUser();

    // Start replacement
    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    const replaceRes = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: totp1.generate() },
    });
    expect(replaceRes.status).toBe(201);

    // Verify status shows enabled AND pendingEnrollment
    const statusRes = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    const statusBody = (await statusRes.json()) as { enabled: boolean; pendingEnrollment: boolean };
    expect(statusBody.enabled).toBe(true);
    expect(statusBody.pendingEnrollment).toBe(true);

    // Sign in on another session: existing authenticator STILL works
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    expect(authRes.status).toBe(202);
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    const challengeRes = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: totp1.generate() },
    });
    expect(challengeRes.status).toBe(200);
  });

  test("abandoning replacement clears pending secret while leaving active 2FA intact (FR23)", async () => {
    const { user, totp1 } = await enrollAndActivateUser();

    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: totp1.generate() },
    });

    // Abandon
    const abandonRes = await del(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
    });
    expect(abandonRes.status).toBe(204);

    // Active factor is preserved!
    const statusRes = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    const statusBody = (await statusRes.json()) as { enabled: boolean; pendingEnrollment: boolean };
    expect(statusBody.enabled).toBe(true);
    expect(statusBody.pendingEnrollment).toBe(false);

    // Existing authenticator still satisfies challenge
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    expect(authRes.status).toBe(202);
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    const challengeRes = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: totp1.generate() },
    });
    expect(challengeRes.status).toBe(200);
  });

  test("submitting valid code for new secret activates it, invalidates old, preserves recovery codes, and logs event (FR23, FR24, FR36)", async () => {
    const { user, totp1 } = await enrollAndActivateUser();

    // Start replacement
    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    const replaceRes = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: totp1.generate() },
    });
    const { setupKey: key2 } = (await replaceRes.json()) as { setupKey: string };
    expect(key2).not.toBe(totp1.secret.base32);

    const totp2 = new OTPAuth.TOTP({
      issuer: "WiseMapping",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(key2),
    });

    // Code from old authenticator is rejected for activating replacement
    const oldCodeRes = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: totp1.generate() },
    });
    expect(oldCodeRes.status).toBe(400);

    // Code from new authenticator activates replacement
    const newCodeRes = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: totp2.generate() },
    });
    expect(newCodeRes.status).toBe(200);

    // Security event recorded
    const event = await dbAdapter.get<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM security_event WHERE affected_account_id = (SELECT id FROM account WHERE email = ?) AND action = 'authenticator_replaced'",
      [user.email],
    );
    expect(event?.action).toBe("authenticator_replaced");
    expect(event?.outcome).toBe("success");

    // Existing recovery codes preserved
    const statusRes = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    const statusBody = (await statusRes.json()) as { recoveryCodesRemaining: number };
    expect(statusBody.recoveryCodesRemaining).toBe(10);

    // Sign-in challenge now requires code from NEW authenticator
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    // Old authenticator is refused
    const challengeOldRes = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: totp1.generate() },
    });
    expect(challengeOldRes.status).toBe(400);

    // New authenticator is accepted
    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    const challengeNewRes = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: totp2.generate() },
    });
    expect(challengeNewRes.status).toBe(200);
  });
});
