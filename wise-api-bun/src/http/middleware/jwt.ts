import { createMiddleware } from "hono/factory";

import * as accounts from "../../db/repos/accounts.ts";
import { bearerToken, verifyToken } from "../../util/jwt.ts";
import type { Env } from "../env.ts";

/**
 * Resolves the caller from the `Authorization` header, if present.
 *
 * Deliberately non-failing: it sets `user` to the account or to null and always
 * calls `next()`. `requireUser` is what rejects. That split is what lets the
 * public map routes (`GET /maps/{id}/metadata`, `/document/xml`) serve both
 * anonymous and authenticated callers with no branching inside the handler.
 *
 * Like the Java filter, the account is re-loaded from the database on every
 * request rather than trusted from the token, so deleting an account revokes
 * its outstanding tokens immediately.
 */
export const jwt = createMiddleware<Env>(async (c, next) => {
  c.set("user", null);

  const token = bearerToken(c.req.header("Authorization"));
  if (token !== null) {
    const claims = await verifyToken(token);
    if (claims !== null) {
      // Challenge tokens cannot satisfy session authentication (FR9)
      if (claims.pur === "2fa_challenge") {
        await next();
        return;
      }
      const account = await accounts.findByEmail(claims.sub);
      // A placeholder or unactivated account must not count as authenticated.
      if (
        account !== null &&
        account.isRegistered &&
        account.activatedAt !== null
      ) {
        // D9, AR11: Compare token's se claim against account's sessionEpoch.
        // A token missing se is treated as epoch 0 (for legacy / pre-existing tokens per FR39).
        const tokenEpoch = typeof claims.se === "number" ? claims.se : 0;
        const currentEpoch = account.sessionEpoch ?? 0;
        if (tokenEpoch >= currentEpoch) {
          c.set("user", account);
        }
      }
    }
  }

  await next();
});
