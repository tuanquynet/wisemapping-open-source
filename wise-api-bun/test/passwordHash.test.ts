import { describe, expect, test } from "bun:test";

import { bunPasswordHasher } from "../src/util/passwordHash.ts";
import { workerPasswordHasher } from "../src/util/passwordHash.worker.ts";

/**
 * Task 2.1: two independent `PasswordHasher` implementations must produce
 * and accept the *same* argon2id PHC format, since the `account` table is
 * shared and either runtime may serve a given login. Task 0.1's spike
 * proved this once in a throwaway script; these tests make it a permanent
 * regression check -- a future hash-wasm or Bun upgrade that silently
 * changes defaults must fail the suite, not surface as a locked-out user.
 */

describe("bunPasswordHasher", () => {
  test("verifies a password it hashed itself", async () => {
    const hash = await bunPasswordHasher.hash("correcthorsebatterystaple");
    expect(await bunPasswordHasher.verify("correcthorsebatterystaple", hash)).toBe(true);
  });

  test("rejects the wrong password", async () => {
    const hash = await bunPasswordHasher.hash("correcthorsebatterystaple");
    expect(await bunPasswordHasher.verify("wrong-password", hash)).toBe(false);
  });
});

describe("workerPasswordHasher", () => {
  test("verifies a password it hashed itself", async () => {
    const hash = await workerPasswordHasher.hash("correcthorsebatterystaple");
    expect(await workerPasswordHasher.verify("correcthorsebatterystaple", hash)).toBe(true);
  });

  test("rejects the wrong password", async () => {
    const hash = await workerPasswordHasher.hash("correcthorsebatterystaple");
    expect(await workerPasswordHasher.verify("wrong-password", hash)).toBe(false);
  });
});

describe("cross-runtime compatibility", () => {
  test("a hash from bunPasswordHasher verifies under workerPasswordHasher", async () => {
    const hash = await bunPasswordHasher.hash("contraseña-ñ-é-中文-🔒");
    expect(
      await workerPasswordHasher.verify("contraseña-ñ-é-中文-🔒", hash),
    ).toBe(true);
    expect(await workerPasswordHasher.verify("wrong", hash)).toBe(false);
  });

  test("a hash from workerPasswordHasher verifies under bunPasswordHasher", async () => {
    const hash = await workerPasswordHasher.hash("contraseña-ñ-é-中文-🔒");
    expect(
      await bunPasswordHasher.verify("contraseña-ñ-é-中文-🔒", hash),
    ).toBe(true);
    expect(await bunPasswordHasher.verify("wrong", hash)).toBe(false);
  });
});
