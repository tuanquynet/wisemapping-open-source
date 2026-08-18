import { argon2id, argon2Verify } from "hash-wasm";

import type { PasswordHasher } from "./passwordHash.ts";

/**
 * Argon2id via `hash-wasm` -- pure WASM plus `crypto.getRandomValues`, no
 * WASI or native dependency, so it works unmodified on Cloudflare Workers.
 *
 * Parameters match `Bun.password`'s own argon2id defaults exactly,
 * recovered from a real `Bun.password.hash` output in the Task 0.1 spike
 * (`$argon2id$v=19$m=65536,t=2,p=1$<32-byte-salt>$<32-byte-hash>`), so a
 * password hashed on one runtime verifies correctly on the other -- proven
 * cross-compatible in that same spike, both directions, including
 * non-ASCII passwords, and covered permanently by `test/passwordHash.test.ts`.
 */
export const workerPasswordHasher: PasswordHasher = {
  hash: (plain) =>
    argon2id({
      password: plain,
      salt: crypto.getRandomValues(new Uint8Array(32)),
      parallelism: 1,
      iterations: 2,
      memorySize: 65536,
      hashLength: 32,
      outputType: "encoded",
    }),
  verify: (plain, hash) => argon2Verify({ password: plain, hash }),
};
