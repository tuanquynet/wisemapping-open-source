import { Hono, type Context } from "hono";

import * as accounts from "../../db/repos/accounts.ts";
import * as authService from "../../services/authService.ts";

import { bunPasswordHasher, type PasswordHasher } from "../../util/passwordHash.ts";
import { BadRequestError } from "../../domain/errors.ts";
import { bearerToken, verifyToken } from "../../util/jwt.ts";
import { decryptSecret, encryptSecret } from "../../util/secretCipher.ts";
import { buildOtpauthUri, generateTotpSecret, verifyTotpCode } from "../../util/totp.ts";
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from "../../util/recoveryCode.ts";
import { toRestUser } from "../dto/restUser.ts";
import { currentUser, requireUser } from "../middleware/requireUser.ts";
import type { Env } from "../env.ts";
import { requireTwoFactorEnabled } from "../middleware/requireTwoFactorEnabled.ts";
import * as twoFactorRepo from "../../db/repos/twoFactorRepo.ts";
import * as securityEventRepo from "../../db/repos/securityEventRepo.ts";
import * as trustedDeviceRepo from "../../db/repos/trustedDeviceRepo.ts";
import type { RestTrustedDevice, RestSecurityEvent, RestSecurityEventList } from "../dto/restTwoFactor.ts";

export const accountRoutes = new Hono<Env>();

function resolvePasswordHasher(c: Context<Env>): PasswordHasher {
  return c.get("passwordHasher") ?? bunPasswordHasher;
}

// Every route here requires an authenticated user, matching the class-level
// @PreAuthorize("isAuthenticated() and hasRole('ROLE_USER')") on AccountController.
accountRoutes.use("*", requireUser);

/** GET /api/restful/account */
accountRoutes.get("/", (c) => {
  const user = currentUser(c);
  return c.json(toRestUser(user, authService.isAdmin(user)));
});

/** GET /api/restful/account/twoFactor -- session-authenticated + feature-flag gated */
accountRoutes.get("/twoFactor", requireUser, requireTwoFactorEnabled, async (c) => {
  const user = currentUser(c);
  const status = await twoFactorRepo.getStatus(user.id);
  return c.json(status);
});

/**
 * DELETE /api/restful/account/twoFactor (FR25, FR26, FR27).
 *
 * Turns off two-factor authentication after fresh verification.
 * Deletes account_totp, deletes all recovery codes, and soft-revokes all trusted devices.
 * Returns 204 No Content.
 */
accountRoutes.delete("/twoFactor", requireUser, requireTwoFactorEnabled, async (c) => {
  const user = currentUser(c);
  const totpRow = await twoFactorRepo.getTotpRow(user.id);
  if (totpRow === null || totpRow.status !== "active") {
    return c.json({ msg: "Two-step verification is not active for this account." }, 409);
  }

  const accountRow = await accounts.findRowByEmail(user.email);
  if (accountRow === null || accountRow.password_hash === null) {
    throw new BadRequestError("Account password is not available.");
  }

  // FR26: Fresh verification required
  const payload = (await c.req.json().catch(() => null)) as {
    code?: unknown;
    password?: unknown;
  } | null;

  let verified = false;
  const rawCode = typeof payload?.code === "string" ? payload.code.trim() : "";
  if (rawCode.length > 0) {
    const normalized = normalizeRecoveryCode(rawCode);
    if (/^\d{6}$/.test(rawCode.replace(/\s+/g, ""))) {
      const activeSecret = await decryptSecret(totpRow.secret_cipher, user.id);
      const verification = verifyTotpCode(activeSecret, rawCode.replace(/\s+/g, ""));
      if (
        verification.valid &&
        verification.step !== undefined &&
        (totpRow.last_accepted_step === null || totpRow.last_accepted_step < verification.step)
      ) {
        verified = true;
      }
    } else if (normalized.length === 10) {
      const codeHash = await hashRecoveryCode(normalized);
      const result = await twoFactorRepo.consumeRecoveryCode(user.id, codeHash);
      if (result.success) {
        verified = true;
      }
    }
  }

  if (!verified && typeof payload?.password === "string" && payload.password.trim() !== "") {
    if (!accountRow.password_hash.startsWith("OAUTH:")) {
      const passwordHasher = resolvePasswordHasher(c);
      verified = await passwordHasher.verify(payload.password, accountRow.password_hash);
    }
  }

  if (!verified) {
    return c.json(
      {
        globalSeverity: "ERROR",
        globalErrors: [],
        fieldErrors: {
          code: "Current security code or password is required to turn off two-step verification.",
        },
      },
      400,
    );
  }

  await twoFactorRepo.disableTwoFactor(user.id);
  await securityEventRepo.recordSecurityEvent({
    affectedAccountId: user.id,
    actorEmail: user.email,
    action: "two_factor_disabled",
    outcome: "success",
  });

  return c.body(null, 204);
});

