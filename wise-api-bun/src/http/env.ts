import type { Account, MindmapWithPeople } from "../domain/types.ts";
import type { LockManager } from "../services/lockManager.interface.ts";
import type { Config } from "../config.ts";
import type { PasswordHasher } from "../util/passwordHash.ts";

/**
 * Typed Hono context variables and, on Cloudflare Workers, bindings.
 *
 * Declaring `Variables` centrally is what makes `c.get('user')` and
 * `c.get('map')` compile-checked, which is the property that lets
 * `requireMapAccess` hand a loaded map to its handler without a second
 * SELECT or a cast. `Bindings` is the shape of `c.env` on Workers -- the
 * raw environment/secret record `workers.ts` passes to `buildConfig(c.env)`.
 * It stays a plain string-keyed record (not typed D1/Durable-Object
 * bindings) until Task 6.2 actually wires them; the Bun entrypoint never
 * uses this generic parameter at all, since it builds config directly from
 * `Bun.env` (see `config.bun.ts`).
 */
export interface Env {
  Variables: {
    /** Set by the jwt middleware on every request; null when unauthenticated. */
    user: Account | null;
    /** Set by requireMapAccess; absent on routes that do not use it. */
    map: MindmapWithPeople | null;
    /** Injected LockManager implementation; defaults to bunLockManager on Bun. */
    lockManager?: LockManager;
    config?: Config;
    passwordHasher?: PasswordHasher;
  };
  Bindings: Record<string, string | undefined>;
}
