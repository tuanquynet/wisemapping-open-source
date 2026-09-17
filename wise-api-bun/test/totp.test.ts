import { describe, expect, test } from "bun:test";

import * as OTPAuth from "otpauth";
import {
  generateTotpSecret,
  buildOtpauthUri,
  verifyTotpCode,
} from "../src/util/totp.ts";

const TEST_EMAIL = "alice@example.org";

describe("totp utility", () => {
  test("generateTotpSecret produces a valid RFC 4648 base32 secret (160 bits)", () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBe(32); // 20 bytes -> 32 base32 chars, no padding
    // RFC 4648 base32: A-Z and 2-7 only (the alphabet authenticator apps decode).
    for (const char of secret) {
      expect(/^[A-Z2-7]$/.test(char)).toBe(true);
    }
  });

  test("generateTotpSecret produces distinct secrets on repeated calls", () => {
    const secret1 = generateTotpSecret();
    const secret2 = generateTotpSecret();
    expect(secret1).not.toBe(secret2);
  });

  test("buildOtpauthUri produces the documented URI format", () => {
    const secret = generateTotpSecret();
    const uri = buildOtpauthUri(TEST_EMAIL, secret);

    expect(uri.startsWith("otpauth://totp/WiseMapping:")).toBe(true);
    expect(uri).toContain(encodeURIComponent(TEST_EMAIL));
    expect(uri).toContain("issuer=WiseMapping");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri).toContain(`secret=${secret}`);
  });

  test("verifyTotpCode accepts a current TOTP token for its own secret", () => {
    const secret = generateTotpSecret();
    const totp = new OTPAuth.TOTP({
      issuer: "WiseMapping",
      label: TEST_EMAIL,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const token = totp.generate();
    const result = verifyTotpCode(secret, token);
    expect(result.valid).toBe(true);
    expect(result.delta).toBeDefined();
    expect(typeof result.step).toBe("number");
    expect(result.step!).toBeGreaterThan(0);
  });

  test("verifyTotpCode rejects an incorrect token", () => {
    const secret = generateTotpSecret();
    const result = verifyTotpCode(secret, "000000");
    expect(result.valid).toBe(false);
  });
});