/**
 * POST /api/restful/account/twoFactor/enrollment (FR2, FR3; D10 identity reconfirmation).
 *
 * Password accounts re-enter their password; OAuth accounts
 * (`password_hash = 'OAUTH:GOOGLE'`, which verifies against nothing) instead
 * prove freshness: the bearer token must have been issued within 5 minutes.
 * Returns 201 with `{otpauthUri, setupKey}` and stores the secret encrypted
 * at rest as a `pending` enrollment row.
 */
accountRoutes.post(
  "/twoFactor/enrollment",
  requireUser,
  requireTwoFactorEnabled,
  async (c) => {
    const user = currentUser(c);
    const accountRow = await accounts.findRowByEmail(user.email);
    if (accountRow === null || accountRow.password_hash === null) {
      throw new BadRequestError("Account password is not available.");
    }

    const currentTotp = await twoFactorRepo.getTotpRow(user.id);
    const isReplacing = currentTotp?.status === "active";

    const payload = (await c.req.json().catch(() => null)) as {
      password?: unknown;
      code?: unknown;
    } | null;

    if (isReplacing) {
      // FR26: Fresh verification required when 2FA is already active.
      // Accepts current TOTP code, recovery code, or password.
      let verified = false;
      const rawCode = typeof payload?.code === "string" ? payload.code.trim() : "";
      if (rawCode.length > 0) {
        const normalized = normalizeRecoveryCode(rawCode);
        if (/^\d{6}$/.test(rawCode.replace(/\s+/g, ""))) {
          // 6-digit TOTP code
          const activeSecret = await decryptSecret(currentTotp.secret_cipher, user.id);
          const verification = verifyTotpCode(activeSecret, rawCode.replace(/\s+/g, ""));
          if (
            verification.valid &&
            verification.step !== undefined &&
            (currentTotp.last_accepted_step === null || currentTotp.last_accepted_step < verification.step)
          ) {
            verified = true;
          }
        } else if (normalized.length === 10) {
          // Recovery code
          const codeHash = await hashRecoveryCode(normalized);
          const result = await twoFactorRepo.consumeRecoveryCode(user.id, codeHash);
          if (result.success) {
            verified = true;
          }
        }
      }

      if (!verified && typeof payload?.password === "string" && payload.password.trim() !== "") {
        if (!accountRow.password_hash.startsWith("OAUTH:")) {
          const passwordHasher = resolvePasswordHasher(c);
          verified = await passwordHasher.verify(payload.password, accountRow.password_hash);
        }
      }

      if (!verified) {
        return c.json(
          {
            globalSeverity: "ERROR",
            globalErrors: [],
            fieldErrors: { code: "Current security code or password is required to replace your authenticator." },
          },
          400,
        );
      }

      const secret = generateTotpSecret();
      const secretCipher = await encryptSecret(secret, user.id);
      await twoFactorRepo.savePendingReplacement(user.id, secretCipher);

      return c.json(
        { otpauthUri: buildOtpauthUri(user.email, secret), setupKey: secret },
        201,
      );
    }

    // Initial enrollment (when not active)
    const isOAuthUser = accountRow.password_hash.startsWith("OAUTH:");
    if (!isOAuthUser) {
      if (
        typeof payload?.password !== "string" ||
        payload.password.trim() === ""
      ) {
        throw new BadRequestError("Password is required to start enrollment.");
      }
      const passwordHasher = resolvePasswordHasher(c);
      const isValid = await passwordHasher.verify(
        payload.password,
        accountRow.password_hash,
      );
      if (!isValid) {
        throw new BadRequestError("Invalid password.");
      }
    } else {
      // D10: OAuth accounts confirm identity by token freshness, not password.
      const token = bearerToken(c.req.header("Authorization"));
      const claims =
        token !== null ? await verifyToken(token) : null;
      const now = Math.floor(Date.now() / 1000);
      if (
        claims === null ||
        typeof claims.iat !== "number" ||
        now - claims.iat > 300
      ) {
        throw new BadRequestError(
          "Re-authentication required: please sign in again to start enrollment.",
        );
      }
    }

    const secret = generateTotpSecret();
    const secretCipher = await encryptSecret(secret, user.id);
    await twoFactorRepo.savePendingEnrollment(user.id, secretCipher);

    return c.json(
      { otpauthUri: buildOtpauthUri(user.email, secret), setupKey: secret },
      201,
    );
  },
);

