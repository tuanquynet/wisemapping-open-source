import { Hono, type Context } from "hono";

import * as authService from "../../services/authService.ts";
import { bunPasswordHasher, type PasswordHasher } from "../../util/passwordHash.ts";
import { bunLockManager } from "../../services/lockManager.ts";
import type { LockManager } from "../../services/lockManager.interface.ts";
import { BadRequestError } from "../../domain/errors.ts";
import type { Env } from "../env.ts";
import { config } from "../../config.ts";
import { signToken, signChallengeToken } from "../../util/jwt.ts";
import * as twoFactorRepo from "../../db/repos/twoFactorRepo.ts";
import * as trustedDeviceRepo from "../../db/repos/trustedDeviceRepo.ts";
import { hashDeviceToken } from "../../util/deviceToken.ts";

export const authRoutes = new Hono<Env>();

function resolveLockManager(c: Context<Env>): LockManager {
  return c.get("lockManager") ?? bunLockManager;
}

function resolvePasswordHasher(c: Context<Env>): PasswordHasher {
  return c.get("passwordHasher") ?? bunPasswordHasher;
}

/**
 * POST /api/restful/authenticate
 *
 * The response contract has two halves and the frontend uses both:
 *   1. the body is the BARE token string -- not JSON, not quoted;
 *   2. the same token is echoed in an `Authorization: Bearer <token>` RESPONSE
 *      header (see `JwtTokenUtil.doLogin`).
 * CORS must expose `Authorization` or the browser cannot read half of it.
 */
authRoutes.post("/authenticate", async (c) => {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    throw new BadRequestError(
      "A JSON body with email and password is required.",
    );
  }

  const { email, password } = (payload ?? {}) as {
    email?: unknown;
    password?: unknown;
  };
  const account = await authService.verifyCredentials(email, password, resolvePasswordHasher(c));

  const cfg = c.get("config") ?? config;
  if (cfg.twoFactorEnabled) {
    const twoFactorStatus = await twoFactorRepo.getStatus(account.id);
    if (twoFactorStatus.enabled) {
      // Check if client presented a valid, live trusted device token (FR16, D11, D12)
      const deviceTokenHeader = c.req.header("X-Device-Token");
      if (deviceTokenHeader) {
        const tokenHash = await hashDeviceToken(deviceTokenHeader);
        const liveDevice = await trustedDeviceRepo.findLiveDevice(account.id, tokenHash);
        if (liveDevice !== null) {
          await trustedDeviceRepo.touchDevice(liveDevice.id);
          // Bypass 2FA challenge!
          const token = await signToken(account.email.toLowerCase(), account.session_epoch);
          c.header("Authorization", `Bearer ${token}`);
          return c.text(token);
        }
      }

      const challengeToken = await signChallengeToken(account.email);
      return c.json(
        {
          action: "TWO_FACTOR_REQUIRED",
          challengeToken,
          expiresInSec: 300,
          recoveryAvailable: twoFactorStatus.recoveryCodesRemaining > 0,
        },
        202,
      );
    }
  }

  const token = await signToken(account.email.toLowerCase(), account.session_epoch);
  c.header("Authorization", `Bearer ${token}`);
  return c.text(token);
});

/**
 * POST /api/restful/logout
 *
 * Idempotent and public: tokens are stateless so there is nothing to revoke.
 * It exists so the client has a single call to make, and so held edit locks can
 * be released.
 */
authRoutes.post("/logout", async (c) => {
  // Release any edit locks this user holds, replacing the Java
  // listener/UnlockOnExpireListener. Without this a signed-out user's lock
  // blocks other editors for up to the full 30-minute TTL.
  const user = c.get("user");
  if (user !== null) await resolveLockManager(c).unlockAll(user);
  return c.body(null, 200);
});
