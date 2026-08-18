import { Hono } from "hono";

import * as authService from "../../services/authService.ts";
import * as lockManager from "../../services/lockManager.ts";
import { BadRequestError } from "../../domain/errors.ts";
import type { Env } from "../env.ts";

export const authRoutes = new Hono<Env>();

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
  const token = await authService.login(email, password);

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
authRoutes.post("/logout", (c) => {
  // Release any edit locks this user holds, replacing the Java
  // listener/UnlockOnExpireListener. Without this a signed-out user's lock
  // blocks other editors for up to the full 30-minute TTL.
  const user = c.get("user");
  if (user !== null) lockManager.unlockAll(user);
  return c.body(null, 200);
});
