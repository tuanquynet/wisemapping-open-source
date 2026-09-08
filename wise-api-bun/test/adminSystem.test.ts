import { beforeEach, describe, expect, test } from "bun:test";

import { API, get, json } from "./helpers/client.ts";
import { createUser } from "./helpers/auth.ts";
import { createMap } from "./helpers/maps.ts";
import { resetDb } from "./helpers/db.ts";

beforeEach(() => resetDb());

describe("GET /api/restful/admin/system/health", () => {
  test("401s when not authenticated", async () => {
    const res = await get(`${API}/admin/system/health`);
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await get(`${API}/admin/system/health`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(403);
  });

  test("returns health status with database and memory keys", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await get(`${API}/admin/system/health`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.database).toBe("UP");
    expect(body.memory).toBe("UP");
    expect(typeof body.memoryUsagePercent).toBe("number");
  });
});

describe("GET /api/restful/admin/system/info", () => {
  test("401s when not authenticated", async () => {
    const res = await get(`${API}/admin/system/info`);
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await get(`${API}/admin/system/info`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(403);
  });

  test("returns system info with application, database, and stats", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user = await createUser({ email: "regular@example.org" });
    await createMap(user, "System Test Map");

    const res = await get(`${API}/admin/system/info`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.application).toBeDefined();
    expect(body.application.name).toBe("WiseMapping API");
    expect(body.database).toBeDefined();
    expect(body.statistics).toBeDefined();
    expect(body.statistics.totalUsers).toBeGreaterThanOrEqual(2);
    expect(body.statistics.totalMindmaps).toBeGreaterThanOrEqual(1);
  });
});
