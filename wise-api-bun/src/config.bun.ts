/**
 * Bun's eager, process-wide config singleton -- built once at import time
 * from `Bun.env`, exactly as `config.ts` itself did before it became a
 * pure, runtime-agnostic factory (Task 1.2, tasks/plan.md).
 *
 * Every Bun-side module that used to import `{ config }` from `./config.ts`
 * now imports it from here instead. The Cloudflare Workers entrypoint
 * (`workers.ts`, Task 6.2) calls `buildConfig(c.env)` directly, per request,
 * memoized per isolate, and never imports this file -- so it never touches
 * the Bun-only global, which does not exist in the Workers runtime.
 *
 * Invalid configuration throws here at import time, so the Bun process
 * never reaches `Bun.serve` in a half-configured state -- identical to
 * `config.ts`'s previous behavior.
 */
import { buildConfig, type Config } from "./config.ts";

export const config: Config = buildConfig(Bun.env);
