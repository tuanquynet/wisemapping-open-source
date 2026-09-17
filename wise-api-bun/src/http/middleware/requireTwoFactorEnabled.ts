import { createMiddleware } from "hono/factory";

import { config } from "../../config.ts";
import type { Env } from "../env.ts";

/**
 * Route guard ensuring two-factor authentication is globally enabled.
 * If TWO_FACTOR_ENABLED is false, returns HTTP 404 Not Found (AC #1, AR23).
 */
export const requireTwoFactorEnabled = createMiddleware<Env>(async (c, next) => {
  let isEnabled = false;
  const reqConfig = c.get("config");
  if (reqConfig) {
    isEnabled = reqConfig.twoFactorEnabled;
  } else if (typeof Bun !== "undefined") {
    try {
      isEnabled = config.twoFactorEnabled;
    } catch {
      isEnabled = false;
    }
  }

  if (!isEnabled) {
    return c.notFound();
  }
  await next();
});
