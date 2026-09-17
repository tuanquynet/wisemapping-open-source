import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";

import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import * as trustedDeviceRepo from "../src/db/repos/trustedDeviceRepo.ts";
import { hashDeviceToken } from "../src/util/deviceToken.ts";
import { createUser } from "./helpers/auth.ts";
import { API, post, put } from "./helpers/client.ts";
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

  await putEnrollment(user.authHeaders, totp.generate());

  const authRes = await post(`${API}/authenticate`, {
    json: { email: user.email, password: user.password },
  });
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

  return { user, deviceToken };
}

async function putEnrollment(headers: Record<string, string>, code: string) {
  const res = await put(`${API}/account/twoFactor/enrollment`, {
    headers,
    json: { code },
  });
  expect(res.status).toBe(200);
}

describe("Server-Side Device Expiry & Security Enforcement (Story 2.4, FR17, D5)", () => {
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

  test("exact millisecond boundary precision on server-side expiry (FR17)", async () => {
    const { user, deviceToken } = await enrollActivateAndTrustDevice();
    const tokenHash = await hashDeviceToken(deviceToken);

    const device = await dbAdapter.get<{ id: number; account_id: number; expires_at: number }>(
      "SELECT id, account_id, expires_at FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(device).toBeTruthy();
    const expiresAt = device!.expires_at;

    // 1ms before expiry -> live
    const liveBefore = await trustedDeviceRepo.findLiveDevice(
      device!.account_id,
      tokenHash,
      expiresAt - 1,
    );
    expect(liveBefore).not.toBeNull();
    expect(liveBefore?.id).toBe(device!.id);

    // Exact expiry timestamp -> expired (expires_at > now is false)
    const liveAt = await trustedDeviceRepo.findLiveDevice(
      device!.account_id,
      tokenHash,
      expiresAt,
    );
    expect(liveAt).toBeNull();

    // 1ms after expiry -> expired
    const liveAfter = await trustedDeviceRepo.findLiveDevice(
      device!.account_id,
      tokenHash,
      expiresAt + 1,
    );
    expect(liveAfter).toBeNull();
  });

  test("non-sliding expiry invariant: consecutive sign-ins update last_used_at but never extend expires_at (FR17, D5)", async () => {
    const { user, deviceToken } = await enrollActivateAndTrustDevice();

    const initial = await dbAdapter.get<{
      created_at: number;
      expires_at: number;
      last_used_at: number;
    }>(
      "SELECT created_at, expires_at, last_used_at FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(initial).toBeTruthy();
    const initialExpiresAt = initial!.expires_at;
    const initialCreatedAt = initial!.created_at;
    expect(initialExpiresAt).toBe(initialCreatedAt + trustedDeviceRepo.THIRTY_DAYS_MS);

    // First subsequent sign-in
    const res1 = await post(`${API}/authenticate`, {
      headers: { "X-Device-Token": deviceToken },
      json: { email: user.email, password: user.password },
    });
    expect(res1.status).toBe(200);

    const afterFirst = await dbAdapter.get<{
      expires_at: number;
      last_used_at: number;
    }>(
      "SELECT expires_at, last_used_at FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(afterFirst?.expires_at).toBe(initialExpiresAt);

    // Second subsequent sign-in
    const res2 = await post(`${API}/authenticate`, {
      headers: { "X-Device-Token": deviceToken },
      json: { email: user.email, password: user.password },
    });
    expect(res2.status).toBe(200);

    const afterSecond = await dbAdapter.get<{
      expires_at: number;
      last_used_at: number;
    }>(
      "SELECT expires_at, last_used_at FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    // STRUCTURAL INVARIANT: expires_at must remain byte-for-byte identical to original created_at + 30 days
    expect(afterSecond?.expires_at).toBe(initialExpiresAt);
    expect(afterSecond?.last_used_at).toBeGreaterThanOrEqual(afterFirst!.last_used_at);
  });

  test("forged, guessed, and malformed device tokens are rejected with 202 challenge", async () => {
    const { user } = await enrollActivateAndTrustDevice();

    const forgedTokens = [
      "dvt_completely_random_forged_token_string_here_12345",
      "invalid-token",
      "",
      " ",
      "a".repeat(256),
    ];

    for (const token of forgedTokens) {
      const res = await post(`${API}/authenticate`, {
        headers: { "X-Device-Token": token },
        json: { email: user.email, password: user.password },
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { action: string; challengeToken: string };
      expect(body.action).toBe("TWO_FACTOR_REQUIRED");
      expect(body.challengeToken).toBeTruthy();
    }
  });

  test("device token belonging to another account is rejected with 202 challenge", async () => {
    const { deviceToken } = await enrollActivateAndTrustDevice();

    const user2 = await createUser();
    const enrollRes2 = await post(`${API}/account/twoFactor/enrollment`, {
      headers: user2.authHeaders,
      json: { password: user2.password },
    });
    const { setupKey } = (await enrollRes2.json()) as { setupKey: string };

    const totp2 = new OTPAuth.TOTP({
      issuer: "WiseMapping",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(setupKey),
    });
    await putEnrollment(user2.authHeaders, totp2.generate());

    // User2 tries presenting User1's deviceToken
    const res = await post(`${API}/authenticate`, {
      headers: { "X-Device-Token": deviceToken },
      json: { email: user2.email, password: user2.password },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("TWO_FACTOR_REQUIRED");
  });

  test("purgeExpiredDevices removes devices past retention cutoff (FR17)", async () => {
    const { user } = await enrollActivateAndTrustDevice();

    const now = Date.now();
    const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;

    // Device 1: expired 70 days ago (past 60-day retention cutoff) -> should be purged
    await dbAdapter.run(
      "UPDATE trusted_device SET expires_at = ? WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [now - (sixtyDaysMs + 10 * 24 * 60 * 60 * 1000), user.email],
    );

    const purged = await trustedDeviceRepo.purgeExpiredDevices(sixtyDaysMs, now);
    expect(purged).toBe(1);

    const remaining = await dbAdapter.all(
      "SELECT id FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(remaining.length).toBe(0);
  });
});
