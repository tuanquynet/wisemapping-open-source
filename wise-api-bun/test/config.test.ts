import { describe, expect, test } from "bun:test";

import { buildConfig, ConfigError } from "../src/config.ts";

/**
 * Task 1.2: `buildConfig` replaces a module-level singleton built from
 * `Bun.env` at import time with a pure factory over an explicit env record.
 * That is what makes it independently testable at all -- the old design
 * could only ever be exercised once per process, against whatever `.env`
 * happened to be loaded before any test file ran.
 */

// Decodes to exactly 32 bytes -- the minimum `JWT_SECRET` this validator accepts.
const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return { JWT_SECRET: VALID_JWT_SECRET, ...overrides };
}

describe("buildConfig", () => {
  test("throws ConfigError when JWT_SECRET is missing", () => {
    expect(() => buildConfig({})).toThrow(ConfigError);
  });

  test("throws ConfigError when JWT_SECRET decodes to fewer than 32 bytes", () => {
    const shortSecret = Buffer.from("too-short").toString("base64");
    expect(() => buildConfig(baseEnv({ JWT_SECRET: shortSecret }))).toThrow(
      ConfigError,
    );
  });

  test("aggregates every problem into one thrown error", () => {
    let error: unknown;
    try {
      buildConfig({ LOG_LEVEL: "not-a-level" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain("JWT_SECRET");
    expect(message).toContain("LOG_LEVEL");
  });

  test("applies documented defaults when optional keys are absent", () => {
    const config = buildConfig(baseEnv());

    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("info");
    expect(config.jwtExpirationMin).toBe(10080);
    expect(config.adminEmail).toBe("");
    expect(config.uiBaseUrl).toBe("http://localhost:3000");
    expect(config.corsAllowedOrigins).toEqual(["http://localhost:3000"]);
    expect(config.registrationEnabled).toBe(true);
    expect(config.emailConfirmationEnabled).toBe(false);
    expect(config.mapListMaxSize).toBe(500);
    expect(config.noteMaxLength).toBe(10000);
    expect(config.googleOauthEnabled).toBe(false);
    expect(config.googleClientId).toBe("");
    expect(config.googleClientSecret).toBe("");
  });

  test("overrides defaults from the provided env", () => {
    const config = buildConfig(
      baseEnv({
        PORT: "9000",
        CORS_ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com",
        REGISTRATION_ENABLED: "false",
        ADMIN_EMAIL: "  Admin@Example.com  ",
      }),
    );

    expect(config.port).toBe(9000);
    expect(config.corsAllowedOrigins).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(config.registrationEnabled).toBe(false);
    // Normalised the same way the current implementation documents.
    expect(config.adminEmail).toBe("admin@example.com");
  });

  test("two calls with different envs never share state", () => {
    const first = buildConfig(baseEnv({ PORT: "1111" }));
    const second = buildConfig(baseEnv({ PORT: "2222" }));

    expect(first.port).toBe(1111);
    expect(second.port).toBe(2222);
  });

  test("base64-decodes JWT_SECRET the same way the Java app does", () => {
    const config = buildConfig(baseEnv());
    expect(config.jwtKey).toBeInstanceOf(Uint8Array);
    expect(config.jwtKey.length).toBe(32);
  });

  test("configures Google OAuth when client id and secret are provided", () => {
    const config = buildConfig(
      baseEnv({
        GOOGLE_CLIENT_ID: "client-id-123",
        GOOGLE_CLIENT_SECRET: "client-secret-xyz",
      }),
    );

    expect(config.googleClientId).toBe("client-id-123");
    expect(config.googleClientSecret).toBe("client-secret-xyz");
    expect(config.googleOauthEnabled).toBe(true);
  });

  test("falls back to GOOGLE_SSO_CLIENT_ID and GOOGLE_SSO_CLIENT_SECRET", () => {
    const config = buildConfig(
      baseEnv({
        GOOGLE_SSO_CLIENT_ID: "sso-id-123",
        GOOGLE_SSO_CLIENT_SECRET: "sso-secret-xyz",
      }),
    );

    expect(config.googleClientId).toBe("sso-id-123");
    expect(config.googleClientSecret).toBe("sso-secret-xyz");
    expect(config.googleOauthEnabled).toBe(true);
  });

  test("GOOGLE_CLIENT_ID takes precedence over GOOGLE_SSO_CLIENT_ID", () => {
    const config = buildConfig(
      baseEnv({
        GOOGLE_CLIENT_ID: "primary-id",
        GOOGLE_SSO_CLIENT_ID: "secondary-id",
        GOOGLE_CLIENT_SECRET: "secret",
      }),
    );

    expect(config.googleClientId).toBe("primary-id");
  });

  test("explicit GOOGLE_OAUTH_ENABLED overrides default calculated from credentials", () => {
    const disabled = buildConfig(
      baseEnv({
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_OAUTH_ENABLED: "false",
      }),
    );
    expect(disabled.googleOauthEnabled).toBe(false);

    const enabledExplicitly = buildConfig(
      baseEnv({
        GOOGLE_OAUTH_ENABLED: "true",
      }),
    );
    expect(enabledExplicitly.googleOauthEnabled).toBe(true);
  });

  test("twoFactorEnabled defaults to false and twoFactorSecretKey is empty", () => {
    const cfg = buildConfig(baseEnv());
    expect(cfg.twoFactorEnabled).toBe(false);
    expect(cfg.twoFactorSecretKey).toBeInstanceOf(Uint8Array);
    expect(cfg.twoFactorSecretKey.length).toBe(0);
  });

  test("throws ConfigError when TWO_FACTOR_ENABLED is true and TWO_FACTOR_SECRET_KEY is missing", () => {
    expect(() =>
      buildConfig(baseEnv({ TWO_FACTOR_ENABLED: "true" })),
    ).toThrow(ConfigError);
  });

  test("throws ConfigError when TWO_FACTOR_ENABLED is true and TWO_FACTOR_SECRET_KEY decodes to fewer than 32 bytes", () => {
    const shortKey = Buffer.from("short").toString("base64");
    expect(() =>
      buildConfig(
        baseEnv({
          TWO_FACTOR_ENABLED: "true",
          TWO_FACTOR_SECRET_KEY: shortKey,
        }),
      ),
    ).toThrow(ConfigError);
  });

  test("throws ConfigError when TWO_FACTOR_ENABLED is true and TWO_FACTOR_SECRET_KEY decodes to more than 32 bytes", () => {
    const longKey = Buffer.from("a".repeat(48)).toString("base64");
    expect(() =>
      buildConfig(
        baseEnv({
          TWO_FACTOR_ENABLED: "true",
          TWO_FACTOR_SECRET_KEY: longKey,
        }),
      ),
    ).toThrow(ConfigError);
  });

  test("throws ConfigError when TWO_FACTOR_ENABLED is true and TWO_FACTOR_SECRET_KEY is invalid base64", () => {
    expect(() =>
      buildConfig(
        baseEnv({
          TWO_FACTOR_ENABLED: "true",
          TWO_FACTOR_SECRET_KEY: "not-valid-base64!!!",
        }),
      ),
    ).toThrow(ConfigError);
  });

  test("does not throw when TWO_FACTOR_ENABLED is false even if TWO_FACTOR_SECRET_KEY is invalid", () => {
    expect(() =>
      buildConfig(
        baseEnv({
          TWO_FACTOR_ENABLED: "false",
          TWO_FACTOR_SECRET_KEY: "invalid-key",
        }),
      ),
    ).not.toThrow();
  });

  test("accepts valid 32-byte base64 TWO_FACTOR_SECRET_KEY", () => {
    const validKey = Buffer.from("a".repeat(32)).toString("base64");
    const cfg = buildConfig(
      baseEnv({
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: validKey,
      }),
    );
    expect(cfg.twoFactorEnabled).toBe(true);
    expect(cfg.twoFactorSecretKey.length).toBe(32);
  });

  test("accepts fallback alias TWO_FACTOR_ENCRYPTION_KEY", () => {
    const validKey = Buffer.from("b".repeat(32)).toString("base64");
    const cfg = buildConfig(
      baseEnv({
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_ENCRYPTION_KEY: validKey,
      }),
    );
    expect(cfg.twoFactorEnabled).toBe(true);
    expect(cfg.twoFactorSecretKey.length).toBe(32);
  });

  test("TWO_FACTOR_SECRET_KEY takes precedence over TWO_FACTOR_ENCRYPTION_KEY", () => {
    const primaryKey = Buffer.from("p".repeat(32)).toString("base64");
    const aliasKey = Buffer.from("a".repeat(32)).toString("base64");
    const cfg = buildConfig(
      baseEnv({
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: primaryKey,
        TWO_FACTOR_ENCRYPTION_KEY: aliasKey,
      }),
    );
    expect(cfg.twoFactorSecretKey).toEqual(
      new Uint8Array(Buffer.from("p".repeat(32))),
    );
  });

  test("twoFactorResetEmails defaults to [adminEmail] when ADMIN_EMAIL is configured", () => {
    const cfg = buildConfig(baseEnv({ ADMIN_EMAIL: "admin@wisemapping.org" }));
    expect(cfg.twoFactorResetEmails).toEqual(["admin@wisemapping.org"]);
  });

  test("twoFactorResetEmails defaults to empty array when ADMIN_EMAIL is empty or unset", () => {
    const cfg = buildConfig(baseEnv({ ADMIN_EMAIL: "" }));
    expect(cfg.twoFactorResetEmails).toEqual([]);
  });

  test("twoFactorResetEmails parses comma-separated list and trims/lowercases entries", () => {
    const cfg = buildConfig(
      baseEnv({
        ADMIN_EMAIL: "default-admin@wisemapping.org",
        TWO_FACTOR_RESET_EMAILS: "Admin1@example.com, Admin2@example.com , ",
      }),
    );
    expect(cfg.twoFactorResetEmails).toEqual([
      "admin1@example.com",
      "admin2@example.com",
    ]);
  });

  test("twoFactorResetEmails returns empty array when explicitly set to whitespace", () => {
    const cfg = buildConfig(
      baseEnv({
        ADMIN_EMAIL: "admin@wisemapping.org",
        TWO_FACTOR_RESET_EMAILS: "   ",
      }),
    );
    expect(cfg.twoFactorResetEmails).toEqual([]);
  });

  test("twoFactorResetEmails deduplicates duplicate entries", () => {
    const cfg = buildConfig(
      baseEnv({
        TWO_FACTOR_RESET_EMAILS: "admin@example.com, ADMIN@example.com",
      }),
    );
    expect(cfg.twoFactorResetEmails).toEqual(["admin@example.com"]);
  });
});
