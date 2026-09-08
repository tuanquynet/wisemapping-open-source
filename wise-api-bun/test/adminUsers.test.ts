import { beforeEach, describe, expect, test } from "bun:test";

import { API, del, get, json, post, put } from "./helpers/client.ts";
import { createUser } from "./helpers/auth.ts";
import { resetDb } from "./helpers/db.ts";
import * as accounts from "../src/db/repos/accounts.ts";

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

describe("GET /api/restful/admin/users/:id", () => {
  test("401s when not authenticated", async () => {
    const res = await get(`${API}/admin/users/1`);
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ msg: "Unauthorized" });
  });

  test("403s when authenticated as regular user", async () => {
    const user = await createUser();
    const res = await get(`${API}/admin/users/1`, { headers: user.authHeaders });
    expect(res.status).toBe(403);
  });

  test("404s when user does not exist", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await get(`${API}/admin/users/999999`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test("returns user details for valid ID", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const target = await createUser({
      firstname: "Bob",
      lastname: "Builder",
      email: "bob@example.org",
    });

    // Get target's ID from admin user list first
    const listRes = await get(`${API}/admin/users?search=bob@example.org`, {
      headers: admin.authHeaders,
    });
    const listBody = await json(listRes);
    const users = listBody.data as Array<Record<string, unknown>>;
    const targetId = Number(users[0]?.id);
    expect(targetId).toBeGreaterThan(0);

    const res = await get(`${API}/admin/users/${targetId}`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.id).toBe(targetId);
    expect(body.email).toBe("bob@example.org");
    expect(body.firstname).toBe("Bob");
    expect(body.lastname).toBe("Builder");
    expect(body.fullName).toBe("Bob Builder");
    expect(body.isActive).toBe(true);
    expect(body.isAdmin).toBe(false);
  });
});

describe("GET /api/restful/admin/users/email/:email", () => {
  test("401s when not authenticated", async () => {
    const res = await get(`${API}/admin/users/email/test@example.org`);
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ msg: "Unauthorized" });
  });

  test("403s when authenticated as regular user", async () => {
    const user = await createUser();
    const res = await get(`${API}/admin/users/email/test@example.org`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(403);
  });

  test("404s when user email does not exist", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await get(`${API}/admin/users/email/nonexistent@example.org`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test("returns user details for valid email", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    await createUser({
      firstname: "Carol",
      lastname: "Danvers",
      email: "carol@example.org",
    });

    const res = await get(`${API}/admin/users/email/carol@example.org`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.email).toBe("carol@example.org");
    expect(body.firstname).toBe("Carol");
    expect(body.lastname).toBe("Danvers");
    expect(body.fullName).toBe("Carol Danvers");
    expect(body.isActive).toBe(true);
    expect(body.isAdmin).toBe(false);
  });
});

