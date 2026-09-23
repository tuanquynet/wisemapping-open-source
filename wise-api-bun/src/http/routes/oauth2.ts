import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

import { config, type Config } from "../../config.ts";
import * as accounts from "../../db/repos/accounts.ts";
import * as twoFactorRepo from "../../db/repos/twoFactorRepo.ts";
import { signToken, signChallengeToken } from "../../util/jwt.ts";
import { logger } from "../../util/logger.ts";
import type { Env } from "../env.ts";

export const oauth2Routes = new Hono<Env>();

export interface OAuthState {
  origin: string;
  redirect: string;
  callbackUrl?: string | undefined;
  timestamp: number;
}
function resolveSafeOrigin(
  originCandidate: string | undefined,
  appConfig: Config,
): string {
  if (
    originCandidate &&
    originCandidate !== "*" &&
    (appConfig.corsAllowedOrigins.includes(originCandidate) ||
      originCandidate === appConfig.uiBaseUrl)
  ) {
    return originCandidate;
  }
  return appConfig.uiBaseUrl;
}

function verifyHmac(
  data: string,
  signatureHex: string,
  key: Uint8Array,
): boolean {
  try {
    if (!signatureHex || typeof signatureHex !== "string") {
      return false;
    }
    const expectedHex = createHmac("sha256", key).update(data).digest("hex");
    const expectedBuf = Buffer.from(expectedHex, "hex");
    const actualBuf = Buffer.from(signatureHex, "hex");
    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

export function signOAuthState(
  payload: OAuthState,
  jwtKey: Uint8Array,
): string {
  const base64Payload = btoa(JSON.stringify(payload));
  const hmac = createHmac("sha256", jwtKey).update(base64Payload).digest("hex");
  return `${base64Payload}.${hmac}`;
}
export interface OAuthSyncCodePayload {
  accountId: number;
  email: string;
  provider: string;
  timestamp: number;
}

export function signSyncCode(
  payload: OAuthSyncCodePayload,
  jwtKey: Uint8Array,
): string {
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const hmac = createHmac("sha256", jwtKey).update(base64Payload).digest("hex");
  return `${base64Payload}.${hmac}`;
}

export function verifySyncCode(
  code: string | undefined,
  jwtKey: Uint8Array,
  maxAgeMs = 15 * 60 * 1000,
): OAuthSyncCodePayload | null {
  if (!code || typeof code !== "string") {
    return null;
  }
  const dotIndex = code.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
  }
  const base64Payload = code.slice(0, dotIndex);
  const signatureHex = code.slice(dotIndex + 1);
  if (!base64Payload || !signatureHex) {
    return null;
  }
  if (!verifyHmac(base64Payload, signatureHex, jwtKey)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(base64Payload, "base64url").toString("utf-8"),
    ) as Partial<OAuthSyncCodePayload>;
    if (
      typeof payload.accountId !== "number" ||
      typeof payload.email !== "string" ||
      typeof payload.provider !== "string" ||
      typeof payload.timestamp !== "number"
    ) {
      return null;
    }
    if (Date.now() - payload.timestamp > maxAgeMs) {
      return null;
    }
    return payload as OAuthSyncCodePayload;
  } catch {
    return null;
  }
}

