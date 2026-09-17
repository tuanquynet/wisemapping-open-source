import { config, ConfigError } from "../config.ts";

/**
 * Dedicated error class for secret decryption failures.
 *
 * A decryption failure represents a 500-class key configuration or data corruption fault.
 * It must never be caught and converted to a 400 BadRequestError ("Invalid code").
 */
export class SecretDecryptionError extends Error {
  constructor(message = "Secret decryption failed") {
    super(message);
    this.name = "SecretDecryptionError";
  }
}

/**
 * Cross-runtime base64 encoder using standard Web APIs.
 * Runs identically in Bun and Cloudflare Workers (workerd) without Node Buffer.
 */
function bufferToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Cross-runtime base64 decoder using standard Web APIs.
 * Runs identically in Bun and Cloudflare Workers (workerd) without Node Buffer.
 */
function base64ToBuffer(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encrypts a plaintext TOTP secret with AES-256-GCM via `crypto.subtle`.
 *
 * - Generates a fresh random 96-bit (12-byte) IV per invocation.
 * - Binds the account ID as Additional Authenticated Data (AAD) to enforce row-level isolation.
 * - Formats output as `v1$<iv_base64>$<ciphertext_base64>`.
 */
export async function encryptSecret(
  plaintext: string,
  accountId: number,
  keyBytes?: Uint8Array,
): Promise<string> {
  const key = keyBytes ?? config.twoFactorSecretKey;
  if (!key || key.length === 0) {
    throw new ConfigError(
      "TWO_FACTOR_SECRET_KEY is required for secret encryption",
    );
  }
  if (key.length !== 32) {
    throw new ConfigError(
      `TWO_FACTOR_SECRET_KEY must be exactly 32 bytes for AES-256-GCM (got ${key.length})`,
    );
  }

  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const keyData = new Uint8Array(key.buffer as ArrayBuffer, key.byteOffset, key.byteLength);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const aad = new Uint8Array(new TextEncoder().encode(String(accountId)).buffer as ArrayBuffer);
    const plaintextBytes = new Uint8Array(new TextEncoder().encode(plaintext).buffer as ArrayBuffer);

    const cipherBuffer = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: aad,
      },
      cryptoKey,
      plaintextBytes,
    );

    return `v1$${bufferToBase64(iv)}$${bufferToBase64(cipherBuffer)}`;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new Error(
      `Secret encryption failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Decrypts an AES-256-GCM ciphertext produced by `encryptSecret`.
 *
 * Throws `SecretDecryptionError` if:
 * - The format is invalid or version prefix is not `v1$`
 * - The IV or ciphertext base64 is malformed
 * - The account ID does not match the bound AAD
 * - The ciphertext body or authentication tag has been tampered with
 */
export async function decryptSecret(
  cipherText: string,
  accountId: number,
  keyBytes?: Uint8Array,
): Promise<string> {
  const key = keyBytes ?? config.twoFactorSecretKey;
  if (!key || key.length === 0) {
    throw new ConfigError(
      "TWO_FACTOR_SECRET_KEY is required for secret decryption",
    );
  }
  if (key.length !== 32) {
    throw new ConfigError(
      `TWO_FACTOR_SECRET_KEY must be exactly 32 bytes for AES-256-GCM (got ${key.length})`,
    );
  }

  const parts = cipherText.split("$");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    throw new SecretDecryptionError("Invalid ciphertext format");
  }

  let iv: Uint8Array<ArrayBuffer>;
  let ciphertextWithTag: Uint8Array<ArrayBuffer>;
  try {
    iv = base64ToBuffer(parts[1]);
    ciphertextWithTag = base64ToBuffer(parts[2]);
  } catch {
    throw new SecretDecryptionError("Invalid base64 in ciphertext");
  }
  if (iv.length !== 12) {
    throw new SecretDecryptionError(
      `Invalid IV length: expected 12 bytes, got ${iv.length}`,
    );
  }

  try {
    const keyData = new Uint8Array(key.buffer as ArrayBuffer, key.byteOffset, key.byteLength);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );

    const aad = new Uint8Array(new TextEncoder().encode(String(accountId)).buffer as ArrayBuffer);
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: aad,
      },
      cryptoKey,
      ciphertextWithTag,
    );
    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    if (err instanceof SecretDecryptionError) throw err;
    throw new SecretDecryptionError(
      "Authentication tag verification or decryption failed",
    );
  }
}
