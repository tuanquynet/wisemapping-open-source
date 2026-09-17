import { describe, expect, test } from "bun:test";

import {
  CROCKFORD_BASE32_ALPHABET,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
} from "../src/util/recoveryCode.ts";

describe("recoveryCode", () => {
  describe("alphabet", () => {
    test("Crockford Base32 alphabet has exactly 32 characters", () => {
      expect(CROCKFORD_BASE32_ALPHABET.length).toBe(32);
      expect(CROCKFORD_BASE32_ALPHABET).toBe(
        "0123456789ABCDEFGHJKMNPQRSTVWXYZ",
      );
      // Excludes visually ambiguous characters I, L, O, U
      expect(CROCKFORD_BASE32_ALPHABET).not.toContain("I");
      expect(CROCKFORD_BASE32_ALPHABET).not.toContain("L");
      expect(CROCKFORD_BASE32_ALPHABET).not.toContain("O");
      expect(CROCKFORD_BASE32_ALPHABET).not.toContain("U");
    });
  });

  describe("generateRecoveryCodes", () => {
    test("generates 10 codes of 10 characters each by default", () => {
      const codes = generateRecoveryCodes();
      expect(codes.length).toBe(10);
      for (const code of codes) {
        expect(code.length).toBe(10);
      }
    });

    test("all characters belong to Crockford Base32 alphabet", () => {
      const codes = generateRecoveryCodes(20, 12);
      const alphabetSet = new Set(CROCKFORD_BASE32_ALPHABET);
      for (const code of codes) {
        for (const char of code) {
          expect(alphabetSet.has(char)).toBe(true);
        }
      }
    });

    test("all codes in a generated batch are distinct", () => {
      const codes = generateRecoveryCodes(10, 10);
      const unique = new Set(codes);
      expect(unique.size).toBe(10);
    });

    test("accepts custom count and length", () => {
      const codes = generateRecoveryCodes(5, 8);
      expect(codes.length).toBe(5);
      for (const code of codes) {
        expect(code.length).toBe(8);
      }
    });

    test("returns empty array when count or length is non-positive", () => {
      expect(generateRecoveryCodes(0, 10)).toEqual([]);
      expect(generateRecoveryCodes(-1, 10)).toEqual([]);
      expect(generateRecoveryCodes(10, 0)).toEqual([]);
      expect(generateRecoveryCodes(10, -5)).toEqual([]);
    });
  });

  describe("normalizeRecoveryCode", () => {
    test("removes spaces and hyphens, and converts to uppercase", () => {
      expect(normalizeRecoveryCode("4k7m-2p9x 1z")).toBe("4K7M2P9X1Z");
      expect(normalizeRecoveryCode("  4k7m--2p9x  1z  ")).toBe("4K7M2P9X1Z");
      expect(normalizeRecoveryCode("4K7M2P9X1Z")).toBe("4K7M2P9X1Z");
      expect(normalizeRecoveryCode("abcd-efgh-jk")).toBe("ABCDEFGHJK");
    });
  });

  describe("hashRecoveryCode", () => {
    test("computes 64-character lowercase hexadecimal SHA-256 digest", async () => {
      const hash = await hashRecoveryCode("4K7M2P9X1Z");
      expect(hash.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    });

    test("normalizes input before hashing so case and spacing variations match", async () => {
      const canonicalHash = await hashRecoveryCode("4K7M2P9X1Z");
      const formattedHash = await hashRecoveryCode("4k7m-2p9x 1z");
      const spacedHash = await hashRecoveryCode("  4k7m  2p9x  1z  ");

      expect(formattedHash).toBe(canonicalHash);
      expect(spacedHash).toBe(canonicalHash);
    });

    test("matches deterministic verified test vector", async () => {
      // Known verified SHA-256 of "4K7M2P9X1Z"
      const expected =
        "59ec2512ad58ab39acafefc8bd87f422829ced8a25471074852921a719503f73";
      const hash = await hashRecoveryCode("4K7M2P9X1Z");
      expect(hash).toBe(expected);
    });

    test("different codes produce different hashes", async () => {
      const hash1 = await hashRecoveryCode("4K7M2P9X1Z");
      const hash2 = await hashRecoveryCode("4K7M2P9X1Y");
      expect(hash1).not.toBe(hash2);
    });
  });
});
