import { Hono, type Context } from "hono";

import * as accounts from "../../db/repos/accounts.ts";
import * as authService from "../../services/authService.ts";
import { bunPasswordHasher, type PasswordHasher } from "../../util/passwordHash.ts";
import { BadRequestError } from "../../domain/errors.ts";
import { toRestUser } from "../dto/restUser.ts";
import { currentUser, requireUser } from "../middleware/requireUser.ts";
import type { Env } from "../env.ts";

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
