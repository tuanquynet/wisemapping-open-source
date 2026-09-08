import { beforeEach, describe, expect, test } from "bun:test";

import { API, get, json } from "./helpers/client.ts";
import { createUser } from "./helpers/auth.ts";
import { resetDb } from "./helpers/db.ts";

beforeEach(() => resetDb());
describe("GET /api/restful/admin/users", () => {
  test("401s when not authenticated", async () => {
    const res = await get(`${API}/admin/users`);
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ msg: "Unauthorized" });
  });

  test("403s when authenticated as regular user", async () => {
    const user = await createUser();
    const res = await get(`${API}/admin/users`, { headers: user.authHeaders });
    expect(res.status).toBe(403);
  });

  test("returns paginated user list for admin", async () => {
    // ADMIN_EMAIL=admin@wisemapping.org in .env.test
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user1 = await createUser({ firstname: "Alice", lastname: "Smith" });
    const user2 = await createUser({ firstname: "Bob", lastname: "Jones" });

    const res = await get(`${API}/admin/users?pageSize=10&page=0`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.page).toBe(0);
    expect(body.pageSize).toBe(10);
    expect(body.totalElements).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(body.data)).toBe(true);

    const users = body.data as Array<Record<string, unknown>>;
    const foundAdmin = users.find(
      (u) => u.email === "admin@wisemapping.org",
    );
    expect(foundAdmin).toBeDefined();
    expect(foundAdmin?.isAdmin).toBe(true);
    expect(foundAdmin?.isActive).toBe(true);

    const foundUser1 = users.find((u) => u.email === user1.email);
    expect(foundUser1).toBeDefined();
    expect(foundUser1?.isAdmin).toBe(false);
    expect(foundUser1?.firstname).toBe("Alice");
    expect(foundUser1?.lastname).toBe("Smith");
  });

  test("supports search filtering", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const uniqueName = `SpecialAdminSearch${Bun.nanoseconds()}`;
    await createUser({ firstname: uniqueName });

    const res = await get(`${API}/admin/users?search=${uniqueName}`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.totalElements).toBe(1);
    expect(body.data.length).toBe(1);
    const users = body.data as Array<Record<string, unknown>>;
    expect(users[0]?.firstname).toBe(uniqueName);
  });

  test("supports sorting by email", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await get(
      `${API}/admin/users?pageSize=50&sortBy=email&sortOrder=asc`,
      { headers: admin.authHeaders },
    );
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(Array.isArray(body.data)).toBe(true);
    const users = body.data as Array<Record<string, unknown>>;
    const emails: string[] = users.map((u) => String(u.email ?? "").toLowerCase());
    const sorted = [...emails].sort();
    expect(emails).toEqual(sorted);
  });
});