export function parseState(
  stateParam: string | undefined,
  appConfig: Config,
): { origin: string; redirect: string; callbackUrl?: string | undefined } {
  if (!stateParam) {
    return { origin: appConfig.uiBaseUrl, redirect: "/c/maps/" };
  }
  try {
    const dotIndex = stateParam.lastIndexOf(".");
    if (dotIndex === -1) {
      logger.warn("OAuth state parameter is missing HMAC signature");
      return { origin: appConfig.uiBaseUrl, redirect: "/c/maps/" };
    }
    const base64Payload = stateParam.slice(0, dotIndex);
    const signatureHex = stateParam.slice(dotIndex + 1);
    if (!base64Payload || !signatureHex) {
      logger.warn("OAuth state parameter has empty payload or signature");
      return { origin: appConfig.uiBaseUrl, redirect: "/c/maps/" };
    }

    if (!verifyHmac(base64Payload, signatureHex, appConfig.jwtKey)) {
      logger.warn("OAuth state parameter has invalid HMAC signature");
      return { origin: appConfig.uiBaseUrl, redirect: "/c/maps/" };
    }

    const decoded = JSON.parse(atob(base64Payload)) as Partial<OAuthState>;
    let origin = appConfig.uiBaseUrl;
    if (typeof decoded.origin === "string") {
      origin = resolveSafeOrigin(decoded.origin, appConfig);
    }
    let redirect = "/c/maps/";
    if (
      typeof decoded.redirect === "string" &&
      decoded.redirect.startsWith("/c/")
    ) {
      redirect = decoded.redirect;
    }
    const callbackUrl =
      typeof decoded.callbackUrl === "string" && decoded.callbackUrl.startsWith("http")
        ? decoded.callbackUrl
        : undefined;
    return { origin, redirect, callbackUrl };
  } catch {
    return { origin: appConfig.uiBaseUrl, redirect: "/c/maps/" };
  }
}

oauth2Routes.get("/google/authorize", (c) => {
  const activeConfig = c.get("config") ?? config;
  if (!activeConfig.googleOauthEnabled || !activeConfig.googleClientId) {
    return c.text("Google OAuth is not enabled.", 404);
  }

  const queryRedirect =
    c.req.query("redirect") || c.req.query("state") || "/c/maps/";
  const redirect = queryRedirect.startsWith("/c/")
    ? queryRedirect
    : "/c/maps/";

  const rawCandidate =
    c.req.query("origin") || c.req.header("Origin") || c.req.header("Referer");
  let candidateOrigin: string | undefined;
  if (rawCandidate) {
    try {
      candidateOrigin = new URL(rawCandidate).origin;
    } catch {
      candidateOrigin = rawCandidate;
    }
  }
  const origin = resolveSafeOrigin(candidateOrigin, activeConfig);

  let callbackUrl = activeConfig.googleOauthRedirectUri;
  if (!callbackUrl) {
    if (origin && origin !== "*" && activeConfig.corsAllowedOrigins.includes(origin)) {
      callbackUrl = `${origin}/api/restful/oauth2/google/callback`;
    } else {
      callbackUrl = `${activeConfig.apiBaseUrl}/api/restful/oauth2/google/callback`;
    }
  }

  const statePayload: OAuthState = {
    origin,
    redirect,
    callbackUrl,
    timestamp: Date.now(),
  };
  const state = signOAuthState(statePayload, activeConfig.jwtKey);
  const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleAuthUrl.searchParams.set("client_id", activeConfig.googleClientId);
  googleAuthUrl.searchParams.set("redirect_uri", callbackUrl);
  googleAuthUrl.searchParams.set("response_type", "code");
  googleAuthUrl.searchParams.set("scope", "openid email profile");
  googleAuthUrl.searchParams.set("state", state);
  googleAuthUrl.searchParams.set("prompt", "select_account");

  return c.redirect(googleAuthUrl.toString(), 302);
});

