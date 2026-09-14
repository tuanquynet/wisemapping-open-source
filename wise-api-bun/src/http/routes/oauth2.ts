import { Hono } from "hono";

import { config, type Config } from "../../config.ts";
import * as accounts from "../../db/repos/accounts.ts";
import { signToken } from "../../util/jwt.ts";
import { logger } from "../../util/logger.ts";
import type { Env } from "../env.ts";

export const oauth2Routes = new Hono<Env>();

interface OAuthState {
  origin: string;
  redirect: string;
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

function parseState(
  stateParam: string | undefined,
  appConfig: Config,
): { origin: string; redirect: string } {
  if (!stateParam) {
    return { origin: appConfig.uiBaseUrl, redirect: "/c/maps/" };
  }
  try {
    const decoded = JSON.parse(atob(stateParam)) as Partial<OAuthState>;
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
    return { origin, redirect };
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

  const reqOriginHeader = c.req.header("Origin") || c.req.header("Referer");
  let candidateOrigin: string | undefined;
  if (reqOriginHeader) {
    try {
      candidateOrigin = new URL(reqOriginHeader).origin;
    } catch {
      candidateOrigin = reqOriginHeader;
    }
  }
  const origin = resolveSafeOrigin(candidateOrigin, activeConfig);

  const statePayload: OAuthState = {
    origin,
    redirect,
    timestamp: Date.now(),
  };
  const state = btoa(JSON.stringify(statePayload));

  const callbackUrl = `${activeConfig.apiBaseUrl}/api/restful/oauth2/google/callback`;
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
  const { origin: uiOrigin, redirect: targetPath } = parseState(
    stateParam,
    activeConfig,
  );

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
    const callbackUrl = `${activeConfig.apiBaseUrl}/api/restful/oauth2/google/callback`;
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

    if (!profile.email) {
      logger.error("Google user profile is missing email address");
      return c.redirect(`${uiOrigin}/c/login?error=oauth_failed`, 302);
    }

    const account = await accounts.upsertGoogleAccount({
      email: profile.email,
      firstname:
        profile.given_name ||
        profile.name ||
        profile.email.split("@")[0] ||
        "User",
      lastname: profile.family_name || "",
    });

    const jwtToken = await signToken(account.email.toLowerCase());

    const base = uiOrigin.endsWith("/") ? uiOrigin.slice(0, -1) : uiOrigin;
    const redirectUrl = new URL(`${base}/c/oauth-callback`);
    redirectUrl.searchParams.set("jwtToken", jwtToken);
    redirectUrl.searchParams.set("email", account.email);
    redirectUrl.searchParams.set("oauthSync", "true");
    redirectUrl.searchParams.set("state", targetPath);

    return c.redirect(redirectUrl.toString(), 302);
  } catch (e) {
    logger.error("Unexpected error during Google OAuth callback:", e);
    return c.redirect(`${uiOrigin}/c/login?error=oauth_failed`, 302);
  }
});
