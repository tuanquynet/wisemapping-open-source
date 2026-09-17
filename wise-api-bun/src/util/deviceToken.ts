/**
 * Utilities for generating, hashing, and labelling trusted device tokens (D5, D12, FR15, FR18).
 */


/**
 * Cross-runtime base64url encoder using standard Web APIs (no Node Buffer).
 * Runs identically in Bun and Cloudflare Workers (workerd).
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generates a cryptographically random 256-bit device token (32 bytes), base64url-encoded.
 */
export function generateDeviceToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Computes a single-pass SHA-256 hash of the device token via `crypto.subtle`.
 * Stored in `trusted_device.token_hash`. Plaintext device tokens are never stored in the DB.
 */
export async function hashDeviceToken(token: string): Promise<string> {
  const data = new Uint8Array(new TextEncoder().encode(token).buffer as ArrayBuffer);
  const digestBuffer = await crypto.subtle.digest("SHA-256", data);
  const digestBytes = new Uint8Array(digestBuffer);
  let hex = "";
  for (let i = 0; i < digestBytes.length; i++) {
    hex += digestBytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Extracts a friendly browser + OS label from the User-Agent header (FR18).
 * E.g., "Chrome on macOS", "Firefox on Windows", or fallback "Web Browser".
 */
export function formatDeviceLabel(userAgent?: string): string {
  if (!userAgent || userAgent.trim() === "") {
    return "Web Browser";
  }

  let browser = "Browser";
  if (userAgent.includes("Edg/")) browser = "Edge";
  else if (userAgent.includes("Chrome/") && !userAgent.includes("Chromium/")) browser = "Chrome";
  else if (userAgent.includes("Safari/") && !userAgent.includes("Chrome/")) browser = "Safari";
  else if (userAgent.includes("Firefox/")) browser = "Firefox";

  let os = "Desktop";
  if (userAgent.includes("Macintosh") || userAgent.includes("Mac OS X")) os = "macOS";
  else if (userAgent.includes("Windows")) os = "Windows";
  else if (userAgent.includes("Android")) os = "Android";
  else if (userAgent.includes("iPhone") || userAgent.includes("iPad")) os = "iOS";
  else if (userAgent.includes("Linux")) os = "Linux";

  return `${browser} on ${os}`;
}
