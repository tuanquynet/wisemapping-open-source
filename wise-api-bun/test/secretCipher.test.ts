import { afterAll, describe, expect, test } from "bun:test";

import { setConfig, buildConfig, getConfig, ConfigError } from "../src/config.ts";
import {
  encryptSecret,
  decryptSecret,
  SecretDecryptionError,
} from "../src/util/secretCipher.ts";

const VALID_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) VALID_KEY[i] = i;

const VALID_KEY_B64 = Buffer.from(VALID_KEY).toString("base64");
const VALID_JWT_SECRET = Buffer.from("j".repeat(32)).toString("base64");

describe("secretCipher", () => {
  const initialConfig = getConfig();

  afterAll(() => {
    setConfig(initialConfig);
  });
  test("round-trips encryption and decryption with explicit key", async () => {
    const plaintext = "JBSWY3DPEHPK3PXP";
    const accountId = 101;
    const cipher = await encryptSecret(plaintext, accountId, VALID_KEY);

    expect(cipher.startsWith("v1$")).toBe(true);
    const decrypted = await decryptSecret(cipher, accountId, VALID_KEY);
    expect(decrypted).toBe(plaintext);
  });

  test("round-trips using config.twoFactorSecretKey when keyBytes is omitted", async () => {
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY_B64,
      }),
    );

    const plaintext = "SECRET_FROM_CONFIG_KEY";
    const accountId = 55;
    const cipher = await encryptSecret(plaintext, accountId);
    const decrypted = await decryptSecret(cipher, accountId);
    expect(decrypted).toBe(plaintext);
  });

  test("throws ConfigError when config.twoFactorSecretKey is empty and keyBytes is omitted", async () => {
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "false",
      }),
    );

    await expect(encryptSecret("test", 1)).rejects.toThrow(ConfigError);
    await expect(
      decryptSecret("v1$AQIDBAUGBwgJCgsM$ciphertext", 1),
    ).rejects.toThrow(ConfigError);
  });

  test("throws ConfigError when key is not exactly 32 bytes", async () => {
    const shortKey = new Uint8Array(16);
    const longKey = new Uint8Array(48);

    await expect(encryptSecret("test", 1, shortKey)).rejects.toThrow(ConfigError);
    await expect(encryptSecret("test", 1, longKey)).rejects.toThrow(ConfigError);
    await expect(
      decryptSecret("v1$AQIDBAUGBwgJCgsM$ciphertext", 1, shortKey),
    ).rejects.toThrow(ConfigError);
  });

  test("fails when IV length is not 12 bytes", async () => {
    const badIv8Bytes = Buffer.from(new Uint8Array(8)).toString("base64");
    const dummyCt = Buffer.from(new Uint8Array(16)).toString("base64");
    const cipherWithBadIv = `v1$${badIv8Bytes}$${dummyCt}`;

    await expect(
      decryptSecret(cipherWithBadIv, 1, VALID_KEY),
    ).rejects.toThrow(SecretDecryptionError);
  });

  test("uses fresh random IV for each encryption call", async () => {
    const plaintext = "STATIC_SECRET_123456";
    const accountId = 42;

    const cipher1 = await encryptSecret(plaintext, accountId, VALID_KEY);
    const cipher2 = await encryptSecret(plaintext, accountId, VALID_KEY);

    expect(cipher1).not.toBe(cipher2);

    const iv1 = cipher1.split("$")[1];
    const iv2 = cipher2.split("$")[1];
    expect(iv1).not.toBe(iv2);
  });

  test("enforces AAD account binding: account A ciphertext fails to decrypt for account B", async () => {
    const plaintext = "ACCOUNT_ISOLATION_SECRET";
    const cipher = await encryptSecret(plaintext, 100, VALID_KEY);

    await expect(decryptSecret(cipher, 101, VALID_KEY)).rejects.toThrow(
      SecretDecryptionError,
    );
  });

  test("fails when ciphertext payload is tampered", async () => {
    const plaintext = "TAMPER_TEST_SECRET";
    const cipher = await encryptSecret(plaintext, 1, VALID_KEY);
    const parts = cipher.split("$");

    // Modify a character in the ciphertext segment
    const tamperedCt =
      parts[2]!.slice(0, -4) +
      (parts[2]!.endsWith("A") ? "B" : "A") +
      parts[2]!.slice(-3);
    const tampered = `${parts[0]}$${parts[1]}$${tamperedCt}`;

    await expect(decryptSecret(tampered, 1, VALID_KEY)).rejects.toThrow(
      SecretDecryptionError,
    );
  });

  test("fails when IV is tampered", async () => {
    const plaintext = "IV_TAMPER_TEST";
    const cipher = await encryptSecret(plaintext, 1, VALID_KEY);
    const parts = cipher.split("$");

    // Modify a character in IV
    const tamperedIv =
      (parts[1]!.startsWith("A") ? "B" : "A") + parts[1]!.slice(1);
    const tampered = `${parts[0]}$${tamperedIv}$${parts[2]}`;

    await expect(decryptSecret(tampered, 1, VALID_KEY)).rejects.toThrow(
      SecretDecryptionError,
    );
  });

  test("fails on malformed ciphertext format", async () => {
    await expect(decryptSecret("not-a-valid-ciphertext", 1, VALID_KEY)).rejects.toThrow(
      SecretDecryptionError,
    );

    await expect(decryptSecret("v2$AQIDBAUGBwgJCgsM$ciphertext", 1, VALID_KEY)).rejects.toThrow(
      SecretDecryptionError,
    );

    await expect(decryptSecret("v1$bad_base64!!!$bad_base64!!!", 1, VALID_KEY)).rejects.toThrow(
      SecretDecryptionError,
    );
  });

  test("decrypts pinned test vector identically (cross-runtime vector verification)", async () => {
    const pinnedKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) pinnedKey[i] = i;

    const pinnedCiphertext =
      "v1$AQIDBAUGBwgJCgsM$T6gJgrWntNYJ6jMMI0OyeBE+1RdBeyhZLd9l96qV030=";
    const accountId = 42;

    const decrypted = await decryptSecret(pinnedCiphertext, accountId, pinnedKey);
    expect(decrypted).toBe("JBSWY3DPEHPK3PXP");
  });
});
