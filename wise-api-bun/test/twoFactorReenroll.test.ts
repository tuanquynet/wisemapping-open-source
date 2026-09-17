import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";

import { buildConfig, getConfig, setConfig, type Config } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { get, post, put, API } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";
import { createUser } from "./helpers/auth.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

/**
 * Fully enroll a user in TOTP and return their session auth headers.
 * Config must already have twoFactorEnabled=true before calling.
 */
async function enrollUser(email: string, password: string) {
  const { authHeaders } = await createUser({ email, password });

  const enrollRes = await post(`${API}/account/twoFactor/enrollment`, {
    headers: authHeaders,
    json: { password },
  });
  expect(enrollRes.status).toBe(201);
  const { otpauthUri } = (await enrollRes.json()) as { otpauthUri: string; setupKey: string };

  const totp = OTPAuth.URI.parse(otpauthUri) as OTPAuth.TOTP;
  const code = totp.generate();

  const activateRes = await put(`${API}/account/twoFactor/enrollment`, {
    headers: authHeaders,
    json: { code },
  });
  expect(activateRes.status).toBe(200);
  const { recoveryCodes } = (await activateRes.json()) as { recoveryCodes: string[] };

  return { authHeaders, recoveryCodes };
}

describe("Post-Admin-Reset Restricted State (Story 4.4, FR33, D14)", () => {
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

  test("non-reenroll-required account has normal access to /maps (control)", async () => {
    const { authHeaders } = await enrollUser("control@example.com", "password");
    const res = await get(`${API}/maps/`, { headers: authHeaders });
    expect(res.status).toBe(200);
  }, 15000);

  test("account with two_factor_reenroll_required=1 gets 403 on /maps", async () => {
    const { authHeaders } = await enrollUser("reenroll@example.com", "password");
    await dbAdapter.run(
      "UPDATE account SET two_factor_reenroll_required = 1 WHERE email = ?",
      ["reenroll@example.com"],
    );
    const res = await get(`${API}/maps/`, { headers: authHeaders });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("2FA_REENROLL_REQUIRED");
  }, 15000);

  test("restricted account can still GET /account (exempt path)", async () => {
    const { authHeaders } = await enrollUser("exempt@example.com", "password");
    await dbAdapter.run(
      "UPDATE account SET two_factor_reenroll_required = 1 WHERE email = ?",
      ["exempt@example.com"],
    );
    const res = await get(`${API}/account`, { headers: authHeaders });
    expect(res.status).toBe(200);
  }, 15000);

  test("restricted account can GET /account/twoFactor (exempt path)", async () => {
    const { authHeaders } = await enrollUser("twofa@example.com", "password");
    await dbAdapter.run(
      "UPDATE account SET two_factor_reenroll_required = 1 WHERE email = ?",
      ["twofa@example.com"],
    );
    const res = await get(`${API}/account/twoFactor`, { headers: authHeaders });
    expect(res.status).toBe(200);
  }, 15000);

  test("restricted account can GET /account/securityEvents (exempt path)", async () => {
    const { authHeaders } = await enrollUser("events@example.com", "password");
    await dbAdapter.run(
      "UPDATE account SET two_factor_reenroll_required = 1 WHERE email = ?",
      ["events@example.com"],
    );
    const res = await get(`${API}/account/securityEvents`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  }, 15000);

  test("GET /account/securityEvents returns admin_reset_approved event with actor and reason", async () => {
    const { authHeaders } = await enrollUser("victim@example.com", "password");
    await dbAdapter.run(
      `INSERT INTO security_event
         (affected_account_id, actor_email, action, outcome, reason, detail, created_at)
       SELECT id, 'admin@example.com', 'admin_reset_approved', 'success', 'Lost phone', NULL, ?
       FROM account WHERE email = 'victim@example.com'`,
      [Date.now()],
    );
    const res = await get(`${API}/account/securityEvents`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { action: string; actorEmail: string; reason: string | null }[];
    };
    const resetEvent = body.events.find((e) => e.action === "admin_reset_approved");
    expect(resetEvent).toBeDefined();
    expect(resetEvent!.actorEmail).toBe("admin@example.com");
    expect(resetEvent!.reason).toBe("Lost phone");
  }, 15000);

  test("re-enrolling while restricted clears two_factor_reenroll_required and restores access", async () => {
    const { authHeaders } = await enrollUser("clear@example.com", "password");
    await dbAdapter.run(
      "UPDATE account SET two_factor_reenroll_required = 1 WHERE email = ?",
      ["clear@example.com"],
    );

    // Confirm blocked
    const beforeRes = await get(`${API}/maps/`, { headers: authHeaders });
    expect(beforeRes.status).toBe(403);

    // Re-enroll (enrollment endpoints are exempt from the reenroll gate)
    const enrollRes = await post(`${API}/account/twoFactor/enrollment`, {
      headers: authHeaders,
      json: { password: "password" },
    });
    expect(enrollRes.status).toBe(201);
    const { otpauthUri } = (await enrollRes.json()) as { otpauthUri: string };
    const totp = OTPAuth.URI.parse(otpauthUri) as OTPAuth.TOTP;
    const code = totp.generate();

    const activateRes = await put(`${API}/account/twoFactor/enrollment`, {
      headers: authHeaders,
      json: { code },
    });
    expect(activateRes.status).toBe(200);

    // Flag cleared — /maps accessible again
    const afterRes = await get(`${API}/maps/`, { headers: authHeaders });
    expect(afterRes.status).toBe(200);
  }, 30000);
});
