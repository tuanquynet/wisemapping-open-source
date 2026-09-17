import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";

import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { createUser } from "./helpers/auth.ts";
import { API, post, put, get } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

async function enrollActivateAndTrustDevice() {
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

  await put(`${API}/account/twoFactor/enrollment`, {
    headers: user.authHeaders,
    json: { code },
  });

  // Login with challenge and trust device
  const authRes = await post(`${API}/authenticate`, {
    json: { email: user.email, password: user.password },
  });
  const { challengeToken } = (await authRes.json()) as { challengeToken: string };

  await dbAdapter.run(
    "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
    [user.email],
  );

  const validCode = totp.generate();
  const challengeRes = await post(`${API}/twoFactor/challenge`, {
    json: { challengeToken, code: validCode, rememberDevice: true },
  });
  expect(challengeRes.status).toBe(200);
  const deviceToken = challengeRes.headers.get("X-Device-Token");
  expect(deviceToken).toBeTruthy();

  return { user, deviceToken: deviceToken! };
}

describe("POST /authenticate with trusted device (FR16, D11, D12)", () => {
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

  test("valid unexpired device token bypasses 2FA challenge and updates last_used_at (FR16)", async () => {
    const { user, deviceToken } = await enrollActivateAndTrustDevice();

    const beforeLogin = Date.now();
    const res = await post(`${API}/authenticate`, {
      headers: { "X-Device-Token": deviceToken },
      json: { email: user.email, password: user.password },
    });
    expect(res.status).toBe(200);
    const sessionToken = await res.text();
    expect(sessionToken.startsWith("ey")).toBe(true);
    expect(res.headers.get("Authorization")).toBe(`Bearer ${sessionToken}`);

    // Verify last_used_at updated
    const deviceRow = await dbAdapter.get<{ last_used_at: number }>(
      "SELECT last_used_at FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(deviceRow?.last_used_at).toBeGreaterThanOrEqual(beforeLogin);
  }, 15000);

  test("expired device token (expires_at < now) issues 202 challenge (FR16)", async () => {
    const { user, deviceToken } = await enrollActivateAndTrustDevice();

    // Expire the device in DB
    await dbAdapter.run(
      "UPDATE trusted_device SET expires_at = ? WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [Date.now() - 1000, user.email],
    );

    const res = await post(`${API}/authenticate`, {
      headers: { "X-Device-Token": deviceToken },
      json: { email: user.email, password: user.password },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { action: string; challengeToken: string };
    expect(body.action).toBe("TWO_FACTOR_REQUIRED");
  }, 15000);

  test("revoked device token (revoked_at IS NOT NULL) issues 202 challenge (FR16)", async () => {
    const { user, deviceToken } = await enrollActivateAndTrustDevice();

    // Soft-revoke the device in DB
    await dbAdapter.run(
      "UPDATE trusted_device SET revoked_at = ? WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [Date.now(), user.email],
    );

    const res = await post(`${API}/authenticate`, {
      headers: { "X-Device-Token": deviceToken },
      json: { email: user.email, password: user.password },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { action: string; challengeToken: string };
    expect(body.action).toBe("TWO_FACTOR_REQUIRED");
  }, 15000);

  test("device token belonging to a different account issues 202 challenge (FR16)", async () => {
    const { deviceToken } = await enrollActivateAndTrustDevice();

    // Another user with 2FA activated
    const user2 = await createUser();
    const enroll2 = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user2.authHeaders,
      json: { password: user2.password },
    });
    const { setupKey } = (await enroll2.json()) as { setupKey: string };
    const totp2 = new OTPAuth.TOTP({
      issuer: "WiseMapping",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(setupKey),
    });
    await put(`${API}/account/twoFactor/enrollment`, {
      headers: user2.authHeaders,
      json: { code: totp2.generate() },
    });

    // User2 tries to sign in using User1's deviceToken
    const res = await post(`${API}/authenticate`, {
      headers: { "X-Device-Token": deviceToken },
      json: { email: user2.email, password: user2.password },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { action: string; challengeToken: string };
    expect(body.action).toBe("TWO_FACTOR_REQUIRED");
  }, 15000);
});
