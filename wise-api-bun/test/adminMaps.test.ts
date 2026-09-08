import { beforeEach, describe, expect, test } from "bun:test";

import { API, del, get, json, put } from "./helpers/client.ts";
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
describe("GET /api/restful/admin/users/:id/maps", () => {
  test("401s when not authenticated", async () => {
    const res = await get(`${API}/admin/users/1/maps`);
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await get(`${API}/admin/users/1/maps`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(403);
  });

  test("404s when user does not exist", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await get(`${API}/admin/users/999999/maps`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test("returns array of maps created by user", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user1 = await createUser({ email: "creator1@example.org" });
    const user2 = await createUser({ email: "creator2@example.org" });

    await createMap(user1, "User1 Map A");
    await createMap(user1, "User1 Map B");
    await createMap(user2, "User2 Map C");

    const listRes = await get(`${API}/admin/users?search=creator1@example.org`, {
      headers: admin.authHeaders,
    });
    const users = (await json(listRes)).data as Array<Record<string, unknown>>;
    const user1Id = Number(users[0]?.id);

    const res = await get(`${API}/admin/users/${user1Id}/maps`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = (await json(res)) as unknown as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    const titles = body.map((m) => m.title);
    expect(titles).toContain("User1 Map A");
    expect(titles).toContain("User1 Map B");
    expect(titles).not.toContain("User2 Map C");
  });
});

describe("GET /api/restful/admin/maps/:id/xml", () => {
  test("401s when not authenticated", async () => {
    const res = await get(`${API}/admin/maps/1/xml`);
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await get(`${API}/admin/maps/1/xml`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(403);
  });

  test("404s when map does not exist", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await get(`${API}/admin/maps/999999/xml`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test("returns application/xml content for valid map", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user = await createUser();
    const mapId = await createMap(user, "XML Inspection Map");

    const res = await get(`${API}/admin/maps/${mapId}/xml`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<map");
    expect(xml).toContain("</map>");
  });
});

describe("PUT /api/restful/admin/maps/:id", () => {
  test("401s when not authenticated", async () => {
    const res = await put(`${API}/admin/maps/1`, { json: { title: "New" } });
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await put(`${API}/admin/maps/1`, {
      headers: user.authHeaders,
      json: { title: "New" },
    });
    expect(res.status).toBe(403);
  });

  test("404s when map does not exist", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await put(`${API}/admin/maps/999999`, {
      headers: admin.authHeaders,
      json: { title: "New" },
    });
    expect(res.status).toBe(404);
  });

  test("updates map title, description, and isPublic", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user = await createUser();
    const mapId = await createMap(user, "Initial Title");

    const res = await put(`${API}/admin/maps/${mapId}`, {
      headers: admin.authHeaders,
      json: {
        title: "Updated Title by Admin",
        description: "Admin modified description",
        isPublic: true,
      },
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.title).toBe("Updated Title by Admin");
    expect(body.description).toBe("Admin modified description");
    expect(body.isPublic).toBe(true);
  });
});

describe("DELETE /api/restful/admin/maps/:id", () => {
  test("401s when not authenticated", async () => {
    const res = await del(`${API}/admin/maps/1`);
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await del(`${API}/admin/maps/1`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(403);
  });

  test("404s when map does not exist", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await del(`${API}/admin/maps/999999`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test("deletes mindmap and cascades records returning 204", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user = await createUser();
    const mapId = await createMap(user, "Map To Be Deleted");

    const res = await del(`${API}/admin/maps/${mapId}`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(204);

    // Map should no longer exist
    const getRes = await get(`${API}/admin/maps/${mapId}/xml`, {
      headers: admin.authHeaders,
    });
    expect(getRes.status).toBe(404);
  });
});
