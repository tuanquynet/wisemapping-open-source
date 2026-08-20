import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { mapRoutes } from "../src/http/routes/maps.ts";
import { authRoutes } from "../src/http/routes/auth.ts";
import { jwt } from "../src/http/middleware/jwt.ts";
import { errorHandler } from "../src/http/middleware/errorHandler.ts";
import type { LockInfo, LockManager } from "../src/services/lockManager.interface.ts";
import type { Env } from "../src/http/env.ts";
import { createUser } from "./helpers/auth.ts";
import { createMap } from "./helpers/maps.ts";
import { resetDb } from "./helpers/db.ts";

/**
 * Task 5.3: verifies that route handlers in `maps.ts` and `auth.ts` are
 * runtime-agnostic and use the `LockManager` injected via Hono context when
 * present, falling back to `bunLockManager` on Bun when absent.
 */

beforeEach(() => {
  resetDb();
});

describe("lock routes use context-injected LockManager", () => {
  test("map lock route invokes injected LockManager.lock", async () => {
    const user = await createUser();
    const mapId = await createMap(user, "Context Lock Test");
    let lockCalledWithMapId = 0;

    const mockLockManager: LockManager = {
      async getLockInfo(_id: number) {
        return null;
      },
      async isLocked() {
        return false;
      },
      async isLockedBy() {
        return false;
      },
      async lock(map, u) {
        lockCalledWithMapId = map.id;
        return {
          mapId: map.id,
          userId: u.id,
          userEmail: u.email,
          userFullName: "User",
          expiresAt: Date.now() + 10000,
          session: "mock-session",
        };
      },
      async unlock() {},
      async unlockAll() {
        return 0;
      },
    };

    const app = new Hono<Env>();
    app.onError(errorHandler);
    app.use("/api/*", jwt);
    app.use("*", async (c, next) => {
      c.set("lockManager", mockLockManager);
      await next();
    });
    app.route("/api/restful/maps", mapRoutes);

    const res = await app.request(`/api/restful/maps/${mapId}/lock`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain", ...user.authHeaders },
      body: "true",
    });

    expect(res.status).toBe(200);
    expect(lockCalledWithMapId).toBe(mapId);
  });

  test("logout route invokes injected LockManager.unlockAll", async () => {
    const user = await createUser();
    let unlockAllCalled = false;

    const mockLockManager: LockManager = {
      async getLockInfo() {
        return null;
      },
      async isLocked() {
        return false;
      },
      async isLockedBy() {
        return false;
      },
      async lock() {
        throw new Error();
      },
      async unlock() {},
      async unlockAll(_user) {
        unlockAllCalled = true;
        return 1;
      },
    };

    const app = new Hono<Env>();
    app.onError(errorHandler);
    app.use("/api/*", jwt);
    app.use("*", async (c, next) => {
      c.set("lockManager", mockLockManager);
      await next();
    });
    app.route("/api/restful", authRoutes);

    const res = await app.request("/api/restful/logout", {
      method: "POST",
      headers: user.authHeaders,
    });

    expect(res.status).toBe(200);
    expect(unlockAllCalled).toBe(true);
  });
});
