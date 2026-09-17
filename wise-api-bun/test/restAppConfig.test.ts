import { describe, expect, test } from "bun:test";

import { buildConfig } from "../src/config.ts";
import { buildAppConfig } from "../src/http/dto/restAppConfig.ts";

/**
 * Task 1.3: `buildAppConfig` must take `Config` as an explicit parameter
 * instead of reading the Bun-only `config.bun.ts` singleton, so the
 * Cloudflare Workers skeleton (`workers.ts`) can serve `GET
 * /api/restful/app/config` -- built from `buildConfig(c.env)` -- without
 * ever importing a Bun-specific module.
 */

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");

describe("buildAppConfig", () => {
  test("reflects the Config instance it is given, not any ambient singleton", () => {
    const config = buildConfig({
      JWT_SECRET: VALID_JWT_SECRET,
      API_BASE_URL: "https://distinctly-different-example.test",
      UI_BASE_URL: "https://distinctly-different-ui.test",
      REGISTRATION_ENABLED: "false",
      CAPTCHA_ENABLED: "true",
      JWT_EXPIRATION_MIN: "42",
    });

    const result = buildAppConfig(config);

    expect(result.apiBaseUrl).toBe("https://distinctly-different-example.test");
    expect(result.uiBaseUrl).toBe("https://distinctly-different-ui.test");
    expect(result.registrationEnabled).toBe(false);
    expect(result.recaptcha2Enabled).toBe(true);
    expect(result.jwtExpirationMin).toBe(42);
  });

  test("Google OAuth2 is disabled and URL is absent when not configured", () => {
    const config = buildConfig({ JWT_SECRET: VALID_JWT_SECRET });
    const result = buildAppConfig(config);

    expect(result.googleOauth2Enabled).toBe(false);
    expect(result.facebookOauth2Enabled).toBe(false);
    expect("googleOauth2Url" in result).toBe(false);
    expect("facebookOauth2Url" in result).toBe(false);
    expect(result.twoFactorEnabled).toBe(false);
  });

  test("Google OAuth2 is enabled and includes authorize URL when configured", () => {
    const config = buildConfig({
      JWT_SECRET: VALID_JWT_SECRET,
      API_BASE_URL: "https://api.wisemapping.test",
      GOOGLE_CLIENT_ID: "google-client-id-123",
      GOOGLE_CLIENT_SECRET: "google-client-secret-xyz",
    });
    const result = buildAppConfig(config);

    expect(result.googleOauth2Enabled).toBe(true);
    expect(result.googleOauth2Url).toBe(
      "https://api.wisemapping.test/api/restful/oauth2/google/authorize",
    );
  });

  test("Google OAuth2 is disabled if googleOauthEnabled is false despite client id being set", () => {
    const config = buildConfig({
      JWT_SECRET: VALID_JWT_SECRET,
      GOOGLE_CLIENT_ID: "google-client-id-123",
      GOOGLE_CLIENT_SECRET: "google-client-secret-xyz",
      GOOGLE_OAUTH_ENABLED: "false",
    });
    const result = buildAppConfig(config);

    expect(result.googleOauth2Enabled).toBe(false);
    expect("googleOauth2Url" in result).toBe(false);
  });

  test("Google OAuth2 is disabled if googleClientId is empty despite googleOauthEnabled being true", () => {
    const config = buildConfig({
      JWT_SECRET: VALID_JWT_SECRET,
      GOOGLE_OAUTH_ENABLED: "true",
    });
    const result = buildAppConfig(config);

    expect(result.googleOauth2Enabled).toBe(false);
    expect("googleOauth2Url" in result).toBe(false);
  });

  test("omits recaptcha2SiteKey and analyticsAccount when unset (@JsonInclude(NON_NULL))", () => {
    const config = buildConfig({ JWT_SECRET: VALID_JWT_SECRET });
    const result = buildAppConfig(config);

    expect("recaptcha2SiteKey" in result).toBe(false);
    expect("analyticsAccount" in result).toBe(false);
  });

  test("includes recaptcha2SiteKey and analyticsAccount when set", () => {
    const config = buildConfig({
      JWT_SECRET: VALID_JWT_SECRET,
      CAPTCHA_SITE_KEY: "site-key-123",
      ANALYTICS_ACCOUNT: "G-ABC123",
    });
    const result = buildAppConfig(config);

    expect(result.recaptcha2SiteKey).toBe("site-key-123");
    expect(result.analyticsAccount).toBe("G-ABC123");
  });

  test("twoFactorEnabled is true when enabled in config", () => {
    const validKey = Buffer.from("k".repeat(32)).toString("base64");
    const config = buildConfig({
      JWT_SECRET: VALID_JWT_SECRET,
      TWO_FACTOR_ENABLED: "true",
      TWO_FACTOR_SECRET_KEY: validKey,
    });
    const result = buildAppConfig(config);
    expect(result.twoFactorEnabled).toBe(true);
  });
});
