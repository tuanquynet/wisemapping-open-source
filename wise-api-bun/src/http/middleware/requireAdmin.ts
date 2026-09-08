import { createMiddleware } from "hono/factory";

import { isAdmin } from "../../services/authService.ts";
import { AccessDeniedError } from "../../domain/errors.ts";
import { unauthorizedBody } from "./errorHandler.ts";
import type { Env } from "../env.ts";

/**
 * Guards routes that require admin privileges.
 * 401 if unauthenticated, 403 if authenticated but not admin.
 */
export const requireAdmin = createMiddleware<Env>(async (c, next) => {
  const user = c.get("user");
  if (user === null) {
    return c.json(unauthorizedBody(), 401);
  }

  if (!isAdmin(user)) {
    throw new AccessDeniedError("You do not have admin permissions.");
  }

  await next();
});
