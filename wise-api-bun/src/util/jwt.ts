import { sign, verify } from "hono/jwt";

import { config } from "../config.ts";
import { logger } from "./logger.ts";

/**
 * JWT handling, matching `security/JwtTokenUtil.java`.
 *
 * Claims are exactly `sub` (the email), `iat` and `exp` -- no roles, no user id.
 * Roles are derived per-request from the loaded account, so a suspended or
 * deleted user cannot keep acting on a still-valid token.
 */

const ALG = "HS256";
export const BEARER_PREFIX = "Bearer ";

/** The HMAC key as a string, since hono/jwt takes a string secret. */
const secret = new TextDecoder().decode(config.jwtKey);

export interface Claims {
  sub: string;
  iat: number;
  exp: number;
}

export async function signToken(email: string): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await sign(
    {
      sub: email,
      iat: nowSeconds,
      exp: nowSeconds + config.jwtExpirationMin * 60,
    },
    secret,
    ALG,
  );

  // The Java version warns past 3500 bytes, where cookie/header limits bite.
  if (token.length > 3500) {
    logger.warn(`Generated JWT is unusually large (${token.length} bytes)`);
  }
  return token;
}

/** Returns the claims, or null for any malformed, mis-signed or expired token. */
export async function verifyToken(token: string): Promise<Claims | null> {
  try {
    const payload = (await verify(token, secret, ALG)) as unknown as Claims;
    return typeof payload.sub === "string" && payload.sub !== ""
      ? payload
      : null;
  } catch {
    // Expired and forged tokens are both just "not authenticated"; the
    // distinction is not useful to the caller and leaks information.
    return null;
  }
}

/** Extracts the raw token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token === "" ? null : token;
}