/**
 * PUT /api/restful/account/twoFactor/enrollment (FR5, FR7 activation).
 *
 * Verifies the first correct TOTP code for a pending setup.
 * On success:
 *   - transitions status to 'active'
 *   - records activated_at and last_accepted_step
 *   - generates and hashes 10 recovery codes (set version 1)
 *   - records immutable audit event 'enrollment_activated'
 *   - returns 200 with { recoveryCodes: string[] }
 */
accountRoutes.put(
  "/twoFactor/enrollment",
  requireUser,
  requireTwoFactorEnabled,
  async (c) => {
    const user = currentUser(c);
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
    const rawCode = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
    if (rawCode.length !== 6 || !/^\d{6}$/.test(rawCode)) {
      return c.json(
        {
          globalSeverity: "ERROR",
          globalErrors: [],
          fieldErrors: { code: "Please enter a valid 6-digit code." },
        },
        400,
      );
    }

    const totpRow = await twoFactorRepo.getTotpRow(user.id);
    if (totpRow === null) {
      return c.json({ msg: "No pending enrollment to activate." }, 409);
    }

    // Branch A: Authenticator replacement (FR23, FR24)
    if (totpRow.status === "active") {
      if (!totpRow.pending_secret_cipher) {
        return c.json({ msg: "No pending enrollment to activate." }, 409);
      }
      const pendingSecret = await decryptSecret(totpRow.pending_secret_cipher, user.id);
      const verification = verifyTotpCode(pendingSecret, rawCode);
      if (!verification.valid || verification.step === undefined) {
        return c.json(
          {
            globalSeverity: "ERROR",
            globalErrors: [],
            fieldErrors: {
              code: "Invalid verification code. Authenticator codes rotate every 30 seconds.",
            },
          },
          400,
        );
      }

      await twoFactorRepo.activateReplacement(user.id, verification.step);
      // D14, FR33: clear re-enrollment gate on replacement (admin reset re-enrollment path)
      await accounts.clearReenrollRequired(user.id);
      await securityEventRepo.recordSecurityEvent({
        affectedAccountId: user.id,
        actorEmail: user.email,
        action: "authenticator_replaced",
        outcome: "success",
      });

      return c.json({ recoveryCodes: [] }, 200);
    }

    // Branch B: Initial activation
    if (totpRow.status !== "pending") {
      return c.json({ msg: "No pending enrollment to activate." }, 409);
    }

    const secret = await decryptSecret(totpRow.secret_cipher, user.id);
    const verification = verifyTotpCode(secret, rawCode);
    if (!verification.valid || verification.step === undefined) {
      return c.json(
        {
          globalSeverity: "ERROR",
          globalErrors: [],
          fieldErrors: {
            code: "Invalid verification code. Authenticator codes rotate every 30 seconds.",
          },
        },
        400,
      );
    }

    if (
      totpRow.last_accepted_step !== null &&
      totpRow.last_accepted_step >= verification.step
    ) {
      return c.json(
        {
          globalSeverity: "ERROR",
          globalErrors: [],
          fieldErrors: {
            code: "Code has already been used. Please wait for the next code.",
          },
        },
        400,
      );
    }

    const recoveryCodes = generateRecoveryCodes(10);
    const codeHashes: string[] = [];
    for (const code of recoveryCodes) {
      codeHashes.push(await hashRecoveryCode(code));
    }

    await twoFactorRepo.activateTotp(user.id, verification.step);
    await twoFactorRepo.saveRecoveryCodes(user.id, codeHashes, 1);
    // D14, FR33: clear re-enrollment gate now that the user has enrolled
    await accounts.clearReenrollRequired(user.id);
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: user.id,
      actorEmail: user.email,
      action: "enrollment_activated",
      outcome: "success",
    });

    return c.json({ recoveryCodes }, 200);
  },
);

