import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";

import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { createUser } from "./helpers/auth.ts";
import { API, post, put, get } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");
const OPERATOR_EMAIL = "operator.admin@example.com";

async function setupTargetWith2FA() {
  const target = await createUser();

  // Enroll target
  const enrollRes = await post(`${API}/account/twoFactor/enrollment`, {
    headers: target.authHeaders,
    json: { password: target.password },
  });
  const { setupKey } = (await enrollRes.json()) as { setupKey: string };

  const totp = new OTPAuth.TOTP({
    issuer: "WiseMapping",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(setupKey),
  });

  await put(`${API}/account/twoFactor/enrollment`, {
    headers: target.authHeaders,
    json: { code: totp.generate() },
  });

  // Sign in and trust device
  const authRes = await post(`${API}/authenticate`, {
    json: { email: target.email, password: target.password },
  });
  const { challengeToken } = (await authRes.json()) as { challengeToken: string };

  await dbAdapter.run(
    "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
    [target.email],
  );

  const challengeRes = await post(`${API}/twoFactor/challenge`, {
    json: { challengeToken, code: totp.generate(), rememberDevice: true },
  });
  expect(challengeRes.status).toBe(200);

  const targetAccount = await dbAdapter.get<{ id: number }>(
    "SELECT id FROM account WHERE email = ?",
    [target.email],
  );

  return { target, targetId: targetAccount!.id, totp };
}

describe("Admin 2FA Reset (Story 4.3, FR30–FR33, D14, AR16, FR36, FR38)", () => {
  const initialConfig = getConfig();

  beforeEach(() => {
    resetDb();
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY,
        TWO_FACTOR_RESET_EMAILS: OPERATOR_EMAIL,
      }),
    );
  });

  afterAll(() => setConfig(initialConfig));

  test("refuses reset when reason is empty (FR31)", async () => {
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const { targetId } = await setupTargetWith2FA();

    const res = await post(`${API}/admin/users/${targetId}/twoFactor/reset`, {
      headers: operator.authHeaders,
      json: { password: operator.password, reason: "" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: { reason?: string } };
    expect(body.fieldErrors.reason).toBeTruthy();
  });

  test("refuses reset when admin password is wrong (FR30)", async () => {
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const { targetId } = await setupTargetWith2FA();

    const res = await post(`${API}/admin/users/${targetId}/twoFactor/reset`, {
      headers: operator.authHeaders,
      json: { password: "wrong-password", reason: "Lost phone" },
    });
    expect(res.status).toBe(400);

    // Target 2FA is untouched
    const totpRow = await dbAdapter.get(
      "SELECT account_id FROM account_totp WHERE account_id = ?",
      [targetId],
    );
    expect(totpRow).not.toBeNull();
  });

  test("refuses reset with 404 when target user does not exist", async () => {
    const operator = await createUser({ email: OPERATOR_EMAIL });

    const res = await post(`${API}/admin/users/999999/twoFactor/reset`, {
      headers: operator.authHeaders,
      json: { password: operator.password, reason: "Lost phone" },
    });
    expect(res.status).toBe(404);
  });

  test("executes atomic reset: factor deleted, codes deleted, devices revoked, epoch bumped, reenroll flag set (D14, FR30–FR33)", async () => {
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const { target, targetId } = await setupTargetWith2FA();

    // Verify initial state: 1 active totp, 10 recovery codes, 1 trusted device, epoch 0, reenroll 0
    const preTotp = await dbAdapter.get("SELECT * FROM account_totp WHERE account_id = ?", [targetId]);
    expect(preTotp).not.toBeNull();

    const preCodes = await dbAdapter.all("SELECT * FROM account_recovery_code WHERE account_id = ?", [targetId]);
    expect(preCodes.length).toBe(10);

    const preDevices = await dbAdapter.all(
      "SELECT * FROM trusted_device WHERE account_id = ? AND revoked_at IS NULL",
      [targetId],
    );
    expect(preDevices.length).toBe(1);

    const preAccount = await dbAdapter.get<{ session_epoch: number; two_factor_reenroll_required: number }>(
      "SELECT session_epoch, two_factor_reenroll_required FROM account WHERE id = ?",
      [targetId],
    );
    expect(preAccount?.session_epoch).toBe(0);
    expect(preAccount?.two_factor_reenroll_required).toBe(0);

    // Target user's existing session works
    const testSessionRes = await get(`${API}/account`, { headers: target.authHeaders });
    expect(testSessionRes.status).toBe(200);

    // Execute admin reset
    const reasonText = "User called helpdesk from verified phone number after losing hardware token";
    const res = await post(`${API}/admin/users/${targetId}/twoFactor/reset`, {
      headers: operator.authHeaders,
      json: { password: operator.password, reason: reasonText },
    });
    expect(res.status).toBe(204);

    // 1. Target account_totp is deleted
    const postTotp = await dbAdapter.get("SELECT * FROM account_totp WHERE account_id = ?", [targetId]);
    expect(postTotp).toBeNull();

    // 2. Target recovery codes are deleted
    const postCodes = await dbAdapter.all("SELECT * FROM account_recovery_code WHERE account_id = ?", [targetId]);
    expect(postCodes.length).toBe(0);

    // 3. Target trusted devices are soft-revoked
    const activeDevices = await dbAdapter.all(
      "SELECT * FROM trusted_device WHERE account_id = ? AND revoked_at IS NULL",
      [targetId],
    );
    expect(activeDevices.length).toBe(0);

    // 4. Session epoch incremented from 0 to 1
    // 5. two_factor_reenroll_required set to 1
    const postAccount = await dbAdapter.get<{ session_epoch: number; two_factor_reenroll_required: number }>(
      "SELECT session_epoch, two_factor_reenroll_required FROM account WHERE id = ?",
      [targetId],
    );
    expect(postAccount?.session_epoch).toBe(1);
    expect(postAccount?.two_factor_reenroll_required).toBe(1);

    // 6. Target user's existing session token is instantly revoked (D9, FR32)
    const postSessionRes = await get(`${API}/account`, { headers: target.authHeaders });
    expect(postSessionRes.status).toBe(401);

    // 7. security_event recorded with actor, target, reason, and no secrets (FR36, FR38)
    const event = await dbAdapter.get<{
      affected_account_id: number;
      actor_email: string;
      action: string;
      outcome: string;
      reason: string;
      detail: string;
    }>(
      "SELECT affected_account_id, actor_email, action, outcome, reason, detail FROM security_event WHERE affected_account_id = ? AND action = 'admin_reset_approved'",
      [targetId],
    );
    expect(event).toBeTruthy();
    expect(event?.actor_email).toBe(OPERATOR_EMAIL);
    expect(event?.affected_account_id).toBe(targetId);
    expect(event?.outcome).toBe("success");
    expect(event?.reason).toBe(reasonText);
    expect(event?.detail).toContain(target.email);
  });
});
