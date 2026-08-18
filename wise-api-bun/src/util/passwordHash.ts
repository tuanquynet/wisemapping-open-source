/**
 * Runtime-selected password hashing, decoupled from `Bun.password` so
 * `authService.ts` can run on Cloudflare Workers too (Task 2.1,
 * tasks/plan.md, Architecture Decision 3). `Bun.password` does not exist in
 * the Workers runtime; `passwordHash.worker.ts` provides the `hash-wasm`
 * equivalent, using parameters proven PHC-compatible with this one by the
 * Task 0.1 spike -- both implementations must accept each other's output,
 * since the `account` table is shared and either runtime may serve a given
 * login.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

/**
 * Argon2id via `Bun.password`. Greenfield, so none of the Java compatibility
 * machinery applies -- no `ENC:` unsalted SHA-1, no `{bcrypt}` prefix
 * dispatch. `Bun.password.verify` reads the algorithm from the stored hash,
 * so migrating to something else later needs no dual-read path.
 */
export const bunPasswordHasher: PasswordHasher = {
  hash: (plain) => Bun.password.hash(plain, { algorithm: "argon2id" }),
  verify: (plain, hash) => Bun.password.verify(plain, hash),
};
