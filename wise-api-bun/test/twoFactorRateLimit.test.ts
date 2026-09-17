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

describe("Two-factor verification rate limiting (D8, FR13)", () => {
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

  test("5 consecutive failed attempts trigger HTTP 429 cooldown with Retry-After header and audit log", async () => {
    const { user } = await enrollAndActivateUser();
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    // Attempts 1 to 4 return 400
    for (let i = 1; i <= 4; i++) {
      const res = await post(`${API}/twoFactor/challenge`, {
        json: { challengeToken, code: "000000" },
      });
      expect(res.status).toBe(400);
      const row = await dbAdapter.get<{ failed_attempts: number; cooldown_until: number | null }>(
        "SELECT failed_attempts, cooldown_until FROM account_totp WHERE account_id = (SELECT id FROM account WHERE email = ?)",
        [user.email],
      );
      expect(row?.failed_attempts).toBe(i);
      expect(row?.cooldown_until).toBeNull();
    }

    // 5th attempt triggers 429 cooldown
    const res5 = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: "000000" },
    });
    expect(res5.status).toBe(429);

    const retryAfter = res5.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    const retryAfterSec = parseInt(retryAfter!, 10);
    expect(retryAfterSec).toBeGreaterThan(800); // 15 minutes = 900s
    expect(retryAfterSec).toBeLessThanOrEqual(900);

    const body = (await res5.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors?.code).toContain("Too many failed attempts");
    expect(body.fieldErrors?.code).toContain("recovery code");

    // Database check: cooldown_until is set
    const row5 = await dbAdapter.get<{ failed_attempts: number; cooldown_until: number | null }>(
      "SELECT failed_attempts, cooldown_until FROM account_totp WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(row5?.failed_attempts).toBe(5);
    expect(row5?.cooldown_until).toBeGreaterThan(Date.now());

    // Security event recorded
    const event = await dbAdapter.get<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM security_event WHERE affected_account_id = (SELECT id FROM account WHERE email = ?) AND action = 'cooldown_triggered'",
      [user.email],
    );
    expect(event?.action).toBe("cooldown_triggered");
    expect(event?.outcome).toBe("failure");
  }, 15000);

  test("requests during active cooldown are immediately refused with 429", async () => {
    const { user, totp } = await enrollAndActivateUser();
    // Force active cooldown on account
    const cooldownEnd = Date.now() + 600000; // 10 minutes from now
    await dbAdapter.run(
      "UPDATE account_totp SET failed_attempts = 5, cooldown_until = ? WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [cooldownEnd, user.email],
    );

    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    const validCode = totp.generate();
    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: validCode },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  }, 15000);

  test("successful recovery code verification clears cooldown and failure counter", async () => {
    const { user, recoveryCodes } = await enrollAndActivateUser();
    // Force active cooldown on account
    const cooldownEnd = Date.now() + 600000;
    await dbAdapter.run(
      "UPDATE account_totp SET failed_attempts = 5, cooldown_until = ? WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [cooldownEnd, user.email],
    );

    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    const res = await post(`${API}/twoFactor/challenge`, {
      json: { challengeToken, code: recoveryCodes[0]!, type: "recovery" },
    });
    expect(res.status).toBe(200);

    // Verify cooldown is cleared and failed_attempts is 0 in DB
    const row = await dbAdapter.get<{ failed_attempts: number; cooldown_until: number | null }>(
      "SELECT failed_attempts, cooldown_until FROM account_totp WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(row?.failed_attempts).toBe(0);
    expect(row?.cooldown_until).toBeNull();
  }, 15000);
});
