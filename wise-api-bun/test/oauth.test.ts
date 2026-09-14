import { describe, expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import { app } from "../src/app.ts";
import { setConfig, buildConfig, getConfig } from "../src/config.ts";
import * as accounts from "../src/db/repos/accounts.ts";
import { verifyToken } from "../src/util/jwt.ts";
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
        "https://api.test.com/api/restful/oauth2/google/callback",
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("scope")).toBe("openid email profile");
      expect(url.searchParams.get("prompt")).toBe("select_account");

      const stateStr = url.searchParams.get("state");
      expect(stateStr).not.toBeNull();
      const stateObj = JSON.parse(atob(stateStr!));
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
      const url = new URL(res.headers.get("Location")!);
      const stateObj = JSON.parse(atob(url.searchParams.get("state")!));
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
      const url = new URL(res.headers.get("Location")!);
      const stateObj = JSON.parse(atob(url.searchParams.get("state")!));
      expect(stateObj.origin).toBe("https://wisemapping-app.pages.dev");
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
      const url = new URL(res.headers.get("Location")!);
      const stateObj = JSON.parse(atob(url.searchParams.get("state")!));
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
      const url = new URL(res.headers.get("Location")!);
      const stateObj = JSON.parse(atob(url.searchParams.get("state")!));
      expect(stateObj.origin).toBe("https://simpmind.tuanquynet.click");
    });


    test("validates redirect starts with /c/ and falls back to /c/maps/", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?redirect=https://evil.attacker.com",
      );

      expect(res.status).toBe(302);
      const url = new URL(res.headers.get("Location")!);
      const stateObj = JSON.parse(atob(url.searchParams.get("state")!));
      expect(stateObj.redirect).toBe("/c/maps/");
    });

    test("supports state query param as redirect fallback", async () => {
      const res = await app.request(
        "/api/restful/oauth2/google/authorize?state=/c/maps/123",
      );

      expect(res.status).toBe(302);
      const url = new URL(res.headers.get("Location")!);
      const stateObj = JSON.parse(atob(url.searchParams.get("state")!));
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
      };
      const state = btoa(JSON.stringify(stateObj));

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
      };
      const state = btoa(JSON.stringify(stateObj));

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
      };
      const encodedState = btoa(JSON.stringify(stateObj));

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
        "https://api.test.com/api/restful/oauth2/google/callback",
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

      const user = await accounts.findByEmail("existing@example.com");
      expect(user).not.toBeNull();
      expect(user?.activatedAt).not.toBeNull();
      const hash = await accounts.passwordHashOf(user!.id);
      expect(hash).toBe("BCRYPT_HASH_12345");
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
  });
});
