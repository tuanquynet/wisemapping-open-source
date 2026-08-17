/**
 * Application configuration, read from the environment once at import time.
 *
 * Replaces the 74-key `application.yml` of the Java app. Most of that file was
 * Spring framework configuration (Hikari, Hibernate, Ehcache, Micrometer,
 * resilience4j) with no analogue here; what remains is the ~15 keys below.
 *
 * Invalid configuration throws at import, so the process never reaches
 * `Bun.serve` in a half-configured state.
 */

export class ConfigError extends Error {}

const problems: string[] = [];

function raw(key: string): string | undefined {
  const v = Bun.env[key];
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
  problems.push(`${key} must be "true" or "false", got ${JSON.stringify(v)}`);
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

/**
 * The Java app base64-decodes `app.jwt.secret` before using it as the HMAC key
 * (`Keys.hmacShaKeyFor(Decoders.BASE64.decode(secret))`). We keep that
 * convention so a secret generated for either implementation works in both.
 *
 * Unlike the Java app -- which only logs a warning when its hardcoded default
 * is still in use, meaning the default ships -- an unset secret is fatal here.
 */
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
  // HS256 keys shorter than the 256-bit digest weaken the MAC for no reason.
  if (decoded.length < 32) {
    problems.push(
      `JWT_SECRET must decode to at least 32 bytes (got ${decoded.length}); use: openssl rand -base64 48`,
    );
  }
  return decoded;
}

const logLevels = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof logLevels)[number];

function logLevel(): LogLevel {
  const v = str("LOG_LEVEL", "info");
  if ((logLevels as readonly string[]).includes(v)) return v as LogLevel;
  problems.push(
    `LOG_LEVEL must be one of ${logLevels.join("|")}, got ${JSON.stringify(v)}`,
  );
  return "info";
}

export const config = Object.freeze({
  port: int("PORT", 8080),
  dbPath: str("DB_PATH", "./data/wisemapping.db"),
  logLevel: logLevel(),

  jwtKey: jwtKey(),
  jwtExpirationMin: int("JWT_EXPIRATION_MIN", 10080),

  /**
   * Admin is a single email address, as in the Java app (`app.admin.user`).
   * Normalised on both sides -- the Java version trims the request's email but
   * not the configured value, so a config entry with trailing whitespace
   * silently grants admin to nobody. Empty means "no admin exists".
   */
  adminEmail: str("ADMIN_EMAIL", "").trim().toLowerCase(),

  uiBaseUrl: str("UI_BASE_URL", "http://localhost:3000"),
  apiBaseUrl: str("API_BASE_URL", "http://localhost:8080"),
  corsAllowedOrigins: csv("CORS_ALLOWED_ORIGINS", ["http://localhost:3000"]),

  registrationEnabled: bool("REGISTRATION_ENABLED", true),
  /**
   * Java defaults this to true. There is no mailer in scope here, so it
   * defaults to false; when enabled, activation URLs go to stdout.
   */
  emailConfirmationEnabled: bool("EMAIL_CONFIRMATION_ENABLED", false),
  captchaEnabled: bool("CAPTCHA_ENABLED", false),
  captchaSiteKey: str("CAPTCHA_SITE_KEY", ""),

  analyticsAccount: str("ANALYTICS_ACCOUNT", ""),
  mapListMaxSize: int("MAP_LIST_MAX_SIZE", 500),
  noteMaxLength: int("NOTE_MAX_LENGTH", 10000),
});

export type Config = typeof config;

if (problems.length > 0) {
  throw new ConfigError(
    `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
      `See .env.example for the full list of settings.`,
  );
}
