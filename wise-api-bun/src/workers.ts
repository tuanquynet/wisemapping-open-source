import { Hono } from "hono";

import { app } from "./app.ts";
import { buildConfig, setConfig, ConfigError, type Config } from "./config.ts";
import { setDbAdapter } from "./db/client.ts";
import { createD1Adapter } from "./db/d1Adapter.ts";
import { MapLockDurableObject } from "./durable-objects/MapLockDurableObject.ts";
import { createWorkerLockManager } from "./services/workerLockManager.ts";
import { workerPasswordHasher } from "./util/passwordHash.worker.ts";
import type { Env } from "./http/env.ts";

export { MapLockDurableObject };

let cachedConfig: Config | undefined;
let d1AdapterInitialized = false;

const workerApp = new Hono<Env>({ strict: false });

workerApp.use("*", async (c, next) => {
  // 1. Build and cache Config per isolate from c.env
  try {
    if (!cachedConfig) {
      cachedConfig = buildConfig(c.env);
      setConfig(cachedConfig);
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      return c.json({ error: e.message }, 500);
    }
    throw e;
  }
  c.set("config", cachedConfig);

  // 2. Initialize D1 database adapter once per isolate
  const bindings = c.env as Record<string, unknown>;
  if (!d1AdapterInitialized && bindings.DB) {
    setDbAdapter(createD1Adapter(bindings.DB as D1Database));
    d1AdapterInitialized = true;
  }

  // 3. Inject Worker LockManager backed by Durable Objects
  if (bindings.MAP_LOCKS) {
    c.set(
      "lockManager",
      createWorkerLockManager(
        bindings.MAP_LOCKS as DurableObjectNamespace<MapLockDurableObject>,
      ),
    );
  }

  // 4. Inject Worker PasswordHasher (hash-wasm)
  c.set("passwordHasher", workerPasswordHasher);

  await next();
});

// Mount the full, shared application routes
workerApp.route("/", app);

export default {
  fetch: workerApp.fetch,
};
