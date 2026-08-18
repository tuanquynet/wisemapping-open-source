import { beforeEach, describe, expect, test } from "bun:test";

import { API, del, get, json, post } from "./helpers/client.ts";
import { createUser } from "./helpers/auth.ts";
import { createMap } from "./helpers/maps.ts";
import { resetDb } from "./helpers/db.ts";
import * as lockManager from "../src/services/lockManager.ts";

beforeEach(() => {
  resetDb();
  lockManager.clearAll();
});

async function createLabel(
  user: Awaited<ReturnType<typeof createUser>>,
  title: string,
  color = "#ff0000",
): Promise<number> {
  const res = await post(`${API}/labels`, {
    headers: user.authHeaders,
    json: { title, color },
  });
  if (res.status !== 201) {
    throw new Error(`createLabel failed: ${res.status} ${await res.text()}`);
  }
  return Number(res.headers.get("ResourceId"));
}

describe("labels CRUD", () => {
  test("creates a label with Location and ResourceId", async () => {
    const user = await createUser();
    const res = await post(`${API}/labels`, {
      headers: user.authHeaders,
      json: { title: "Work", color: "#00ff00" },
    });

    expect(res.status).toBe(201);
    const id = res.headers.get("ResourceId");
    expect(id).toBe("1");
    expect(res.headers.get("Location")).toBe(`/api/restful/labels/${id}`);
  });

  test("returns `{labels: [...]}` with no count key", async () => {
    // RestLabelList has only getLabels(), unlike the other list DTOs which also
    // expose getCount().
    const user = await createUser();
    await createLabel(user, "Work");

    const body = await json(
      get(`${API}/labels/`, { headers: user.authHeaders }),
    );
    expect(Object.keys(body)).toEqual(["labels"]);
    expect(body.labels).toHaveLength(1);
  });

  test("label entries carry id, title, color and a null parent", async () => {
    const user = await createUser();
    await createLabel(user, "Personal", "#123456");

    const label = (
      await json(get(`${API}/labels/`, { headers: user.authHeaders }))
    ).labels[0];
    expect(label).toEqual({
      id: 1,
      title: "Personal",
      color: "#123456",
      // RestLabel has no @JsonInclude, so a null parent is serialised, not omitted.
      parent: null,
    });
  });

  test("a ?title= query parameter overrides the body title", async () => {
    const user = await createUser();
    const res = await post(`${API}/labels?title=FromQuery`, {
      headers: user.authHeaders,
      json: { title: "FromBody", color: "#000000" },
    });
    expect(res.status).toBe(201);

    const label = (
      await json(get(`${API}/labels/`, { headers: user.authHeaders }))
    ).labels[0];
    expect(label.title).toBe("FromQuery");
  });

  test("rejects a blank title and one over 30 characters", async () => {
    const user = await createUser();

    const blank = await post(`${API}/labels`, {
      headers: user.authHeaders,
      json: { title: "  ", color: "#000000" },
    });
    expect(blank.status).toBe(400);

    const long = await post(`${API}/labels`, {
      headers: user.authHeaders,
      json: { title: "x".repeat(31), color: "#000000" },
    });
    expect(long.status).toBe(400);
    expect((await json(long)).fieldErrors.title).toContain("30");
  });

  test("rejects a duplicate title for the same owner but allows it across owners", async () => {
    const a = await createUser();
    const b = await createUser();
    await createLabel(a, "Shared");

    const dup = await post(`${API}/labels`, {
      headers: a.authHeaders,
      json: { title: "Shared", color: "#000000" },
    });
    expect(dup.status).toBe(400);

    // Labels are per-owner, so the same title is fine for another account.
    expect(await createLabel(b, "Shared")).toBeGreaterThan(0);
  });

  test("labels are private to their owner", async () => {
    const a = await createUser();
    const b = await createUser();
    await createLabel(a, "A only");

    expect(
      (await json(get(`${API}/labels/`, { headers: b.authHeaders }))).labels,
    ).toHaveLength(0);
  });

  test("deletes a label", async () => {
    const user = await createUser();
    const id = await createLabel(user, "Temp");

    expect(
      (await del(`${API}/labels/${id}`, { headers: user.authHeaders })).status,
    ).toBe(204);
    expect(
      (await json(get(`${API}/labels/`, { headers: user.authHeaders }))).labels,
    ).toHaveLength(0);
  });

  test("cannot delete another user's label", async () => {
    const a = await createUser();
    const b = await createUser();
    const id = await createLabel(a, "Mine");

    // 404 rather than 403: reads are creator-scoped, so another user's label is
    // indistinguishable from one that does not exist.
    expect(
      (await del(`${API}/labels/${id}`, { headers: b.authHeaders })).status,
    ).toBe(404);
  });

  test("requires authentication", async () => {
    expect((await get(`${API}/labels/`)).status).toBe(401);
    expect((await post(`${API}/labels`, { json: { title: "X" } })).status).toBe(
      401,
    );
  });
});