/**
 * DELETE /api/restful/account/twoFactor/enrollment (FR6 abandon).
 * Discards a pending setup only -- never an active enrollment.
 */
accountRoutes.delete(
  "/twoFactor/enrollment",
  requireUser,
  requireTwoFactorEnabled,
  async (c) => {
    const user = currentUser(c);
    const totpRow = await twoFactorRepo.getTotpRow(user.id);
    if (totpRow?.status === "active" && totpRow.pending_secret_cipher) {
      await twoFactorRepo.deletePendingReplacement(user.id);
      return c.body(null, 204);
    }
    await twoFactorRepo.deletePendingEnrollment(user.id);
    return c.body(null, 204);
  },
);

/**
 * POST /api/restful/account/twoFactor/recoveryCodes (FR22, FR24, FR26, D3, D10).
 *
 * Regenerates 10 new recovery codes after fresh verification.
 * Atomically bumps generation, invalidating all existing recovery codes.
 * Returns 200 with `{ recoveryCodes: string[] }`.
 */
accountRoutes.post(
  "/twoFactor/recoveryCodes",
  requireUser,
  requireTwoFactorEnabled,
  async (c) => {
    const user = currentUser(c);
    const totpRow = await twoFactorRepo.getTotpRow(user.id);
    if (totpRow === null || totpRow.status !== "active") {
      return c.json({ msg: "Two-step verification is not active for this account." }, 409);
    }

    const accountRow = await accounts.findRowByEmail(user.email);
    if (accountRow === null || accountRow.password_hash === null) {
      throw new BadRequestError("Account password is not available.");
    }

    // FR26: Fresh verification required
    const payload = (await c.req.json().catch(() => null)) as {
      code?: unknown;
      password?: unknown;
    } | null;

    let verified = false;
    const rawCode = typeof payload?.code === "string" ? payload.code.trim() : "";
    if (rawCode.length > 0) {
      const normalized = normalizeRecoveryCode(rawCode);
      if (/^\d{6}$/.test(rawCode.replace(/\s+/g, ""))) {
        const activeSecret = await decryptSecret(totpRow.secret_cipher, user.id);
        const verification = verifyTotpCode(activeSecret, rawCode.replace(/\s+/g, ""));
        if (
          verification.valid &&
          verification.step !== undefined &&
          (totpRow.last_accepted_step === null || totpRow.last_accepted_step < verification.step)
        ) {
          verified = true;
        }
      } else if (normalized.length === 10) {
        const codeHash = await hashRecoveryCode(normalized);
        const result = await twoFactorRepo.consumeRecoveryCode(user.id, codeHash);
        if (result.success) {
          verified = true;
        }
      }
    }

    if (!verified && typeof payload?.password === "string" && payload.password.trim() !== "") {
      if (!accountRow.password_hash.startsWith("OAUTH:")) {
        const passwordHasher = resolvePasswordHasher(c);
        verified = await passwordHasher.verify(payload.password, accountRow.password_hash);
      }
    }

    if (!verified) {
      return c.json(
        {
          globalSeverity: "ERROR",
          globalErrors: [],
          fieldErrors: {
            code: "Current security code or password is required to regenerate recovery codes.",
          },
        },
        400,
      );
    }

    const recoveryCodes = generateRecoveryCodes(10);
    const codeHashes: string[] = [];
    for (const code of recoveryCodes) {
      codeHashes.push(await hashRecoveryCode(code));
    }

    await twoFactorRepo.regenerateRecoveryCodes(user.id, codeHashes);
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: user.id,
      actorEmail: user.email,
      action: "recovery_codes_regenerated",
      outcome: "success",
    });

    return c.json({ recoveryCodes }, 200);
  },
);

