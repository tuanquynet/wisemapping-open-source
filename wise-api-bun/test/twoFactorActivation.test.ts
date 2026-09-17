import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";

import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { createUser } from "./helpers/auth.ts";
import { API, post, put, get, del } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

describe("PUT /api/restful/account/twoFactor/enrollment", () => {
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
    const res = await put(`${API}/account/twoFactor/enrollment`, {
      json: { code: "123456" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 404 when TWO_FACTOR_ENABLED is false", async () => {
    setConfig(buildConfig({ JWT_SECRET: VALID_JWT_SECRET, TWO_FACTOR_ENABLED: "false" }));
    const user = await createUser();
    const res = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: "123456" },
    });
    expect(res.status).toBe(404);
  });

  test("returns 409 Conflict when no pending enrollment exists", async () => {
    const user = await createUser();
    const res = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: "123456" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { msg: string };
    expect(body.msg).toContain("pending");
  });

  test("rejects with 400 when code is missing, not a string, or not 6 digits", async () => {
    const user = await createUser();
    // Start enrollment to establish pending row
    await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });

    const empty = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: {},
    });
    expect(empty.status).toBe(400);

    const nonNumeric = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: "abcdef" },
    });
    expect(nonNumeric.status).toBe(400);

    const wrongLength = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: "12345" },
    });
    expect(wrongLength.status).toBe(400);
  });

  test("rejects with 400 when code is invalid and keeps enrollment pending", async () => {
    const user = await createUser();
    await post(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { password: user.password },
    });

    const res = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: "000000" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors?.code).toContain("30 seconds");

    // Status remains pending and account remains unprotected
    const status = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    const statusBody = (await status.json()) as { enabled: boolean; pendingEnrollment: boolean };
    expect(statusBody.enabled).toBe(false);
    expect(statusBody.pendingEnrollment).toBe(true);
  });

  test("activates enrollment on valid code, returns 10 recovery codes, and records security event", async () => {
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
    const validCode = totp.generate();

    const activateRes = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: validCode },
    });
    expect(activateRes.status).toBe(200);

    const activateBody = (await activateRes.json()) as { recoveryCodes: string[] };
    expect(Array.isArray(activateBody.recoveryCodes)).toBe(true);
    expect(activateBody.recoveryCodes.length).toBe(10);
    for (const code of activateBody.recoveryCodes) {
      expect(code.length).toBe(10);
      expect(/^[0-9A-HJKMNP-TV-Z]{10}$/.test(code)).toBe(true);
    }

    // Database verification: status is active
    const totpRow = await dbAdapter.get<{
      status: string;
      activated_at: number;
      last_accepted_step: number;
    }>(
      "SELECT status, activated_at, last_accepted_step FROM account_totp WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(totpRow?.status).toBe("active");
    expect(totpRow?.activated_at).toBeGreaterThan(0);
    expect(totpRow?.last_accepted_step).toBeGreaterThan(0);

    // Database verification: 10 recovery codes saved
    const recoveryRows = await dbAdapter.all<{ code_hash: string; used_at: number | null }>(
      "SELECT code_hash, used_at FROM account_recovery_code WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(recoveryRows.length).toBe(10);
    for (const r of recoveryRows) {
      expect(r.used_at).toBeNull();
      expect(r.code_hash.length).toBe(64); // SHA-256 hex
    }

    // Database verification: security_event recorded
    const eventRow = await dbAdapter.get<{
      action: string;
      outcome: string;
      actor_email: string;
    }>(
      "SELECT action, outcome, actor_email FROM security_event WHERE affected_account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );
    expect(eventRow?.action).toBe("enrollment_activated");
    expect(eventRow?.outcome).toBe("success");
    expect(eventRow?.actor_email).toBe(user.email);

    // Status endpoint confirms 2FA is active and shows 10 remaining codes
    const statusRes = await get(`${API}/account/twoFactor`, { headers: user.authHeaders });
    const status = (await statusRes.json()) as {
      enabled: boolean;
      pendingEnrollment: boolean;
      recoveryCodesRemaining: number;
    };
    expect(status.enabled).toBe(true);
    expect(status.pendingEnrollment).toBe(false);
    expect(status.recoveryCodesRemaining).toBe(10);
  });

  test("strips whitespace from pasted code and succeeds", async () => {
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
    const formattedWithSpaces = `${code.slice(0, 3)}   ${code.slice(3)}`;

    const res = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code: formattedWithSpaces },
    });
    expect(res.status).toBe(200);
  });

  test("subsequent activation returns 409 because enrollment is now active", async () => {
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

    const first = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code },
    });
    expect(first.status).toBe(200);

    const second = await put(`${API}/account/twoFactor/enrollment`, {
      headers: user.authHeaders,
      json: { code },
    });
    expect(second.status).toBe(409);
  });
});
