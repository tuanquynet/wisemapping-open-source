import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";

import { buildConfig, config, getConfig, setConfig } from "../src/config.ts";
import * as accounts from "../src/db/repos/accounts.ts";
import { signToken, verifyToken } from "../src/util/jwt.ts";
import { createUser } from "./helpers/auth.ts";
import { API, get, post } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");

describe("Session Revocation by Epoch (Story 4.2, D9, AR11, FR32, FR39)", () => {
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

  test("signToken includes se claim matching the supplied epoch (AC #1)", async () => {
    const email = "epoch.test@example.com";
    const token = await signToken(email, 5);

    const claims = await verifyToken(token);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe(email);
    expect(claims?.se).toBe(5);
  });

  test("token without se claim is treated as epoch 0 and accepted when session_epoch is 0 (FR39, AC #2)", async () => {
    const user = await createUser();

    // Manually sign a legacy token without `se` claim
    const nowSeconds = Math.floor(Date.now() / 1000);
    const secret = new TextDecoder().decode(config.jwtKey);
    const legacyToken = await sign(
      {
        sub: user.email,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      },
      secret,
      "HS256",
    );

    // Guarded route accepts legacy token
    const res = await get(`${API}/account`, {
      headers: { Authorization: `Bearer ${legacyToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe(user.email);
  });

  test("bumping session_epoch immediately invalidates earlier tokens with 401 (AR11, FR32, AC #3)", async () => {
    const user = await createUser();

    // Verify initial session token works
    const res1 = await get(`${API}/account`, {
      headers: user.authHeaders,
    });
    expect(res1.status).toBe(200);

    // Fetch account ID to bump epoch
    const account = await accounts.findRowByEmail(user.email);
    expect(account).not.toBeNull();
    expect(account!.session_epoch).toBe(0);

    // Bump epoch to 1 (e.g. simulated admin reset or credential revocation)
    const newEpoch = await accounts.bumpSessionEpoch(account!.id);
    expect(newEpoch).toBe(1);

    // Previous token (carrying se: 0 or no se) is now rejected with 401!
    const res2 = await get(`${API}/account`, {
      headers: user.authHeaders,
    });
    expect(res2.status).toBe(401);
  });

  test("tokens minted after the bump carry new epoch and are accepted (AC #4)", async () => {
    const user = await createUser();
    const account = (await accounts.findRowByEmail(user.email))!;

    // Bump epoch to 3
    await accounts.bumpSessionEpoch(account.id);
    await accounts.bumpSessionEpoch(account.id);
    const finalEpoch = await accounts.bumpSessionEpoch(account.id);
    expect(finalEpoch).toBe(3);

    // Sign in again via /authenticate
    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    expect(authRes.status).toBe(200);
    const newToken = await authRes.text();

    const claims = await verifyToken(newToken);
    expect(claims?.se).toBe(3);

    // New token works on guarded route
    const res = await get(`${API}/account`, {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    expect(res.status).toBe(200);
  });

  test("accounts that never use 2FA operate with zero regression (FR39, AC #5)", async () => {
    // Non-2FA user registers and logs in normally
    const user = await createUser();

    const authRes = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    expect(authRes.status).toBe(200);
    const token = await authRes.text();

    const res = await get(`${API}/account`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});
