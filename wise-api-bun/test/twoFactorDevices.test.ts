import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";

import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import { createUser } from "./helpers/auth.ts";
import { API, del, get, post, put } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

async function enrollActivateAndTrustDevices(count: number = 2) {
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

  await put(`${API}/account/twoFactor/enrollment`, {
    headers: user.authHeaders,
    json: { code: totp.generate() },
  });

  const deviceTokens: string[] = [];

  for (let i = 0; i < count; i++) {
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    const { challengeToken } = (await authRes.json()) as { challengeToken: string };

    await dbAdapter.run(
      "UPDATE account_totp SET last_accepted_step = last_accepted_step - 2 WHERE account_id = (SELECT id FROM account WHERE email = ?)",
      [user.email],
    );

    const challengeRes = await post(`${API}/twoFactor/challenge`, {
      headers: { "User-Agent": `TestBrowser/${i + 1}.0 (macOS)` },
      json: { challengeToken, code: totp.generate(), rememberDevice: true },
    });
    expect(challengeRes.status).toBe(200);
    deviceTokens.push(challengeRes.headers.get("X-Device-Token")!);
  }

  return { user, deviceTokens };
}

describe("Trusted Devices Management (FR18, FR19, UX-DR2)", () => {
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

  test("GET /account/twoFactor/devices lists active trusted devices (FR18)", async () => {
    const { user } = await enrollActivateAndTrustDevices(2);

    const res = await get(`${API}/account/twoFactor/devices`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      devices: Array<{
        id: number;
        label: string;
        createdAt: number;
        expiresAt: number;
        lastUsedAt: number | null;
      }>;
    };
    expect(body.devices.length).toBe(2);
    const d0 = body.devices[0]!;
    expect(d0.label).toBeTruthy();
    expect(d0.createdAt).toBeGreaterThan(0);
    expect(d0.expiresAt).toBeGreaterThan(d0.createdAt);
  });

  test("GET /account/twoFactor/devices excludes expired and revoked devices (FR18)", async () => {
    const { user } = await enrollActivateAndTrustDevices(2);

    // Get devices to find their IDs
    const listRes = await get(`${API}/account/twoFactor/devices`, {
      headers: user.authHeaders,
    });
    const { devices } = (await listRes.json()) as { devices: Array<{ id: number }> };
    expect(devices.length).toBe(2);

    // Soft-revoke the first device
    const dev0 = devices[0]!;
    const dev1 = devices[1]!;
    await dbAdapter.run("UPDATE trusted_device SET revoked_at = ? WHERE id = ?", [
      Date.now(),
      dev0.id,
    ]);

    // Expire the second device
    await dbAdapter.run("UPDATE trusted_device SET expires_at = ? WHERE id = ?", [
      Date.now() - 1000,
      dev1.id,
    ]);

    const res2 = await get(`${API}/account/twoFactor/devices`, {
      headers: user.authHeaders,
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { devices: unknown[] };
    expect(body2.devices.length).toBe(0);
  });

  test("DELETE /account/twoFactor/devices/:id revokes single device and records security event (FR19)", async () => {
    const { user } = await enrollActivateAndTrustDevices(2);

    const listRes = await get(`${API}/account/twoFactor/devices`, {
      headers: user.authHeaders,
    });
    const { devices } = (await listRes.json()) as { devices: Array<{ id: number }> };
    const targetId = devices[0]!.id;
    const otherId = devices[1]!.id;
    const delRes = await del(`${API}/account/twoFactor/devices/${targetId}`, {
      headers: user.authHeaders,
    });
    expect(delRes.status).toBe(204);

    // Verify row is soft-revoked in DB
    const row = await dbAdapter.get<{ revoked_at: number | null }>(
      "SELECT revoked_at FROM trusted_device WHERE id = ?",
      [targetId],
    );
    expect(row?.revoked_at).not.toBeNull();

    // Verify security_event was recorded
    const event = await dbAdapter.get<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM security_event WHERE affected_account_id = (SELECT id FROM account WHERE email = ?) AND action = 'device_revoked'",
      [user.email],
    );
    expect(event?.action).toBe("device_revoked");
    expect(event?.outcome).toBe("success");

    // Only 1 active device remains
    const afterRes = await get(`${API}/account/twoFactor/devices`, {
      headers: user.authHeaders,
    });
    const afterBody = (await afterRes.json()) as { devices: Array<{ id: number }> };
    expect(afterBody.devices.length).toBe(1);
    expect(afterBody.devices[0]!.id).toBe(otherId);
  });

  test("DELETE /account/twoFactor/devices/:id returns 404 for nonexistent or foreign device (FR19)", async () => {
    const { user } = await enrollActivateAndTrustDevices(1);
    const otherUser = await createUser();

    // Non-existent ID
    const res404 = await del(`${API}/account/twoFactor/devices/99999`, {
      headers: user.authHeaders,
    });
    expect(res404.status).toBe(404);

    // Other user's device
    const listRes = await get(`${API}/account/twoFactor/devices`, {
      headers: user.authHeaders,
    });
    const { devices } = (await listRes.json()) as { devices: Array<{ id: number }> };
    const deviceId = devices[0]!.id;
    const foreignRes = await del(`${API}/account/twoFactor/devices/${deviceId}`, {
      headers: otherUser.authHeaders,
    });
    expect(foreignRes.status).toBe(404);
  });

  test("DELETE /account/twoFactor/devices revokes all devices and records security event (FR19)", async () => {
    const { user } = await enrollActivateAndTrustDevices(3);

    const delRes = await del(`${API}/account/twoFactor/devices`, {
      headers: user.authHeaders,
    });
    expect(delRes.status).toBe(204);

    // Verify all rows are soft-revoked
    const activeRows = await dbAdapter.all(
      "SELECT id FROM trusted_device WHERE account_id = (SELECT id FROM account WHERE email = ?) AND revoked_at IS NULL",
      [user.email],
    );
    expect(activeRows.length).toBe(0);

    // Verify security_event was recorded
    const event = await dbAdapter.get<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM security_event WHERE affected_account_id = (SELECT id FROM account WHERE email = ?) AND action = 'all_devices_revoked'",
      [user.email],
    );
    expect(event?.action).toBe("all_devices_revoked");
    expect(event?.outcome).toBe("success");

    // List returns empty
    const afterRes = await get(`${API}/account/twoFactor/devices`, {
      headers: user.authHeaders,
    });
    const afterBody = (await afterRes.json()) as { devices: unknown[] };
    expect(afterBody.devices.length).toBe(0);
  });

  test("returns 404 when TWO_FACTOR_ENABLED is false", async () => {
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "false",
      }),
    );
    const user = await createUser();

    const getRes = await get(`${API}/account/twoFactor/devices`, {
      headers: user.authHeaders,
    });
    expect(getRes.status).toBe(404);

    const delRes = await del(`${API}/account/twoFactor/devices`, {
      headers: user.authHeaders,
    });
    expect(delRes.status).toBe(404);
  });
});
