/**
 * Crockford's Base32 alphabet (32 characters, excluding I, L, O, U).
 *
 * Provides ~50 bits of entropy for 10-character codes (5 bits per character).
 * Excludes ambiguous characters to prevent visual confusion and offensive words.
 */
export const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates cryptographically secure recovery codes using WebCrypto CSPRNG.
 *
 * @param count Number of codes to generate (defaults to 10)
 * @param length Length of each code (defaults to 10 characters)
 */
export function generateRecoveryCodes(count = 10, length = 10): string[] {
  if (count <= 0 || length <= 0) return [];
  const alphabet = CROCKFORD_BASE32_ALPHABET;
  const alphabetLength = alphabet.length;
  const codes: string[] = [];

  for (let i = 0; i < count; i++) {
    const randomBytes = crypto.getRandomValues(new Uint8Array(length));
    let code = "";
    for (let j = 0; j < length; j++) {
      code += alphabet[randomBytes[j]! % alphabetLength];
    }
    codes.push(code);
  }

  return codes;
}

/**
 * Normalizes user-entered recovery codes:
 * - Strips all internal and surrounding whitespace
 * - Strips all hyphens/dashes
 * - Converts to uppercase
 */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}

/**
 * Computes a single-pass SHA-256 hash of a normalized recovery code via `crypto.subtle`.
 *
 * Matches the database format stored in `account_recovery_code.code_hash`.
 * Plaintext recovery codes are never stored or logged.
 *
 * @returns 64-character lowercase hexadecimal SHA-256 digest
 */
export async function hashRecoveryCode(code: string): Promise<string> {
  const normalized = normalizeRecoveryCode(code);
  const data = new Uint8Array(new TextEncoder().encode(normalized).buffer as ArrayBuffer);
  const digestBuffer = await crypto.subtle.digest("SHA-256", data);
  const digestBytes = new Uint8Array(digestBuffer);
  let hex = "";
  for (let i = 0; i < digestBytes.length; i++) {
    hex += digestBytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