describe("POST /api/restful/admin/users", () => {
  test("401s when not authenticated", async () => {
    const res = await post(`${API}/admin/users`, {
      json: {
        email: "newuser@example.org",
        firstname: "New",
        lastname: "User",
        password: "password123",
      },
    });
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await post(`${API}/admin/users`, {
      headers: user.authHeaders,
      json: {
        email: "newuser@example.org",
        firstname: "New",
        lastname: "User",
        password: "password123",
      },
    });
    expect(res.status).toBe(403);
  });

  test("creates an immediately active user and returns 201 with headers", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await post(`${API}/admin/users`, {
      headers: admin.authHeaders,
      json: {
        email: "createdbyadmin@example.org",
        firstname: "AdminCreated",
        lastname: "Person",
        password: "securePassword123",
      },
    });
    expect(res.status).toBe(201);

    const resourceId = res.headers.get("ResourceId");
    expect(resourceId).toBeDefined();
    expect(res.headers.get("Location")).toBe(`/api/restful/admin/users/${resourceId}`);

    // Fetch user and verify they are immediately active
    const getRes = await get(`${API}/admin/users/${resourceId}`, {
      headers: admin.authHeaders,
    });
    expect(getRes.status).toBe(200);
    const body = await json(getRes);
    expect(body.email).toBe("createdbyadmin@example.org");
    expect(body.firstname).toBe("AdminCreated");
    expect(body.lastname).toBe("Person");
    expect(body.isActive).toBe(true);
  });

  test("rejects duplicate email with 400", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    await createUser({ email: "existing@example.org" });

    const res = await post(`${API}/admin/users`, {
      headers: admin.authHeaders,
      json: {
        email: "existing@example.org",
        firstname: "Duplicate",
        lastname: "Person",
        password: "password123",
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/restful/admin/users/:id", () => {
  test("401s when not authenticated", async () => {
    const res = await del(`${API}/admin/users/1`);
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await del(`${API}/admin/users/1`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(403);
  });

  test("404s when user does not exist", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await del(`${API}/admin/users/999999`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test("deletes user and cascades associated maps", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user = await createUser({ email: "tobedeleted@example.org" });

    const listRes = await get(`${API}/admin/users?search=tobedeleted@example.org`, {
      headers: admin.authHeaders,
    });
    const listBody = await json(listRes);
    const users = listBody.data as Array<Record<string, unknown>>;
    const userId = Number(users[0]?.id);
    expect(userId).toBeGreaterThan(0);

    const delRes = await del(`${API}/admin/users/${userId}`, {
      headers: admin.authHeaders,
    });
    expect(delRes.status).toBe(204);

    // User should no longer exist
    const verifyRes = await get(`${API}/admin/users/${userId}`, {
      headers: admin.authHeaders,
    });
    expect(verifyRes.status).toBe(404);
  });
});

describe("PUT /api/restful/admin/users/:id", () => {
  test("401s when not authenticated", async () => {
    const res = await put(`${API}/admin/users/1`, {
      json: { firstname: "NewName" },
    });
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await put(`${API}/admin/users/1`, {
      headers: user.authHeaders,
      json: { firstname: "NewName" },
    });
    expect(res.status).toBe(403);
  });

  test("404s when user does not exist", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await put(`${API}/admin/users/999999`, {
      headers: admin.authHeaders,
      json: { firstname: "NewName" },
    });
    expect(res.status).toBe(404);
  });

  test("updates user profile fields and returns updated RestUser", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const user = await createUser({
      firstname: "OldFirst",
      lastname: "OldLast",
      email: "modtest@example.org",
    });

    const listRes = await get(`${API}/admin/users?search=modtest@example.org`, {
      headers: admin.authHeaders,
    });
    const users = (await json(listRes)).data as Array<Record<string, unknown>>;
    const userId = Number(users[0]?.id);

    const res = await put(`${API}/admin/users/${userId}`, {
      headers: admin.authHeaders,
      json: {
        firstname: "UpdatedFirst",
        lastname: "UpdatedLast",
        email: "updatedemail@example.org",
        locale: "es",
      },
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.firstname).toBe("UpdatedFirst");
    expect(body.lastname).toBe("UpdatedLast");
    expect(body.email).toBe("updatedemail@example.org");
    expect(body.fullName).toBe("UpdatedFirst UpdatedLast");
    expect(body.locale).toBe("es");
  });

  test("rejects email change if already taken by another user with 400", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    await createUser({ email: "user1@example.org" });
    const user2 = await createUser({ email: "user2@example.org" });

    const listRes = await get(`${API}/admin/users?search=user2@example.org`, {
      headers: admin.authHeaders,
    });
    const users = (await json(listRes)).data as Array<Record<string, unknown>>;
    const user2Id = Number(users[0]?.id);

    const res = await put(`${API}/admin/users/${user2Id}`, {
      headers: admin.authHeaders,
      json: {
        email: "user1@example.org",
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/restful/admin/users/:id/password", () => {
  test("401s when not authenticated", async () => {
    const res = await put(`${API}/admin/users/1/password`, {
      text: "newpassword123",
    });
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await put(`${API}/admin/users/1/password`, {
      headers: user.authHeaders,
      text: "newpassword123",
    });
    expect(res.status).toBe(403);
  });

  test("updates password successfully with text/plain body returning 204", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    await createUser({ email: "pwtest@example.org", password: "oldpassword123" });

    const listRes = await get(`${API}/admin/users?search=pwtest@example.org`, {
      headers: admin.authHeaders,
    });
    const users = (await json(listRes)).data as Array<Record<string, unknown>>;
    const userId = Number(users[0]?.id);

    const res = await put(`${API}/admin/users/${userId}/password`, {
      headers: admin.authHeaders,
      text: "newSecurePassword456",
    });
    expect(res.status).toBe(204);

    // User should be able to log in with new password
    const loginRes = await post(`${API}/authenticate`, {
      json: { email: "pwtest@example.org", password: "newSecurePassword456" },
    });
    expect(loginRes.status).toBe(200);
  });

  test("rejects password shorter than 8 chars with 400", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const res = await put(`${API}/admin/users/1/password`, {
      headers: admin.authHeaders,
      text: "short",
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/restful/admin/users/:id/activate", () => {
  test("401s when not authenticated", async () => {
    const res = await put(`${API}/admin/users/1/activate`);
    expect(res.status).toBe(401);
  });

  test("403s when authenticated as non-admin", async () => {
    const user = await createUser();
    const res = await put(`${API}/admin/users/1/activate`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(403);
  });

  test("activates an inactive user returning 204", async () => {
    const admin = await createUser({ email: "admin@wisemapping.org" });
    // Insert inactive user directly in database
    const account = await accounts.createOrUpgrade({
      email: "inactive@example.org",
      firstname: "Inactive",
      lastname: "User",
      passwordHash: "hash",
      locale: null,
      activationCode: "dummyCode12345678901",
      activatedAt: null,
    });
    expect(account.activatedAt).toBeNull();

    const res = await put(`${API}/admin/users/${account.id}/activate`, {
      headers: admin.authHeaders,
    });
    expect(res.status).toBe(204);

    // Check that user is active now
    const getRes = await get(`${API}/admin/users/${account.id}`, {
      headers: admin.authHeaders,
    });
    const body = await json(getRes);
    expect(body.isActive).toBe(true);
  });
});
