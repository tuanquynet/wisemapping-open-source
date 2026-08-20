import type { PasswordHasher } from "./passwordHash.ts";

/**
 * Cloudflare Workers native password hashing using WebCrypto PBKDF2 with SHA-512
 * (100,000 iterations, 16-byte random salt, 256-bit key) adhering to OWASP
 * standards.
 *
 * Runs natively inside Cloudflare Workers' `crypto.subtle` with zero runtime
 * dependencies and no dynamic WebAssembly compilation (which workerd disallows
 * at runtime).
 */

const PBKDF2_PREFIX = "$pbkdf2-sha512$";
const ITERATIONS = 100000;

function bufferToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBuffer(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export const workerPasswordHasher: PasswordHasher = {
  async hash(plain: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(plain),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: ITERATIONS,
        hash: "SHA-512",
      },
      keyMaterial,
      256,
    );

    const saltB64 = bufferToBase64(salt);
    const hashB64 = bufferToBase64(bits);
    return `${PBKDF2_PREFIX}i=${ITERATIONS}$${saltB64}$${hashB64}`;
  },

  async verify(plain: string, hash: string): Promise<boolean> {
    if (hash.startsWith(PBKDF2_PREFIX)) {
      const parts = hash.split("$").filter(Boolean);
      // ["pbkdf2-sha512", "i=100000", "<salt>", "<hash>"]
      if (parts.length < 4) return false;
      const iter = Number(parts[1]!.replace("i=", ""));
      const salt = base64ToBuffer(parts[2]!);
      const expectedHashB64 = parts[3]!;

      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(plain),
        "PBKDF2",
        false,
        ["deriveBits"],
      );
      const bits = await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt,
          iterations: iter,
          hash: "SHA-512",
        },
        keyMaterial,
        256,
      );

      return bufferToBase64(bits) === expectedHashB64;
    }

    if (typeof Bun !== "undefined" && Bun.password) {
      return Bun.password.verify(plain, hash);
    }

    return false;
  },
};
