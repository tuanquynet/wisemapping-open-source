import { createMiddleware } from "hono/factory";

import { unauthorizedBody } from "./errorHandler.ts";
import type { Env } from "../env.ts";

/**
 * Rejects unauthenticated requests with the 401 body the frontend expects.
 *
 * This is `{"msg":"Unauthorized"}`, not `RestErrors` -- the Java app produces it
 * from the security filter chain's authentication entry point, which never
 * reaches `GlobalExceptionHandler`. Two error shapes in one API is odd, but it
 * is the contract.
 */
export const requireUser = createMiddleware<Env>(async (c, next) => {
  if (c.get("user") === null) {
    return c.json(unauthorizedBody(), 401);
  }
  await next();
});

/** Narrowing accessor for handlers that run behind `requireUser`. */
export function currentUser(c: {
  get: (k: "user") => Env["Variables"]["user"];
}) {
  const user = c.get("user");
  if (user === null) {
    throw new Error("currentUser() used on a route without requireUser");
  }
  return user;
}
