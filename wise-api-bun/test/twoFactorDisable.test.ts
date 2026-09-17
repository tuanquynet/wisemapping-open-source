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

  // Sign in and trust a device
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
    json: { challengeToken, code: totp.generate(), rememberDevice: true },
  });
  expect(challengeRes.status).toBe(200);
  const deviceToken = challengeRes.headers.get("X-Device-Token")!;
  expect(deviceToken).toBeTruthy();

  return { user, totp, deviceToken };
}

describe("Turn off two-step verification (Story 3.4, FR25, FR26, FR27, FR28, FR36)", () => {
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
    const res = await del(`${API}/account/twoFactor`, {
      json: { password: "password123" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 404 when TWO_FACTOR_ENABLED is false", async () => {
    setConfig(buildConfig({ JWT_SECRET: VALID_JWT_SECRET, TWO_FACTOR_ENABLED: "false" }));
    const user = await createUser();
    const res = await del(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });
    expect(res.status).toBe(404);
  });

  test("returns 409 Conflict when 2FA is not active", async () => {
    const user = await createUser();
    const res = await del(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });
    expect(res.status).toBe(409);
  });

  test("returns 400 when fresh verification is missing or invalid (FR26)", async () => {
    const { user } = await enrollAndActivateUser();

    // Missing code/password
    const resEmpty = await del(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
      json: {},
    });
    expect(resEmpty.status).toBe(400);

    // Invalid code
    const resWrongCode = await del(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
      json: { code: "999999" },
    });
    expect(resWrongCode.status).toBe(400);
  });

  test("disables 2FA atomically, revokes trusted devices, logs event, and restores clean sign-in (FR25, FR27, FR36)", async () => {
    const { user, totp, deviceToken } = await enrollAndActivateUser();

    // Verify initial active state
    const preStatus = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    const preBody = (await preStatus.json()) as { enabled: boolean };
    expect(preBody.enabled).toBe(true);

    // Turn off using valid current code
    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    const disableRes = await del(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
      json: { code: totp.generate() },
    });
    expect(disableRes.status).toBe(204);

    // 1. account_totp row is deleted
    const totpRow = await dbAdapter.get(
      "SELECT * FROM account_totp WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(totpRow).toBeNull();

    // 2. account_recovery_code rows are deleted
    const recoveryRows = await dbAdapter.all(
      "SELECT * FROM account_recovery_code WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(recoveryRows.length).toBe(0);

    // 3. trusted_device rows are soft-revoked
    const activeDevices = await dbAdapter.all(
      "SELECT * FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?) AND revoked_at IS NULL",
      [user.email],
    );
    expect(activeDevices.length).toBe(0);

    const allDevices = await dbAdapter.all<{ revoked_at: number | null }>(
      "SELECT revoked_at FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(allDevices.length).toBeGreaterThan(0);
    for (const d of allDevices) {
      expect(d.revoked_at).not.toBeNull();
    }

    // 4. security_event recorded
    const event = await dbAdapter.get<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM security_event WHERE affected_account_id = (SELECT id FROM account WHERE email = ?) AND action = 'two_factor_disabled'",
      [user.email],
    );
    expect(event?.action).toBe("two_factor_disabled");
    expect(event?.outcome).toBe("success");

    // 5. GET /account/twoFactor returns neutral disabled status
    const statusRes = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    const statusBody = (await statusRes.json()) as { enabled: boolean; recoveryCodesRemaining: number };
    expect(statusBody.enabled).toBe(false);
    expect(statusBody.recoveryCodesRemaining).toBe(0);

    // 6. Clean sign-in (FR25): POST /authenticate returns 200 bare token immediately without challenge
    const authRes = await post(`${API}/authenticate`, {
      headers: { "X-Device-Token": deviceToken },
      json: { email: user.email, password: user.password },
    });
    expect(authRes.status).toBe(200);
    const sessionToken = await authRes.text();
    expect(sessionToken.startsWith("ey")).toBe(true);
    expect(authRes.headers.get("Authorization")).toBe(`Bearer ${sessionToken}`);
  });

  test("clean re-enrollment from scratch with new secret and codes (FR28)", async () => {
    const { user, totp } = await enrollAndActivateUser();

    // Disable
    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    await del(`${API}/account/twoFactor`, {
      headers: user.authHeaders,
      json: { code: totp.generate() },
    });

    // Re-enroll cleanly
    const reEnrollRes = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });
    expect(reEnrollRes.status).toBe(201);
    const { setupKey: newKey } = (await reEnrollRes.json()) as { setupKey: string };
    expect(newKey).not.toBe(totp.secret.base32);

    const newTotp = new OTPAuth.TOTP({
      issuer: "WiseMapping",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(newKey),
    });

    const reActivateRes = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: newTotp.generate() },
    });
    expect(reActivateRes.status).toBe(200);
    const { recoveryCodes: reCodes } = (await reActivateRes.json()) as { recoveryCodes: string[] };
    expect(reCodes.length).toBe(10);

    // Active status restored
    const statusRes = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    const statusBody = (await statusRes.json()) as { enabled: boolean; recoveryCodesRemaining: number };
    expect(statusBody.enabled).toBe(true);
    expect(statusBody.recoveryCodesRemaining).toBe(10);
  });
});
