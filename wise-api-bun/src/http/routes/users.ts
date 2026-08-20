import { Hono, type Context } from "hono";

import * as authService from "../../services/authService.ts";
import { bunPasswordHasher, type PasswordHasher } from "../../util/passwordHash.ts";
import { BadRequestError } from "../../domain/errors.ts";
import type { Env } from "../env.ts";

export const userRoutes = new Hono<Env>();

function resolvePasswordHasher(c: Context<Env>): PasswordHasher {
  return c.get("passwordHasher") ?? bunPasswordHasher;
}

async function jsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    return ((await c.req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    throw new BadRequestError("A JSON body is required.");
  }
}

/**
 * POST /api/restful/users/  -- registration (public).
 *
 * 201 with both `Location` and the custom `ResourceId` header, matching
 * `UserController.registerUser`. The Java mapping is `value = "/"`; the app is
 * built with `strict: false` so both spellings reach this handler.
 */
userRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  const { account } = await authService.register(body, resolvePasswordHasher(c));

  c.header("Location", `/api/restful/users/${account.id}`);
  c.header("ResourceId", String(account.id));
  return c.body(null, 201);
});

/**
 * PUT /api/restful/users/resetPassword?email=  -- public.
 *
 * Returns `{action}` per `RestResetPasswordResponse`. Always reports EMAIL_SENT,
 * even for an unknown address: the Java app throws EmailNotExistsException here,
 * which turns the endpoint into an account-existence oracle.
 */
userRoutes.put("/resetPassword", async (c) => {
  const email = c.req.query("email");
  if (email === undefined || email === "") {
    throw new BadRequestError("An email address is required.");
  }
  return c.json(await authService.requestPasswordReset(email));
});

/** POST /api/restful/users/resetPasswordToken -- public, 204. */
userRoutes.post("/resetPasswordToken", async (c) => {
  const body = await jsonBody(c);
  await authService.resetPasswordFromToken(body.token, body.password, resolvePasswordHasher(c));
  return c.body(null, 204);
});

/**
 * PUT /api/restful/users/activation?code= -- public, 204.
 *
 * The code is read as a string and never parsed. It is a signed 64-bit value in
 * the Java app; `Number()` on its 19 digits loses precision, which would fail
 * activation for a subset of accounts.
 */
userRoutes.put("/activation", async (c) => {
  const code = c.req.query("code");
  if (code === undefined || code === "") {
    throw new BadRequestError("An activation code is required.");
  }
  await authService.activate(code);
  return c.body(null, 204);
});
