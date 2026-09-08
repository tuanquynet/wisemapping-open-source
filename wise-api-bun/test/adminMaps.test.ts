import { beforeEach, describe, expect, test } from "bun:test";

import { API, get, json } from "./helpers/client.ts";
import { createUser } from "./helpers/auth.ts";
import { createMap } from "./helpers/maps.ts";
import { resetDb } from "./helpers/db.ts";

beforeEach(() => resetDb());

describe("GET /api/restful/admin/maps", () => {
  test("401s when not authenticated", async () => {
    const res = await get(`${API}/admin/maps`);
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await get(`${API}/admin/maps`, { headers: user.authHeaders });
    expect(res.status).toBe(403);
  });

  test("returns paginated list of all mindmaps for admin", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user1 = await createUser({ email: "user1@example.org" });
    const user2 = await createUser({ email: "user2@example.org" });

    await createMap(user1, "Alpha Map");
    await createMap(user2, "Beta Map");

    const res = await get(`${API}/admin/maps?pageSize=10&page=0`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.page).toBe(0);
    expect(body.pageSize).toBe(10);
    expect(body.totalElements).toBe(2);
    expect(body.totalPages).toBe(1);
    expect(Array.isArray(body.data)).toBe(true);

    const maps = body.data as Array<Record<string, unknown>>;
    expect(maps.length).toBe(2);
    const titles = maps.map((m) => m.title);
    expect(titles).toContain("Alpha Map");
    expect(titles).toContain("Beta Map");
  });

  test("supports keyword search across titles and descriptions", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user = await createUser();

    await createMap(user, "SearchTarget Alpha");
    await createMap(user, "Other Map");

    const res = await get(`${API}/admin/maps?search=SearchTarget`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.totalElements).toBe(1);
    const maps = body.data as Array<Record<string, unknown>>;
    expect(maps[0]?.title).toBe("SearchTarget Alpha");
  });

  test("supports sorting by title asc and desc", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user = await createUser();

    await createMap(user, "Cat Map");
    await createMap(user, "Apple Map");
    await createMap(user, "Banana Map");

    const ascRes = await get(`${API}/admin/maps?sortBy=title&sortOrder=asc`, {
      headers: admin.authHeaders,
    });
    expect(ascRes.status).toBe(200);
    const ascMaps = (await json(ascRes)).data as Array<Record<string, unknown>>;
    expect(ascMaps.map((m) => m.title)).toEqual(["Apple Map", "Banana Map", "Cat Map"]);

    const descRes = await get(`${API}/admin/maps?sortBy=title&sortOrder=desc`, {
      headers: admin.authHeaders,
    });
    expect(descRes.status).toBe(200);
    const descMaps = (await json(descRes)).data as Array<Record<string, unknown>>;
    expect(descMaps.map((m) => m.title)).toEqual(["Cat Map", "Banana Map", "Apple Map"]);
  });
});
