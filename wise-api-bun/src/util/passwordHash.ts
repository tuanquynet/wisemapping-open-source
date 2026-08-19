import { workerPasswordHasher } from "./passwordHash.worker.ts";

/**
 * Runtime-selected password hashing, decoupled from `Bun.password` so
 * `authService.ts` can run on Cloudflare Workers too (Task 2.1,
 * tasks/plan.md, Architecture Decision 3).
 *
 * On Bun, `bunPasswordHasher` produces argon2id hashes via `Bun.password.hash`.
 * On Cloudflare Workers, `workerPasswordHasher` produces PBKDF2-SHA512 hashes
 * via native WebCrypto `crypto.subtle`.
 * Both hashers verify both formats seamlessly.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

export const bunPasswordHasher: PasswordHasher = {
  hash: (plain) => Bun.password.hash(plain, { algorithm: "argon2id" }),
  verify: async (plain, hash) => {
    if (hash.startsWith("$pbkdf2-")) {
      return workerPasswordHasher.verify(plain, hash);
    }
    return Bun.password.verify(plain, hash);
  },
};