/**
 * GET /api/restful/account/twoFactor/devices (FR18)
 * Returns active (unrevoked, unexpired) trusted devices for the authenticated user.
 */
accountRoutes.get(
  "/twoFactor/devices",
  requireUser,
  requireTwoFactorEnabled,
  async (c) => {
    const user = currentUser(c);
    const rows = await trustedDeviceRepo.listActiveDevices(user.id);
    const devices: RestTrustedDevice[] = rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
    }));
    return c.json({ devices });
  },
);

/**
 * DELETE /api/restful/account/twoFactor/devices/:id (FR19)
 * Revokes a single trusted device for the authenticated user.
 */
accountRoutes.delete(
  "/twoFactor/devices/:id",
  requireUser,
  requireTwoFactorEnabled,
  async (c) => {
    const user = currentUser(c);
    const deviceId = Number.parseInt(c.req.param("id"), 10);
    if (Number.isNaN(deviceId)) {
      return c.text("Invalid device ID", 400);
    }
    const revoked = await trustedDeviceRepo.revokeDevice(user.id, deviceId);
    if (!revoked) {
      return c.text("Device not found", 404);
    }
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: user.id,
      actorEmail: user.email,
      action: "device_revoked",
      outcome: "success",
      detail: JSON.stringify({ deviceId }),
    });
    return c.body(null, 204);
  },
);

/**
 * DELETE /api/restful/account/twoFactor/devices (FR19)
 * Wholesale revocation of all trusted devices for the authenticated user.
 */
accountRoutes.delete(
  "/twoFactor/devices",
  requireUser,
  requireTwoFactorEnabled,
  async (c) => {
    const user = currentUser(c);
    const count = await trustedDeviceRepo.revokeAllDevices(user.id);
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: user.id,
      actorEmail: user.email,
      action: "all_devices_revoked",
      outcome: "success",
      detail: JSON.stringify({ count }),
    });
    return c.body(null, 204);
  },
);

/**
 * The scalar update routes all take `text/plain` with a raw string body -- not
 * JSON. Sending `{"firstname":"x"}` to these would store the literal JSON.
 */

accountRoutes.put("/password", async (c) => {
  await authService.changePassword(
    currentUser(c),
    await c.req.text(),
    resolvePasswordHasher(c),
  );
  return c.body(null, 204);
});

accountRoutes.put("/firstname", async (c) => {
  const value = (await c.req.text()).trim();
  if (value === "") throw new BadRequestError("This field is required.");
  await accounts.updateProfileField(currentUser(c).id, "firstname", value);
  return c.body(null, 204);
});

accountRoutes.put("/lastname", async (c) => {
  const value = (await c.req.text()).trim();
  if (value === "") throw new BadRequestError("This field is required.");
  await accounts.updateProfileField(currentUser(c).id, "lastname", value);
  return c.body(null, 204);
});

accountRoutes.put("/locale", async (c) => {
  const value = (await c.req.text()).trim();
  if (value === "") throw new BadRequestError("This field is required.");
  await accounts.updateProfileField(currentUser(c).id, "locale", value);
  return c.body(null, 204);
});

/**
 * DELETE /api/restful/account
 *
 * Maps, collaborations and labels go with it via ON DELETE CASCADE, which is
 * what the Java service does by hand before removing the user.
 */
accountRoutes.delete("/", async (c) => {
  await accounts.deleteById(currentUser(c).id);
  return c.body(null, 204);
});

/**
 * GET /api/restful/account/securityEvents
 *
 * Returns recent security events for the authenticated account (FR34, FR37).
 * Used by the post-reset restricted notice to display who reset the account (UX-DR20).
 */
accountRoutes.get(
  "/securityEvents",
  requireTwoFactorEnabled,
  async (c) => {
    const user = currentUser(c);
    const rows = await securityEventRepo.listSecurityEventsForAccount(user.id);
    const events: RestSecurityEvent[] = rows.map((r) => ({
      id: r.id,
      actorEmail: r.actor_email,
      action: r.action,
      outcome: r.outcome,
      reason: r.reason ?? null,
      detail: r.detail ?? null,
      createdAt: r.created_at,
    }));
    return c.json({ events } satisfies RestSecurityEventList, 200);
  },
);