describe("labels on maps", () => {
  test("attaches a label with a BARE integer body and returns 200", async () => {
    const user = await createUser();
    const mapId = await createMap(user, "Tagged");
    const labelId = await createLabel(user, "Important");

    // The Java handler is `@RequestBody int lid` -- the body is a bare JSON
    // integer, not an object.
    const res = await post(`${API}/maps/${mapId}/labels`, {
      raw: { body: String(labelId), contentType: "application/json" },
      headers: user.authHeaders,
    });
    expect(res.status).toBe(200);

    const list = await json(get(`${API}/maps/`, { headers: user.authHeaders }));
    expect(list.mindmapsInfo[0].labels).toHaveLength(1);
    expect(list.mindmapsInfo[0].labels[0].title).toBe("Important");
  });

  test("attaching twice is idempotent", async () => {
    const user = await createUser();
    const mapId = await createMap(user, "Twice");
    const labelId = await createLabel(user, "Dup");

    for (let i = 0; i < 2; i++) {
      const res = await post(`${API}/maps/${mapId}/labels`, {
        raw: { body: String(labelId), contentType: "application/json" },
        headers: user.authHeaders,
      });
      expect(res.status).toBe(200);
    }

    const list = await json(get(`${API}/maps/`, { headers: user.authHeaders }));
    expect(list.mindmapsInfo[0].labels).toHaveLength(1);
  });

  test("detaches a label from a map", async () => {
    const user = await createUser();
    const mapId = await createMap(user, "Detach");
    const labelId = await createLabel(user, "Removable");

    await post(`${API}/maps/${mapId}/labels`, {
      raw: { body: String(labelId), contentType: "application/json" },
      headers: user.authHeaders,
    });
    expect(
      (
        await del(`${API}/maps/${mapId}/labels/${labelId}`, {
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(204);

    const list = await json(get(`${API}/maps/`, { headers: user.authHeaders }));
    expect(list.mindmapsInfo[0].labels).toHaveLength(0);
  });

  test("deleting a label unlinks it WITHOUT deleting the maps", async () => {
    // The behaviour RestMindmapDeleteWithLabelsTest pins in the Java suite.
    const user = await createUser();
    const mapId = await createMap(user, "Survivor");
    const labelId = await createLabel(user, "Doomed Label");

    await post(`${API}/maps/${mapId}/labels`, {
      raw: { body: String(labelId), contentType: "application/json" },
      headers: user.authHeaders,
    });
    await del(`${API}/labels/${labelId}`, { headers: user.authHeaders });

    const res = await get(`${API}/maps/${mapId}`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(200);

    const list = await json(get(`${API}/maps/`, { headers: user.authHeaders }));
    expect(list.count).toBe(1);
    expect(list.mindmapsInfo[0].labels).toHaveLength(0);
  });

  test("404s when attaching an unknown or another user's label", async () => {
    const a = await createUser();
    const b = await createUser();
    const mapId = await createMap(a, "Label Perms");
    const otherLabel = await createLabel(b, "Theirs");

    expect(
      (
        await post(`${API}/maps/${mapId}/labels`, {
          raw: { body: "9999", contentType: "application/json" },
          headers: a.authHeaders,
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await post(`${API}/maps/${mapId}/labels`, {
          raw: { body: String(otherLabel), contentType: "application/json" },
          headers: a.authHeaders,
        })
      ).status,
    ).toBe(404);
  });

  test("q=<label title> filters the map list", async () => {
    const user = await createUser();
    const tagged = await createMap(user, "Tagged Map");
    await createMap(user, "Untagged Map");
    const labelId = await createLabel(user, "Focus");

    await post(`${API}/maps/${tagged}/labels`, {
      raw: { body: String(labelId), contentType: "application/json" },
      headers: user.authHeaders,
    });

    const body = await json(
      get(`${API}/maps/?q=Focus`, { headers: user.authHeaders }),
    );
    expect(body.count).toBe(1);
    expect(body.mindmapsInfo[0].id).toBe(tagged);
  });
});
