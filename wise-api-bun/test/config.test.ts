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
});
