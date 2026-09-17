import { createMiddleware } from "hono/factory";

import { config } from "../../config.ts";
import { unauthorizedBody } from "./errorHandler.ts";
import { AccessDeniedError } from "../../domain/errors.ts";
import * as securityEventRepo from "../../db/repos/securityEventRepo.ts";
import type { Env } from "../env.ts";

/**
 * Route guard restricting 2FA reset capability to a dedicated allowlist (D13, FR29, FR35).
 * Strictly independent of general administrative privileges (requireAdmin).
 *
 * 1. Returns 404 if twoFactorEnabled is false (fail-closed, feature-flag gated).
 * 2. Returns 401 if unauthenticated.
 * 3. Returns 403 and records an audit denial event if caller's email is not on TWO_FACTOR_RESET_EMAILS.
 */
export const requireTwoFactorReset = createMiddleware<Env>(async (c, next) => {
  let isEnabled = false;
  let resetEmails: string[] = [];

  const reqConfig = c.get("config");
  if (reqConfig) {
    isEnabled = reqConfig.twoFactorEnabled;
    resetEmails = reqConfig.twoFactorResetEmails;
  } else if (typeof Bun !== "undefined") {
    try {
      isEnabled = config.twoFactorEnabled;
      resetEmails = config.twoFactorResetEmails;
    } catch {
      isEnabled = false;
      resetEmails = [];
    }
  }

  if (!isEnabled) {
    return c.notFound();
  }

  const user = c.get("user");
  if (user === null) {
    return c.json(unauthorizedBody(), 401);
  }

  const callerEmail = user.email.toLowerCase().trim();
  const isAllowed = resetEmails.some((e) => e.toLowerCase().trim() === callerEmail);

  if (!isAllowed) {
    // Record denied attempt in security_event (FR36)
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: user.id,
      actorEmail: user.email,
      action: "admin_reset_denied",
      outcome: "failure",
      reason: "forbidden_permission",
      detail: JSON.stringify({ path: c.req.path }),
    });

    throw new AccessDeniedError("Forbidden: 2FA reset permission required.");
  }

  await next();
});
