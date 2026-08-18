import { Hono } from "hono";

import { buildConfig, ConfigError, type Config } from "./config.ts";
import { buildAppConfig } from "./http/dto/restAppConfig.ts";
import type { Env } from "./http/env.ts";

/**
 * Cloudflare Workers entrypoint -- Phase 1 walking skeleton (Task 1.3,
 * tasks/plan.md).
 *
 * This is deliberately its own `Hono` instance, not the shared `app` from
 * `app.ts`. `app.ts` still statically imports `bun:sqlite` transitively
 * (`jwt` middleware -> `db/repos/accounts.ts` -> `db/client.ts`), and
 * Wrangler's bundler cannot resolve that at all -- confirmed empirically:
 * `wrangler deploy --dry-run` fails immediately with
 * `Could not resolve "bun:sqlite"` the moment `app.ts` is reachable from
 * the entrypoint. Every route below except `/app/config` returns 501 until
 * Phases 2-4 port the data layer off `bun:sqlite` onto `DbAdapter`, at
 * which point Task 6.2 replaces this file with one that mounts the real,
 * by-then Workers-safe `app` from `app.ts`.
 *
 * `/app/config` already works end-to-end because `buildAppConfig` (Task
 * 1.3) and `buildConfig` (Task 1.2) are both pure functions with no
 * `bun:sqlite` or `Bun.env` dependency -- the first two pieces of the
 * codebase that are genuinely runtime-agnostic.
 */

let cachedConfig: Config | undefined;

/**
 * Builds `Config` from `c.env` on first request and memoizes it for the
 * isolate's lifetime -- the closest Workers equivalent to Bun's
 * eager-at-import-time singleton, since Workers has no boot phase separate
 * from request handling and `c.env` is only available inside the handler.
 */
function resolveConfig(env: Record<string, string | undefined>): Config {
  cachedConfig ??= buildConfig(env);
  return cachedConfig;
}

const app = new Hono<Env>();

/** GET /api/restful/app/config -- the one route this skeleton actually serves. */
app.get("/api/restful/app/config", (c) => {
  try {
    return c.json(buildAppConfig(resolveConfig(c.env)));
  } catch (e) {
    if (e instanceof ConfigError) {
      // Workers has no boot phase to fail during; every request 500s until
      // the deployment's env vars/secrets are fixed, per Architecture
      // Decision 5 in tasks/plan.md.
      return c.json({ error: e.message }, 500);
    }
    throw e;
  }
});

/** Everything else is not yet ported to this runtime. */
app.all("*", (c) =>
  c.json(
    { error: "Not implemented on Cloudflare Workers yet", path: c.req.path },
    501,
  ),
);

export default {
  fetch: app.fetch,
};

export { MapLockDurableObject } from "./durable-objects/MapLockDurableObject.ts";
