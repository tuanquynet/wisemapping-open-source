import * as OTPAuth from "otpauth";

const ISSUER = "WiseMapping";

/**
 * Generates a random TOTP secret: 20 bytes (160 bits), RFC 4648 base32-encoded.
 * This is the RFC 6238 recommended size for SHA-1 TOTP and is the alphabet
 * (A-Z, 2-7) that authenticator apps decode.
 */
export function generateTotpSecret(): string {
  const secret = new OTPAuth.Secret({ size: 20 });
  return secret.base32;
}

/**
 * Builds the standard otpauth:// provisioning URI consumed by
 * authenticator apps (Google Authenticator, 1Password, Authy, etc.).
 *
 * Format:
 * otpauth://totp/WiseMapping:<email>?secret=<base32>&issuer=WiseMapping&algorithm=SHA1&digits=6&period=30
 */
export function buildOtpauthUri(email: string, secretBase32: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

/**
 * Verifies a TOTP token against a base32 secret with ±1 period (±30s) drift.
 *
 * Returns `{ valid: true, delta }` where delta is the period offset (0 = current
 * period, -1 = previous, 1 = next) or `{ valid: false }` when the token does
 * not match any window.
 */
export function verifyTotpCode(
  secretBase32: string,
  token: string,
): { valid: boolean; delta?: number | undefined; step?: number | undefined } {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  const delta = totp.validate({ token: token.trim(), window: 1 });
  if (delta === null) {
    return { valid: false };
  }
  const currentStep = Math.floor(Date.now() / 1000 / 30);
  return { valid: true, delta, step: currentStep + delta };
}
