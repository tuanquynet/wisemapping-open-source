import { Hono } from "hono";

import { config } from "../../config.ts";
import * as accounts from "../../db/repos/accounts.ts";
import * as twoFactorRepo from "../../db/repos/twoFactorRepo.ts";
import * as securityEventRepo from "../../db/repos/securityEventRepo.ts";
import * as trustedDeviceRepo from "../../db/repos/trustedDeviceRepo.ts";
import { generateDeviceToken, hashDeviceToken, formatDeviceLabel } from "../../util/deviceToken.ts";
import { signToken, verifyToken } from "../../util/jwt.ts";
import { normalizeRecoveryCode, hashRecoveryCode } from "../../util/recoveryCode.ts";
import { decryptSecret } from "../../util/secretCipher.ts";
import { verifyTotpCode } from "../../util/totp.ts";
import type { Env } from "../env.ts";

export const twoFactorRoutes = new Hono<Env>();

/**
 * POST /api/restful/twoFactor/challenge (FR10, D11, D17).
 *
 * Completes a 2FA challenge initiated during /authenticate.
 * Validates the challengeToken, verifies the TOTP code against active enrollment,
 * checks for replay, records a security event, and on success returns the
 * session token as bare text/plain with Authorization response header.
 */
twoFactorRoutes.post("/challenge", async (c) => {
  const cfg = c.get("config") ?? config;
  if (!cfg.twoFactorEnabled) {
    return c.json({ msg: "Not found" }, 404);
  }

  const body = (await c.req.json().catch(() => null)) as {
    challengeToken?: unknown;
    code?: unknown;
    type?: unknown;
    rememberDevice?: unknown;
  } | null;

  if (
    typeof body?.challengeToken !== "string" ||
    typeof body?.code !== "string"
  ) {
    return c.json(
      {
        globalSeverity: "ERROR",
        globalErrors: [],
        fieldErrors: { code: "A valid challenge token and code are required." },
      },
      400,
    );
  }

  const claims = await verifyToken(body.challengeToken);
  if (claims === null || claims.pur !== "2fa_challenge") {
    return c.json({ msg: "Challenge token is invalid or has expired." }, 401);
  }

  const account = await accounts.findByEmail(claims.sub);
  if (account === null) {
    return c.json({ msg: "Account not found." }, 401);
  }

  const totpRow = await twoFactorRepo.getTotpRow(account.id);
  if (totpRow === null || totpRow.status !== "active") {
    return c.json(
      { msg: "Two-factor authentication is not active for this account." },
      409,
    );
  }
  if (body.type === "recovery") {
    const normalized = normalizeRecoveryCode(body.code);
    if (normalized.length !== 10) {
      return c.json(
        {
          globalSeverity: "ERROR",
          globalErrors: [],
          fieldErrors: {
            code: "Please enter a valid 10-character recovery code.",
          },
        },
        400,
      );
    }

    const codeHash = await hashRecoveryCode(normalized);
    const result = await twoFactorRepo.consumeRecoveryCode(account.id, codeHash);

    if (result.alreadyUsed) {
      return c.json(
        {
          globalSeverity: "ERROR",
          globalErrors: [],
          fieldErrors: {
            code: `This recovery code was already used. You have ${result.remainingCount} recovery codes remaining.`,
          },
        },
        400,
      );
    }

    if (!result.success) {
      return c.json(
        {
          globalSeverity: "ERROR",
          globalErrors: [],
          fieldErrors: { code: "Invalid recovery code." },
        },
        400,
      );
    }

    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: account.id,
      actorEmail: account.email,
      action: "recovery_code_consumed",
      outcome: "success",
    });
    await twoFactorRepo.clearCooldownAndFailures(account.id);

    if (body.rememberDevice === true) {
      const rawDeviceToken = generateDeviceToken();
      const tokenHash = await hashDeviceToken(rawDeviceToken);
      const label = formatDeviceLabel(c.req.header("User-Agent"));
      await trustedDeviceRepo.insertTrustedDevice({
        accountId: account.id,
        tokenHash,
        label,
      });
      await securityEventRepo.recordSecurityEvent({
        affectedAccountId: account.id,
        actorEmail: account.email,
        action: "device_trusted",
        outcome: "success",
      });
      c.header("X-Device-Token", rawDeviceToken);
    }
    const sessionToken = await signToken(account.email.toLowerCase(), account.sessionEpoch);
    c.header("Authorization", `Bearer ${sessionToken}`);
    return c.text(sessionToken, 200);
  }

  const now = Date.now();
  if (totpRow.cooldown_until !== null && totpRow.cooldown_until > now) {
    const retryAfterSec = Math.max(1, Math.ceil((totpRow.cooldown_until - now) / 1000));
    c.header("Retry-After", String(retryAfterSec));
    return c.json(
      {
        globalSeverity: "ERROR",
        globalErrors: [],
        fieldErrors: {
          code: `Too many failed attempts. Your account is protected. Please wait ${retryAfterSec} seconds before retrying, or use a recovery code.`,
        },
      },
      429,
    );
  }

  const rawCode = body.code.replace(/\s+/g, "");
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

  const secret = await decryptSecret(totpRow.secret_cipher, account.id);
  const verification = verifyTotpCode(secret, rawCode);
  if (!verification.valid || verification.step === undefined) {
    const failure = await twoFactorRepo.recordFailedAttempt(account.id, now);
    if (failure.isNewCooldown) {
      await securityEventRepo.recordSecurityEvent({
        affectedAccountId: account.id,
        actorEmail: account.email,
        action: "cooldown_triggered",
        outcome: "failure",
      });
    }

    if (failure.cooldownUntil !== null && failure.cooldownUntil > now) {
      const retryAfterSec = Math.max(1, Math.ceil((failure.cooldownUntil - now) / 1000));
      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        {
          globalSeverity: "ERROR",
          globalErrors: [],
          fieldErrors: {
            code: `Too many failed attempts. Your account is protected. Please wait ${retryAfterSec} seconds before retrying, or use a recovery code.`,
          },
        },
        429,
      );
    }

    return c.json(
      {
        globalSeverity: "ERROR",
        globalErrors: [],
        fieldErrors: {
          code: "Invalid verification code. Authenticator codes rotate every 30 seconds. You can also use a recovery code.",
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

  // Update last_accepted_step
  await twoFactorRepo.activateTotp(
    account.id,
    verification.step,
    totpRow.activated_at ?? Date.now(),
  );

  await securityEventRepo.recordSecurityEvent({
    affectedAccountId: account.id,
    actorEmail: account.email,
    action: "challenge_succeeded",
    outcome: "success",
  });
  await twoFactorRepo.clearCooldownAndFailures(account.id);

  if (body.rememberDevice === true) {
    const rawDeviceToken = generateDeviceToken();
    const tokenHash = await hashDeviceToken(rawDeviceToken);
    const label = formatDeviceLabel(c.req.header("User-Agent"));
    await trustedDeviceRepo.insertTrustedDevice({
      accountId: account.id,
      tokenHash,
      label,
    });
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: account.id,
      actorEmail: account.email,
      action: "device_trusted",
      outcome: "success",
    });
    c.header("X-Device-Token", rawDeviceToken);
  }
  const sessionToken = await signToken(account.email.toLowerCase(), account.sessionEpoch);
  c.header("Authorization", `Bearer ${sessionToken}`);
  return c.text(sessionToken, 200);
});
