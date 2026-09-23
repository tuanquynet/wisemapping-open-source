import { describe, expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import { app } from "../src/app.ts";
import { setConfig, buildConfig, getConfig } from "../src/config.ts";
import * as accounts from "../src/db/repos/accounts.ts";
import { dbAdapter } from "../src/db/client.ts";
import { signOAuthState, signSyncCode, verifySyncCode, type OAuthState } from "../src/http/routes/oauth2.ts";
import { verifyToken } from "../src/util/jwt.ts";
import { bunPasswordHasher } from "../src/util/passwordHash.ts";
import { resetDb } from "./helpers/db.ts";
const VALID_JWT_SECRET = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OQ==";

describe("OAuth2 routes", () => {
  const initialConfig = getConfig();
  const originalFetch = globalThis.fetch;

  function mockFetch(
    fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  ) {
    globalThis.fetch = fn as unknown as typeof fetch;
  }
  function createTestConfig(overrides: Record<string, string | undefined> = {}) {
    return buildConfig({
      JWT_SECRET: VALID_JWT_SECRET,
      GOOGLE_OAUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      API_BASE_URL: "https://api.test.com",
      UI_BASE_URL: "https://simpmind.tuanquynet.click",
      CORS_ALLOWED_ORIGINS: "https://simpmind.tuanquynet.click,https://wisemapping-app.pages.dev",
      ...overrides,
    });
  }

  function parseAuthorizeState(location: string): {
    payload: OAuthState;
    signature: string;
    rawState: string;
  } {
    const url = new URL(location);
    const rawState = url.searchParams.get("state")!;
    const [base64Payload, signature] = rawState.split(".");
    return {
      payload: JSON.parse(atob(base64Payload!)),
      signature: signature ?? "",
      rawState,
    };
  }

  beforeEach(async () => {
    resetDb();
    setConfig(createTestConfig());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    setConfig(initialConfig);
    globalThis.fetch = originalFetch;
  });

  describe("GET /api/restful/oauth2/google/authorize", () => {
    test("redirects (302) to Google consent URL with correct query parameters", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?redirect=/c/maps/",
      );

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") || "";
      expect(location).toContain("https://accounts.google.com/o/oauth2/v2/auth");

      const url = new URL(location);
      expect(url.searchParams.get("client_id")).toBe(
        "test-client-id.apps.googleusercontent.com",
      );
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://simpmind.tuanquynet.click/api/restful/oauth2/google/callback",
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("scope")).toBe("openid email profile");
      expect(url.searchParams.get("prompt")).toBe("select_account");

      const { payload: stateObj, signature, rawState } = parseAuthorizeState(location);
      expect(rawState).not.toBeNull();
      expect(signature).toBeDefined();
      expect(signature.length).toBe(64);
      expect(stateObj.origin).toBe("https://simpmind.tuanquynet.click");
      expect(stateObj.redirect).toBe("/c/maps/");
      expect(typeof stateObj.timestamp).toBe("number");
    });

    test("uses origin from Origin header when in corsAllowedOrigins", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?redirect=/c/maps/",
        {
          headers: {
            Origin: "https://wisemapping-app.pages.dev",
          },
        },
      );

      expect(res.status).toBe(302);
      const { payload: stateObj } = parseAuthorizeState(res.headers.get("Location")!);
      expect(stateObj.origin).toBe("https://wisemapping-app.pages.dev");
    });

    test("uses origin from Referer header when in corsAllowedOrigins", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?redirect=/c/maps/",
        {
          headers: {
            Referer: "https://wisemapping-app.pages.dev/c/login",
          },
        },
      );

      expect(res.status).toBe(302);
      const { payload: stateObj } = parseAuthorizeState(res.headers.get("Location")!);
      expect(stateObj.origin).toBe("https://wisemapping-app.pages.dev");
    });
    test("uses origin from origin query parameter when in corsAllowedOrigins", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?redirect=/c/maps/&origin=https://wisemapping-app.pages.dev",
      );

      expect(res.status).toBe(302);
      const { payload: stateObj } = parseAuthorizeState(res.headers.get("Location")!);
      expect(stateObj.origin).toBe("https://wisemapping-app.pages.dev");
    });

    test("normalizes full URL in origin query parameter to origin only", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?redirect=/c/maps/&origin=https://wisemapping-app.pages.dev/c/login",
      );

      expect(res.status).toBe(302);
      const { payload: stateObj } = parseAuthorizeState(res.headers.get("Location")!);
      expect(stateObj.origin).toBe("https://wisemapping-app.pages.dev");
    });

    test("falls back to uiBaseUrl when origin query parameter is untrusted", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?redirect=/c/maps/&origin=https://evil.attacker.com",
      );

      expect(res.status).toBe(302);
      const { payload: stateObj } = parseAuthorizeState(res.headers.get("Location")!);
      expect(stateObj.origin).toBe("https://simpmind.tuanquynet.click");
    });

    test("falls back to uiBaseUrl when Origin/Referer is not allowed", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?redirect=/c/maps/",
        {
          headers: {
            Origin: "https://evil.attacker.com",
          },
        },
      );

      expect(res.status).toBe(302);
      const { payload: stateObj } = parseAuthorizeState(res.headers.get("Location")!);
      expect(stateObj.origin).toBe("https://simpmind.tuanquynet.click");
    });
    test("falls back to uiBaseUrl when corsAllowedOrigins contains '*' and origin is untrusted", async () => {
      setConfig(
        createTestConfig({
          CORS_ALLOWED_ORIGINS: "*,https://wisemapping-app.pages.dev",
        }),
      );

      const res = await app.request(
        "/api/restful/oauth2/google/authorize?redirect=/c/maps/",
        {
          headers: {
            Origin: "https://evil.attacker.com",
          },
        },
      );

      expect(res.status).toBe(302);
      const { payload: stateObj } = parseAuthorizeState(res.headers.get("Location")!);
      expect(stateObj.origin).toBe("https://simpmind.tuanquynet.click");
    });


    test("validates redirect starts with /c/ and falls back to /c/maps/", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?redirect=https://evil.attacker.com",
      );

      expect(res.status).toBe(302);
      const { payload: stateObj } = parseAuthorizeState(res.headers.get("Location")!);
      expect(stateObj.redirect).toBe("/c/maps/");
    });

    test("supports state query param as redirect fallback", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?state=/c/maps/123",
      );

      expect(res.status).toBe(302);
      const { payload: stateObj } = parseAuthorizeState(res.headers.get("Location")!);
      expect(stateObj.redirect).toBe("/c/maps/123");
    });

    test("returns 404 when google oauth is disabled", async () => {
      setConfig(
        createTestConfig({
          GOOGLE_OAUTH_ENABLED: "false",
        }),
      );

      const res = await app.request("/api/restful/oauth2/google/authorize");
      expect(res.status).toBe(404);
    });

    test("returns 404 when googleClientId is empty", async () => {
      setConfig(
        createTestConfig({
          GOOGLE_CLIENT_ID: "",
          GOOGLE_SSO_CLIENT_ID: "",
        }),
      );

      const res = await app.request("/api/restful/oauth2/google/authorize");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/restful/oauth2/google/callback", () => {
    test("handles user cancellation (error=access_denied) with redirect to login", async () => {
      const stateObj = {
        origin: "https://simpmind.tuanquynet.click",
        redirect: "/c/maps/",
        timestamp: Date.now(),
      };
      const state = signOAuthState(stateObj, getConfig().jwtKey);

      const res = await app.request(
        `/api/restful/oauth2/google/callback?error=access_denied&state=${state}`,
      );

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") || "";
      expect(location).toBe(
        "https://simpmind.tuanquynet.click/c/login?error=access_denied",
      );
    });

    test("falls back to uiBaseUrl on callback when state origin is untrusted even if corsAllowedOrigins contains '*'", async () => {
      setConfig(
        createTestConfig({
          CORS_ALLOWED_ORIGINS: "*",
        }),
      );

      const stateObj = {
        origin: "https://evil.attacker.com",
        redirect: "/c/maps/",
        timestamp: Date.now(),
      };
      const state = signOAuthState(stateObj, getConfig().jwtKey);

      const res = await app.request(
        `/api/restful/oauth2/google/callback?error=access_denied&state=${state}`,
      );

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") || "";
      expect(location).toBe(
        "https://simpmind.tuanquynet.click/c/login?error=access_denied",
      );
    });

    test("handles other oauth error with redirect to login?error=oauth_failed", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/callback?error=server_error",
      );

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") || "";
      expect(location).toBe(
        "https://simpmind.tuanquynet.click/c/login?error=oauth_failed",
      );
    });

    test("handles missing authorization code with redirect to login?error=oauth_failed", async () => {
      const res = await app.request("/api/restful/oauth2/google/callback");

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") || "";
      expect(location).toBe(
        "https://simpmind.tuanquynet.click/c/login?error=oauth_failed",
      );
    });

    test("successfully exchanges code, upserts user, signs JWT, and redirects to /c/oauth-callback", async () => {
      let tokenRequestBody: string | null = null;
      let userinfoAuthHeader = null as string | null;

      mockFetch(async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          tokenRequestBody = init?.body as string;
          return new Response(
            JSON.stringify({
              access_token: "mock-google-token-xyz",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
          const headers = init?.headers as Record<string, string> | undefined;
          userinfoAuthHeader = headers?.Authorization ?? null;
          return new Response(
            JSON.stringify({
              sub: "google-sub-12345",
              email: "test.oauth.user@gmail.com",
              email_verified: true,
              given_name: "Test",
              family_name: "User",
              picture: "https://lh3.googleusercontent.com/a/photo",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const stateObj = {
        origin: "https://simpmind.tuanquynet.click",
        redirect: "/c/maps/42",
        timestamp: Date.now(),
      };
      const encodedState = signOAuthState(stateObj, getConfig().jwtKey);

      const res = await app.request(
        `/api/restful/oauth2/google/callback?code=mock-auth-code&state=${encodedState}`,
      );

      expect(res.status).toBe(302);
      const location = res.headers.get("Location") || "";
      expect(location).toContain(
        "https://simpmind.tuanquynet.click/c/oauth-callback",
      );

      // Verify token request parameters
      expect(tokenRequestBody).not.toBeNull();
      const params = new URLSearchParams(tokenRequestBody!);
      expect(params.get("code")).toBe("mock-auth-code");
      expect(params.get("client_id")).toBe(
        "test-client-id.apps.googleusercontent.com",
      );
      expect(params.get("client_secret")).toBe("test-client-secret");
      expect(params.get("redirect_uri")).toBe(
        "https://simpmind.tuanquynet.click/api/restful/oauth2/google/callback",
      );
      expect(params.get("grant_type")).toBe("authorization_code");

      // Verify userinfo request
      expect(userinfoAuthHeader as string | null).toBe("Bearer mock-google-token-xyz");

      // Verify callback redirect URL params
      const callbackUrl = new URL(location);
      const jwtToken = callbackUrl.searchParams.get("jwtToken");
      expect(jwtToken).not.toBeNull();
      expect(callbackUrl.searchParams.get("email")).toBe(
        "test.oauth.user@gmail.com",
      );
      expect(callbackUrl.searchParams.get("oauthSync")).toBe("true");
      expect(callbackUrl.searchParams.get("state")).toBe("/c/maps/42");

      // Verify JWT is valid and signed for this email
      const claims = await verifyToken(jwtToken!);
      expect(claims).not.toBeNull();
      expect(claims?.sub).toBe("test.oauth.user@gmail.com");

      // Verify account was created in database
      const user = await accounts.findByEmail("test.oauth.user@gmail.com");
      expect(user).not.toBeNull();
      expect(user?.email).toBe("test.oauth.user@gmail.com");
      expect(user?.firstname).toBe("Test");
      expect(user?.lastname).toBe("User");
      expect(user?.isRegistered).toBe(true);
      expect(user?.activatedAt).not.toBeNull();
    });

    test("auto-links existing password user without overwriting password hash", async () => {
      // Create user first with a known password hash and unactivated
      await accounts.createOrUpgrade({
        email: "existing@example.com",
        firstname: "Existing",
        lastname: "Person",
        passwordHash: "BCRYPT_HASH_12345",
        locale: null,
        activationCode: null,
        activatedAt: null,
      });

      mockFetch(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "mock-token" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
          return new Response(
            JSON.stringify({
              email: "existing@example.com",
              given_name: "NewName",
              family_name: "NewLast",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const res = await app.request(
        "/api/restful/oauth2/google/callback?code=mock-code",
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      const callbackUrl = new URL(location);
      expect(callbackUrl.searchParams.get("oauthSync")).toBe("false");
      const syncCode = callbackUrl.searchParams.get("syncCode");
      expect(syncCode).not.toBeNull();
      expect(callbackUrl.searchParams.get("email")).toBe("existing@example.com");

      // Before confirmation, user is not yet activated and not linked
      let user = await accounts.findByEmail("existing@example.com");
      expect(user?.activatedAt).toBeNull();
      expect(await accounts.isOAuthLinked(user!.id, "google")).toBe(false);

      // Confirm account sync
      const confirmRes = await app.request(
        `/api/restful/oauth2/confirmaccountsync?email=existing@example.com&code=${encodeURIComponent(syncCode!)}&provider=google`,
        { method: "PUT" },
      );
      expect(confirmRes.status).toBe(200);
      const confirmBody = (await confirmRes.json()) as {
        email: string;
        oauthSync: boolean;
        jwtToken: string;
      };
      expect(confirmBody.oauthSync).toBe(true);
      expect(confirmBody.email).toBe("existing@example.com");
      expect(confirmBody.jwtToken).toBeDefined();

      // Account is now activated, password hash is preserved, and Google is linked
      user = await accounts.findByEmail("existing@example.com");
      expect(user).not.toBeNull();
      expect(user?.activatedAt).not.toBeNull();
      const hash = await accounts.passwordHashOf(user!.id);
      expect(hash).toBe("BCRYPT_HASH_12345");
      expect(await accounts.isOAuthLinked(user!.id, "google")).toBe(true);

      // Subsequent Google login immediately succeeds with oauthSync=true
      const nextRes = await app.request(
        "/api/restful/oauth2/google/callback?code=mock-code",
      );
      expect(nextRes.status).toBe(302);
      const nextUrl = new URL(nextRes.headers.get("Location")!);
      expect(nextUrl.searchParams.get("oauthSync")).toBe("true");
      expect(nextUrl.searchParams.get("email")).toBe("existing@example.com");
      expect(nextUrl.searchParams.get("jwtToken")).not.toBe("pending_sync");
    });
    test("handles failed token exchange with redirect to login?error=oauth_failed", async () => {
      mockFetch(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response("Invalid client secret", { status: 401 });
        }
        return new Response("Not found", { status: 404 });
      });

      const res = await app.request(
        "/api/restful/oauth2/google/callback?code=bad-code",
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://simpmind.tuanquynet.click/c/login?error=oauth_failed",
      );
    });

    test("handles missing access_token in token response", async () => {
      mockFetch(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({}), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const res = await app.request(
        "/api/restful/oauth2/google/callback?code=bad-code",
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://simpmind.tuanquynet.click/c/login?error=oauth_failed",
      );
    });

    test("handles failed userinfo fetch with redirect to login?error=oauth_failed", async () => {
      mockFetch(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "mock-token" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response("Not found", { status: 404 });
      });

      const res = await app.request(
        "/api/restful/oauth2/google/callback?code=valid-code",
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://simpmind.tuanquynet.click/c/login?error=oauth_failed",
      );
    });

    test("handles userinfo response missing email address", async () => {
      mockFetch(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "mock-token" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
          return new Response(
            JSON.stringify({ name: "Anonymous" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const res = await app.request(
        "/api/restful/oauth2/google/callback?code=valid-code",
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://simpmind.tuanquynet.click/c/login?error=oauth_failed",
      );
    });

    test("falls back to uiBaseUrl and /c/maps/ on invalid state string", async () => {
      mockFetch(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "mock-token" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
          return new Response(
            JSON.stringify({ email: "fallback.user@example.com" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const res = await app.request(
        "/api/restful/oauth2/google/callback?code=mock-code&state=not-valid-base64",
      );

      expect(res.status).toBe(302);
      const callbackUrl = new URL(res.headers.get("Location")!);
      expect(callbackUrl.origin).toBe("https://simpmind.tuanquynet.click");
      expect(callbackUrl.searchParams.get("state")).toBe("/c/maps/");
    });

    test("rejects when email_verified is false with redirect to login?error=oauth_failed", async () => {
      mockFetch(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "mock-token" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
          return new Response(
            JSON.stringify({
              email: "unverified@example.com",
              email_verified: false,
              given_name: "Unverified",
              family_name: "User",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const state = signOAuthState(
        {
          origin: "https://simpmind.tuanquynet.click",
          redirect: "/c/maps/",
          timestamp: Date.now(),
        },
        getConfig().jwtKey,
      );

      const res = await app.request(
        `/api/restful/oauth2/google/callback?code=mock-code&state=${state}`,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://simpmind.tuanquynet.click/c/login?error=oauth_failed",
      );

      const account = await accounts.findByEmail("unverified@example.com");
      expect(account).toBeNull();
    });

    test("falls back to uiBaseUrl and /c/maps/ when state HMAC signature is tampered or forged", async () => {
      mockFetch(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({ access_token: "mock-token" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
          return new Response(
            JSON.stringify({
              email: "statetest@example.com",
              email_verified: true,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      // 1. Missing signature completely
      const rawPayload = btoa(
        JSON.stringify({
          origin: "https://wisemapping-app.pages.dev",
          redirect: "/c/maps/secret",
          timestamp: Date.now(),
        }),
      );
      const resNoSig = await app.request(
        `/api/restful/oauth2/google/callback?code=mock-code&state=${rawPayload}`,
      );
      expect(resNoSig.status).toBe(302);
      const urlNoSig = new URL(resNoSig.headers.get("Location")!);
      expect(urlNoSig.origin).toBe("https://simpmind.tuanquynet.click");
      expect(urlNoSig.searchParams.get("state")).toBe("/c/maps/");

      // 2. Tampered signature
      const validState = signOAuthState(
        {
          origin: "https://wisemapping-app.pages.dev",
          redirect: "/c/maps/secret",
          timestamp: Date.now(),
        },
        getConfig().jwtKey,
      );
      const tamperedState = validState.slice(0, -4) + "beef";
      const resTampered = await app.request(
        `/api/restful/oauth2/google/callback?code=mock-code&state=${tamperedState}`,
      );
      expect(resTampered.status).toBe(302);
      const urlTampered = new URL(resTampered.headers.get("Location")!);
      expect(urlTampered.origin).toBe("https://simpmind.tuanquynet.click");
      expect(urlTampered.searchParams.get("state")).toBe("/c/maps/");

      // 3. Forged signature using different key
      const forgedKey = new Uint8Array(32).fill(42);
      const forgedState = signOAuthState(
        {
          origin: "https://wisemapping-app.pages.dev",
          redirect: "/c/maps/secret",
          timestamp: Date.now(),
        },
        forgedKey,
      );
      const resForged = await app.request(
        `/api/restful/oauth2/google/callback?code=mock-code&state=${forgedState}`,
      );
      expect(resForged.status).toBe(302);
      const urlForged = new URL(resForged.headers.get("Location")!);
      expect(urlForged.origin).toBe("https://simpmind.tuanquynet.click");
      expect(urlForged.searchParams.get("state")).toBe("/c/maps/");
    });
  });

  describe("Sync Code generation & verification", () => {
    test("signs and verifies sync code successfully", () => {
      const payload = {
        accountId: 42,
        email: "syncuser@example.com",
        provider: "google",
        timestamp: Date.now(),
      };
      const code = signSyncCode(payload, getConfig().jwtKey);
      const verified = verifySyncCode(code, getConfig().jwtKey);
      expect(verified).not.toBeNull();
      expect(verified?.accountId).toBe(42);
      expect(verified?.email).toBe("syncuser@example.com");
      expect(verified?.provider).toBe("google");
    });

    test("rejects tampered signature", () => {
      const payload = {
        accountId: 42,
        email: "syncuser@example.com",
        provider: "google",
        timestamp: Date.now(),
      };
      const code = signSyncCode(payload, getConfig().jwtKey);
      const tampered = code.slice(0, -4) + "dead";
      expect(verifySyncCode(tampered, getConfig().jwtKey)).toBeNull();
    });

    test("rejects expired sync code", () => {
      const payload = {
        accountId: 42,
        email: "syncuser@example.com",
        provider: "google",
        timestamp: Date.now() - 20 * 60 * 1000, // 20 mins ago
      };
      const code = signSyncCode(payload, getConfig().jwtKey);
      expect(verifySyncCode(code, getConfig().jwtKey)).toBeNull();
    });
  });

  describe("PUT /api/restful/oauth2/confirmaccountsync", () => {
    test("returns 400 when email or code is missing", async () => {
      const res1 = await app.request("/api/restful/oauth2/confirmaccountsync", {
        method: "PUT",
      });
      expect(res1.status).toBe(400);

      const res2 = await app.request("/api/restful/oauth2/confirmaccountsync?email=user@test.com", {
        method: "PUT",
      });
      expect(res2.status).toBe(400);
    });

    test("returns 400 when sync code is invalid or expired", async () => {
      const res = await app.request(
        "/api/restful/oauth2/confirmaccountsync?email=user@test.com&code=badcode",
        { method: "PUT" },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { msg: string };
      expect(body.msg).toContain("Invalid or expired");
    });

    test("returns 400 when email does not match sync code payload", async () => {
      const code = signSyncCode(
        {
          accountId: 99,
          email: "correct@example.com",
          provider: "google",
          timestamp: Date.now(),
        },
        getConfig().jwtKey,
      );

      const res = await app.request(
        `/api/restful/oauth2/confirmaccountsync?email=wrong@example.com&code=${encodeURIComponent(code)}`,
        { method: "PUT" },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { msg: string };
      expect(body.msg).toContain("Email does not match");
    });

    test("returns 404 when account does not exist", async () => {
      const code = signSyncCode(
        {
          accountId: 99999,
          email: "ghost@example.com",
          provider: "google",
          timestamp: Date.now(),
        },
        getConfig().jwtKey,
      );

      const res = await app.request(
        `/api/restful/oauth2/confirmaccountsync?email=ghost@example.com&code=${encodeURIComponent(code)}`,
        { method: "PUT" },
      );
      expect(res.status).toBe(404);
    });

    test("successfully links provider, activates unactivated user, and issues valid JWT", async () => {
      const user = await accounts.createOrUpgrade({
        email: "unactivated@example.com",
        firstname: "Un",
        lastname: "Activated",
        passwordHash: "HASH_SECRET",
        locale: "en",
        activationCode: null,
        activatedAt: null,
      });

      const code = signSyncCode(
        {
          accountId: user.id,
          email: "unactivated@example.com",
          provider: "google",
          timestamp: Date.now(),
        },
        getConfig().jwtKey,
      );

      const res = await app.request(
        `/api/restful/oauth2/confirmaccountsync?email=unactivated@example.com&code=${encodeURIComponent(code)}`,
        { method: "PUT" },
      );
      expect(res.status).toBe(200);
      const authHeader = res.headers.get("Authorization");
      expect(authHeader).toContain("Bearer ");

      const body = (await res.json()) as {
        email: string;
        oauthSync: boolean;
        jwtToken: string;
      };
      expect(body.oauthSync).toBe(true);
      expect(body.email).toBe("unactivated@example.com");
      expect(body.jwtToken).toBeDefined();

      const claims = await verifyToken(body.jwtToken);
      expect(claims?.sub).toBe("unactivated@example.com");

      // Verify DB state
      const updated = await accounts.findById(user.id);
      expect(updated?.activatedAt).not.toBeNull();
      expect(await accounts.isOAuthLinked(user.id, "google")).toBe(true);
      expect(await accounts.passwordHashOf(user.id)).toBe("HASH_SECRET");
    });
  });

  describe("Dual sign-in & 2FA with SSO", () => {
    test("user can log in via password AND via linked Google SSO", async () => {
      const password = "ValidPassword123!";
      const hash = await bunPasswordHasher.hash(password);
      const user = await accounts.createOrUpgrade({
        email: "dual@example.com",
        firstname: "Dual",
        lastname: "User",
        passwordHash: hash,
        locale: "en",
        activationCode: null,
        activatedAt: Date.now(),
      });

      // 1. Log in via standard password authentication
      const passwordRes = await app.request("/api/restful/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "dual@example.com",
          password,
        }),
      });
      expect(passwordRes.status).toBe(200);
      const passwordJwt = await passwordRes.text();
      expect(passwordJwt).not.toBe("");

      // 2. Link Google account via sync code
      const code = signSyncCode(
        {
          accountId: user.id,
          email: "dual@example.com",
          provider: "google",
          timestamp: Date.now(),
        },
        getConfig().jwtKey,
      );
      const confirmRes = await app.request(
        `/api/restful/oauth2/confirmaccountsync?email=dual@example.com&code=${encodeURIComponent(code)}`,
        { method: "PUT" },
      );
      expect(confirmRes.status).toBe(200);

      // 3. User can still log in via password
      const passwordRes2 = await app.request("/api/restful/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "dual@example.com",
          password,
        }),
      });
      expect(passwordRes2.status).toBe(200);

      // 4. User can also log in via Google SSO callback directly
      mockFetch(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "mock-token" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
          return new Response(
            JSON.stringify({
              email: "dual@example.com",
              email_verified: true,
              given_name: "Dual",
              family_name: "User",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const ssoRes = await app.request(
        "/api/restful/oauth2/google/callback?code=mock-code",
      );
      expect(ssoRes.status).toBe(302);
      const ssoLocation = ssoRes.headers.get("Location")!;
      const ssoUrl = new URL(ssoLocation);
      expect(ssoUrl.searchParams.get("oauthSync")).toBe("true");
      expect(ssoUrl.searchParams.get("email")).toBe("dual@example.com");
      expect(ssoUrl.searchParams.get("jwtToken")).not.toBe("pending_sync");
    });

    test("enforces 2FA challenge when linked account has 2FA enabled", async () => {
      // Enable 2FA feature flag in config
      setConfig(
        buildConfig({
          JWT_SECRET: VALID_JWT_SECRET,
          GOOGLE_OAUTH_ENABLED: "true",
          GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-client-secret",
          API_BASE_URL: "https://api.test.com",
          UI_BASE_URL: "https://simpmind.tuanquynet.click",
          CORS_ALLOWED_ORIGINS: "https://simpmind.tuanquynet.click",
          TWO_FACTOR_ENABLED: "true",
          TWO_FACTOR_SECRET_KEY: Buffer.from("01234567890123456789012345678901").toString("base64"),
        }),
      );

      const user = await accounts.createOrUpgrade({
        email: "twofactor@example.com",
        firstname: "Two",
        lastname: "Factor",
        passwordHash: "HASH_2FA",
        locale: "en",
        activationCode: null,
        activatedAt: Date.now(),
      });

      // Enable 2FA on account in DB
      await dbAdapter.run(
        `INSERT INTO account_totp (account_id, secret_cipher, status, created_at, activated_at)
         VALUES (?, 'v1$secret$cipher', 'active', ?, ?)`,
        [user.id, Date.now(), Date.now()],
      );

      // Confirm linking returns 2FA challenge
      const code = signSyncCode(
        {
          accountId: user.id,
          email: "twofactor@example.com",
          provider: "google",
          timestamp: Date.now(),
        },
        getConfig().jwtKey,
      );

      const confirmRes = await app.request(
        `/api/restful/oauth2/confirmaccountsync?email=twofactor@example.com&code=${encodeURIComponent(code)}`,
        { method: "PUT" },
      );
      expect(confirmRes.status).toBe(200);
      const confirmBody = (await confirmRes.json()) as {
        twoFactorRequired?: boolean;
        challengeToken?: string;
      };
      expect(confirmBody.twoFactorRequired).toBe(true);
      expect(confirmBody.challengeToken).toBeDefined();

      // Subsequent Google login redirects to login with challengeToken
      mockFetch(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "mock-token" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
          return new Response(
            JSON.stringify({
              email: "twofactor@example.com",
              email_verified: true,
              given_name: "Two",
              family_name: "Factor",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      });
      const state = signOAuthState(
        {
          origin: "https://simpmind.tuanquynet.click",
          redirect: "/c/maps/secret",
          timestamp: Date.now(),
        },
        getConfig().jwtKey,
      );
      const ssoRes = await app.request(
        `/api/restful/oauth2/google/callback?code=mock-code&state=${encodeURIComponent(state)}`,
      );
      expect(ssoRes.status).toBe(302);
      const ssoUrl = new URL(ssoRes.headers.get("Location")!);
      expect(ssoUrl.pathname).toBe("/c/login");
      expect(ssoUrl.searchParams.get("challengeToken")).not.toBeNull();
      expect(ssoUrl.searchParams.get("redirect")).toBe("/c/maps/secret");
    });
  });
});