oauth2Routes.get("/google/callback", async (c) => {
  const activeConfig = c.get("config") ?? config;
  const stateParam = c.req.query("state");
  const {
    origin: uiOrigin,
    redirect: targetPath,
    callbackUrl: stateCallbackUrl,
  } = parseState(stateParam, activeConfig);
  const callbackUrl =
    stateCallbackUrl ||
    activeConfig.googleOauthRedirectUri ||
    (uiOrigin && uiOrigin !== "*" && activeConfig.corsAllowedOrigins.includes(uiOrigin)
      ? `${uiOrigin}/api/restful/oauth2/google/callback`
      : `${activeConfig.apiBaseUrl}/api/restful/oauth2/google/callback`);
  const error = c.req.query("error");
  if (error) {
    logger.warn(`Google OAuth error received: ${error}`);
    const errorParam =
      error === "access_denied" ? "access_denied" : "oauth_failed";
    return c.redirect(`${uiOrigin}/c/login?error=${errorParam}`, 302);
  }

  const code = c.req.query("code");
  if (!code) {
    logger.warn("Missing authorization code in Google OAuth callback");
    return c.redirect(`${uiOrigin}/c/login?error=oauth_failed`, 302);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: activeConfig.googleClientId,
        client_secret: activeConfig.googleClientSecret,
        redirect_uri: callbackUrl,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      logger.error(
        `Google token exchange failed: ${tokenRes.status} ${errText}`,
      );
      return c.redirect(`${uiOrigin}/c/login?error=oauth_failed`, 302);
    }

    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      logger.error("No access_token returned by Google");
      return c.redirect(`${uiOrigin}/c/login?error=oauth_failed`, 302);
    }

    const userinfoRes = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
    );

    if (!userinfoRes.ok) {
      const errText = await userinfoRes.text();
      logger.error(
        `Google userinfo fetch failed: ${userinfoRes.status} ${errText}`,
      );
      return c.redirect(`${uiOrigin}/c/login?error=oauth_failed`, 302);
    }

    const profile = (await userinfoRes.json()) as {
      email?: string;
      email_verified?: boolean;
      given_name?: string;
      family_name?: string;
      name?: string;
    };

    if (!profile.email || profile.email_verified === false) {
      if (!profile.email) {
        logger.error("Google user profile is missing email address");
      } else {
        logger.warn(
          `Google user email is unverified: email=${profile.email}, email_verified=${profile.email_verified}`,
        );
      }
      return c.redirect(`${uiOrigin}/c/login?error=oauth_failed`, 302);
    }

    const emailLower = profile.email.trim().toLowerCase();
    const existingAccount = await accounts.findByEmail(emailLower);

    // Case A: New user (no existing account) -> create and link
    if (!existingAccount) {
      const account = await accounts.upsertGoogleAccount({
        email: profile.email,
        firstname:
          profile.given_name ||
          profile.name ||
          profile.email.split("@")[0] ||
          "User",
        lastname: profile.family_name || "",
      });

      const jwtToken = await signToken(account.email.toLowerCase(), account.sessionEpoch);
      const base = uiOrigin.endsWith("/") ? uiOrigin.slice(0, -1) : uiOrigin;
      const redirectUrl = new URL(`${base}/c/oauth-callback`);
      redirectUrl.searchParams.set("jwtToken", jwtToken);
      redirectUrl.searchParams.set("email", account.email);
      redirectUrl.searchParams.set("oauthSync", "true");
      redirectUrl.searchParams.set("state", targetPath);
      return c.redirect(redirectUrl.toString(), 302);
    }

    // Case B: Invitee placeholder (password_hash IS NULL) -> upgrade and link
    if (!existingAccount.isRegistered) {
      const account = await accounts.upsertGoogleAccount({
        email: profile.email,
        firstname:
          profile.given_name ||
          profile.name ||
          profile.email.split("@")[0] ||
          "User",
        lastname: profile.family_name || "",
      });

      const jwtToken = await signToken(account.email.toLowerCase(), account.sessionEpoch);
      const base = uiOrigin.endsWith("/") ? uiOrigin.slice(0, -1) : uiOrigin;
      const redirectUrl = new URL(`${base}/c/oauth-callback`);
      redirectUrl.searchParams.set("jwtToken", jwtToken);
      redirectUrl.searchParams.set("email", account.email);
      redirectUrl.searchParams.set("oauthSync", "true");
      redirectUrl.searchParams.set("state", targetPath);
      return c.redirect(redirectUrl.toString(), 302);
    }

    // Case C: Account exists and is already linked to Google
    const isLinked = await accounts.isOAuthLinked(existingAccount.id, "google");
    if (isLinked) {
      if (activeConfig.twoFactorEnabled) {
        const twoFactorStatus = await twoFactorRepo.getStatus(existingAccount.id);
        if (twoFactorStatus.enabled) {
          const challengeToken = await signChallengeToken(existingAccount.email.toLowerCase());
          const base = uiOrigin.endsWith("/") ? uiOrigin.slice(0, -1) : uiOrigin;
          const loginUrl = new URL(`${base}/c/login`);
          loginUrl.searchParams.set("challengeToken", challengeToken);
          loginUrl.searchParams.set("redirect", targetPath);
          return c.redirect(loginUrl.toString(), 302);
        }
      }

      const jwtToken = await signToken(
        existingAccount.email.toLowerCase(),
        existingAccount.sessionEpoch,
      );
      const base = uiOrigin.endsWith("/") ? uiOrigin.slice(0, -1) : uiOrigin;
      const redirectUrl = new URL(`${base}/c/oauth-callback`);
      redirectUrl.searchParams.set("jwtToken", jwtToken);
      redirectUrl.searchParams.set("email", existingAccount.email);
      redirectUrl.searchParams.set("oauthSync", "true");
      redirectUrl.searchParams.set("state", targetPath);
      return c.redirect(redirectUrl.toString(), 302);
    }

    // Case D: Existing registered password account, NOT YET LINKED to Google
    // Issue signed syncCode and redirect to frontend confirmation prompt
    const syncCode = signSyncCode(
      {
        accountId: existingAccount.id,
        email: existingAccount.email.toLowerCase(),
        provider: "google",
        timestamp: Date.now(),
      },
      activeConfig.jwtKey,
    );

    const base = uiOrigin.endsWith("/") ? uiOrigin.slice(0, -1) : uiOrigin;
    const redirectUrl = new URL(`${base}/c/oauth-callback`);
    redirectUrl.searchParams.set("jwtToken", "pending_sync");
    redirectUrl.searchParams.set("email", existingAccount.email);
    redirectUrl.searchParams.set("oauthSync", "false");
    redirectUrl.searchParams.set("syncCode", syncCode);
    redirectUrl.searchParams.set("state", targetPath);
    return c.redirect(redirectUrl.toString(), 302);
  } catch (e) {
    logger.error("Unexpected error during Google OAuth callback:", e);
    return c.redirect(`${uiOrigin}/c/login?error=oauth_failed`, 302);
  }
});
oauth2Routes.put("/confirmaccountsync", async (c) => {
  const activeConfig = c.get("config") ?? config;
  const emailParam = c.req.query("email");
  const codeParam = c.req.query("code");
  const providerParam = (c.req.query("provider") || "google").toLowerCase();

  if (!emailParam || !codeParam) {
    return c.json({ msg: "Email and sync code are required" }, 400);
  }

  const payload = verifySyncCode(codeParam, activeConfig.jwtKey);
  if (!payload) {
    return c.json({ msg: "Invalid or expired confirmation code" }, 400);
  }

  if (payload.email.toLowerCase() !== emailParam.trim().toLowerCase()) {
    return c.json({ msg: "Email does not match confirmation code" }, 400);
  }

  const account = await accounts.findById(payload.accountId);
  if (!account || account.email.toLowerCase() !== payload.email) {
    return c.json({ msg: "Account not found" }, 404);
  }

  // Link provider in account_oauth
  await accounts.linkOAuthProvider(account.id, providerParam, null, account.email);

  // If account was not activated, activate it now
  if (account.activatedAt === null) {
    await accounts.activateAccount(account.id);
  }

  // Check 2FA
  if (activeConfig.twoFactorEnabled) {
    const twoFactorStatus = await twoFactorRepo.getStatus(account.id);
    if (twoFactorStatus.enabled) {
      const challengeToken = await signChallengeToken(account.email.toLowerCase());
      return c.json(
        {
          email: account.email,
          oauthSync: true,
          syncCode: null,
          twoFactorRequired: true,
          challengeToken,
          expiresInSec: 300,
          recoveryAvailable: twoFactorStatus.recoveryCodesRemaining > 0,
        },
        200,
      );
    }
  }

  const jwtToken = await signToken(account.email.toLowerCase(), account.sessionEpoch);
  c.header("Authorization", `Bearer ${jwtToken}`);

  return c.json(
    {
      email: account.email,
      oauthSync: true,
      syncCode: null,
      jwtToken,
    },
    200,
  );
});
