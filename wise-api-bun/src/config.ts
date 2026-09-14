/**
 * Application configuration: a pure factory over an explicit env record,
 * with runtime-agnostic dynamic getters (Task 6.2, tasks/plan.md).
 *
 * Replaces the 74-key `application.yml` of the Java app.
 *
 * On Bun, `config.*` lazily initializes from `Bun.env` on first access if
 * `setConfig()` wasn't called.
 * On Cloudflare Workers, `workers.ts` builds `Config` from `c.env` on the
 * first request and calls `setConfig(config)`, populating all subsequent
 * reads across services, routes, and utilities.
 */

export class ConfigError extends Error {}

const logLevels = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof logLevels)[number];

/** The validated, immutable shape every consumer -- Bun or Workers -- reads. */
export interface Config {
  readonly port: number;
  readonly dbPath: string;
  readonly logLevel: LogLevel;
  readonly jwtKey: Uint8Array;
  readonly jwtExpirationMin: number;
  readonly adminEmail: string;
  readonly uiBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly corsAllowedOrigins: string[];
  readonly registrationEnabled: boolean;
  readonly emailConfirmationEnabled: boolean;
  readonly captchaEnabled: boolean;
  readonly captchaSiteKey: string;
  readonly analyticsAccount: string;
  readonly mapListMaxSize: number;
  readonly noteMaxLength: number;
  readonly googleOauthEnabled: boolean;
  readonly googleClientId: string;
  readonly googleClientSecret: string;
}

/**
 * Builds and validates configuration from an explicit env record. Invalid
 * configuration throws `ConfigError` immediately.
 */
export function buildConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];

  function raw(key: string): string | undefined {
    const v = env[key];
    return v === undefined || v === "" ? undefined : v;
  }

  function str(key: string, fallback: string): string {
    return raw(key) ?? fallback;
  }

  function required(key: string, hint: string): string {
    const v = raw(key);
    if (v === undefined) {
      problems.push(`${key} is required. ${hint}`);
      return "";
    }
    return v;
  }

  function int(key: string, fallback: number): number {
    const v = raw(key);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n)) {
      problems.push(`${key} must be an integer, got ${JSON.stringify(v)}`);
      return fallback;
    }
    return n;
  }

  function bool(key: string, fallback: boolean): boolean {
    const v = raw(key);
    if (v === undefined) return fallback;
    if (v === "true") return true;
    if (v === "false") return false;
    problems.push(
      `${key} must be "true" or "false", got ${JSON.stringify(v)}`,
    );
    return fallback;
  }

  function csv(key: string, fallback: string[]): string[] {
    const v = raw(key);
    if (v === undefined) return fallback;
    return v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function jwtKey(): Uint8Array {
    const encoded = required(
      "JWT_SECRET",
      "Generate one with: openssl rand -base64 48",
    );
    if (encoded === "") return new Uint8Array();

    let decoded: Uint8Array;
    try {
      decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    } catch {
      problems.push("JWT_SECRET must be valid base64");
      return new Uint8Array();
    }
    if (decoded.length < 32) {
      problems.push(
        `JWT_SECRET must decode to at least 32 bytes (got ${decoded.length}); use: openssl rand -base64 48`,
      );
    }
    return decoded;
  }

  function logLevel(): LogLevel {
    const v = str("LOG_LEVEL", "info");
    if ((logLevels as readonly string[]).includes(v)) return v as LogLevel;
    problems.push(
      `LOG_LEVEL must be one of ${logLevels.join("|")}, got ${JSON.stringify(v)}`,
    );
    return "info";
  }

  const googleClientId =
    raw("GOOGLE_CLIENT_ID") ?? raw("GOOGLE_SSO_CLIENT_ID") ?? "";
  const googleClientSecret =
    raw("GOOGLE_CLIENT_SECRET") ?? raw("GOOGLE_SSO_CLIENT_SECRET") ?? "";
  const googleOauthDefault =
    googleClientId !== "" && googleClientSecret !== "";
  const googleOauthEnabled = bool("GOOGLE_OAUTH_ENABLED", googleOauthDefault);

  const result: Config = Object.freeze({
    port: int("PORT", 8080),
    dbPath: str("DB_PATH", "./data/wisemapping.db"),
    logLevel: logLevel(),

    jwtKey: jwtKey(),
    jwtExpirationMin: int("JWT_EXPIRATION_MIN", 10080),

    adminEmail: str("ADMIN_EMAIL", "").trim().toLowerCase(),

    uiBaseUrl: str("UI_BASE_URL", "http://localhost:3000"),
    apiBaseUrl: str("API_BASE_URL", "http://localhost:8080"),
    corsAllowedOrigins: csv("CORS_ALLOWED_ORIGINS", [
      "http://localhost:3000",
    ]),

    registrationEnabled: bool("REGISTRATION_ENABLED", true),
    emailConfirmationEnabled: bool("EMAIL_CONFIRMATION_ENABLED", false),
    captchaEnabled: bool("CAPTCHA_ENABLED", false),
    captchaSiteKey: str("CAPTCHA_SITE_KEY", ""),

    analyticsAccount: str("ANALYTICS_ACCOUNT", ""),
    mapListMaxSize: int("MAP_LIST_MAX_SIZE", 500),
    noteMaxLength: int("NOTE_MAX_LENGTH", 10000),

    googleOauthEnabled,
    googleClientId,
    googleClientSecret,
  });

  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        `See .env.example for the full list of settings.`,
    );
  }

  return result;
}

let activeConfig: Config | null = null;

export function setConfig(cfg: Config): void {
  activeConfig = cfg;
}

export function getConfig(): Config {
  if (activeConfig === null) {
    if (typeof Bun !== "undefined" && Bun.env) {
      activeConfig = buildConfig(Bun.env);
      return activeConfig;
    }
    throw new Error(
      "Configuration has not been initialized. Ensure buildConfig() and setConfig() are called.",
    );
  }
  return activeConfig;
}

/**
 * Dynamic configuration proxy. Property reads resolve against `getConfig()`,
 * so modules importing `config` never access uninitialized globals at module
 * load time on Workers.
 */
export const config: Config = {
  get port() { return getConfig().port; },
  get dbPath() { return getConfig().dbPath; },
  get logLevel() { return getConfig().logLevel; },
  get jwtKey() { return getConfig().jwtKey; },
  get jwtExpirationMin() { return getConfig().jwtExpirationMin; },
  get adminEmail() { return getConfig().adminEmail; },
  get uiBaseUrl() { return getConfig().uiBaseUrl; },
  get apiBaseUrl() { return getConfig().apiBaseUrl; },
  get corsAllowedOrigins() { return getConfig().corsAllowedOrigins; },
  get registrationEnabled() { return getConfig().registrationEnabled; },
  get emailConfirmationEnabled() { return getConfig().emailConfirmationEnabled; },
  get captchaEnabled() { return getConfig().captchaEnabled; },
  get captchaSiteKey() { return getConfig().captchaSiteKey; },
  get analyticsAccount() { return getConfig().analyticsAccount; },
  get mapListMaxSize() { return getConfig().mapListMaxSize; },
  get noteMaxLength() { return getConfig().noteMaxLength; },
  get googleOauthEnabled() { return getConfig().googleOauthEnabled; },
  get googleClientId() { return getConfig().googleClientId; },
  get googleClientSecret() { return getConfig().googleClientSecret; },
};
