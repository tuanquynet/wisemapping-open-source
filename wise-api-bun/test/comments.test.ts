import { beforeEach, describe, expect, test } from "bun:test";

import { API, del, get, json, post, put } from "./helpers/client.ts";
import { createUser, type TestUser } from "./helpers/auth.ts";
import { createMap, share } from "./helpers/maps.ts";
import { resetDb } from "./helpers/db.ts";

beforeEach(() => {
  resetDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createComment(
  user: TestUser,
  mapId: number,
  topicId: string,
  body: string,
): Promise<Response> {
  return post(`${API}/maps/${mapId}/comments`, {
    headers: user.authHeaders,
    json: { topicId, body },
  });
}

// ---------------------------------------------------------------------------
// List comments
// ---------------------------------------------------------------------------

describe("GET /maps/:id/comments", () => {
  test("returns empty list when no comments exist", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Empty Comments");

    const res = await get(`${API}/maps/${mapId}/comments`, {
      headers: owner.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.count).toBe(0);
    expect(body.comments).toEqual([]);
  });

  test("returns all comments sorted by createdAt ASC, id ASC", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Sorted Comments");

    await createComment(owner, mapId, "t-1", "First");
    await createComment(owner, mapId, "t-2", "Second");
    await createComment(owner, mapId, "t-1", "Third");

    const body = await json(
      get(`${API}/maps/${mapId}/comments`, { headers: owner.authHeaders }),
    );

    expect(body.count).toBe(3);
    expect(body.comments[0].body).toBe("First");
    expect(body.comments[1].body).toBe("Second");
    expect(body.comments[2].body).toBe("Third");
  });

  test("filters by topicId when query param is provided", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Filtered Comments");

    await createComment(owner, mapId, "t-1", "On topic 1");
    await createComment(owner, mapId, "t-2", "On topic 2");
    await createComment(owner, mapId, "t-1", "Also on topic 1");

    const body = await json(
      get(`${API}/maps/${mapId}/comments?topicId=t-1`, {
        headers: owner.authHeaders,
      }),
    );

    expect(body.count).toBe(2);
    expect(body.comments.every((c: Record<string, unknown>) => c.topicId === "t-1")).toBe(true);
  });

  test("includes author metadata in each comment", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Author Meta");

    await createComment(owner, mapId, "t-1", "Hello");

    const body = await json(
      get(`${API}/maps/${mapId}/comments`, { headers: owner.authHeaders }),
    );

    const comment = body.comments[0];
    expect(comment.author).toBeDefined();
    expect(comment.author.email).toBe(owner.email);
    expect(typeof comment.author.firstname).toBe("string");
    expect(typeof comment.author.lastname).toBe("string");
    expect(typeof comment.createdAt).toBe("string");
  });

  test("viewer can list comments", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const mapId = await createMap(owner, "Viewer Reads");

    await share(owner, mapId, viewer.email, "viewer");
    await createComment(owner, mapId, "t-1", "A comment");

    const res = await get(`${API}/maps/${mapId}/comments`, {
      headers: viewer.authHeaders,
    });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.count).toBe(1);
  });

  test("returns 404 for non-existent map", async () => {
    const owner = await createUser();
    const res = await get(`${API}/maps/99999/comments`, {
      headers: owner.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test("returns 403 for unauthenticated access to private map", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Private Map");

    // Private map: unauthenticated user has no collaboration → 403 (not 401,
    // because requireMapAccess("viewer") only returns 401 when required > viewer).
    const res = await get(`${API}/maps/${mapId}/comments`);
    expect(res.status).toBe(403);
  });

  test("returns 403 when user has no access to a private map", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const mapId = await createMap(owner, "No Access Map");

    const res = await get(`${API}/maps/${mapId}/comments`, {
      headers: stranger.authHeaders,
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Create comment
// ---------------------------------------------------------------------------

describe("POST /maps/:id/comments", () => {
  test("owner can create a comment and gets 201 with Location and ResourceId", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Create Comment Map");

    const res = await createComment(owner, mapId, "t-1", "Great node");
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toContain(`/maps/${mapId}/comments/`);
    expect(res.headers.get("ResourceId")).toBeTruthy();

    const body = await res.json() as Record<string, unknown>;
    expect(body.body).toBe("Great node");
    expect(body.topicId).toBe("t-1");
    expect(body.author).toBeDefined();
  });

  test("editor can create a comment", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const mapId = await createMap(owner, "Editor Comment Map");

    await share(owner, mapId, editor.email, "editor");

    const res = await createComment(editor, mapId, "t-2", "Editor says hi");
    expect(res.status).toBe(201);
  });

  test("viewer cannot create a comment — 403", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const mapId = await createMap(owner, "Viewer Cannot Post");

    await share(owner, mapId, viewer.email, "viewer");

    const res = await createComment(viewer, mapId, "t-1", "Try posting");
    expect(res.status).toBe(403);
  });

  test("unauthenticated request returns 401", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Unauth Post");

    const res = await post(`${API}/maps/${mapId}/comments`, {
      json: { topicId: "t-1", body: "Sneaky" },
    });
    expect(res.status).toBe(401);
  });

  test("missing topicId returns 400", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Bad Payload");

    const res = await post(`${API}/maps/${mapId}/comments`, {
      headers: owner.authHeaders,
      json: { body: "No topicId here" },
    });
    expect(res.status).toBe(400);
  });

  test("missing body returns 400", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Missing Body");

    const res = await post(`${API}/maps/${mapId}/comments`, {
      headers: owner.authHeaders,
      json: { topicId: "t-1" },
    });
    expect(res.status).toBe(400);
  });

  test("blank body (whitespace only) returns 400", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Blank Body");

    const res = await createComment(owner, mapId, "t-1", "   ");
    expect(res.status).toBe(400);
  });

  test("returns 404 for non-existent map", async () => {
    const owner = await createUser();
    const res = await post(`${API}/maps/99999/comments`, {
      headers: owner.authHeaders,
      json: { topicId: "t-1", body: "Ghost" },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Delete comment
// ---------------------------------------------------------------------------

describe("DELETE /maps/:id/comments/:commentId", () => {
  test("comment author can delete their own comment — 204", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const mapId = await createMap(owner, "Author Deletes");

    await share(owner, mapId, editor.email, "editor");

    const createRes = await createComment(editor, mapId, "t-1", "Delete me");
    const commentId = createRes.headers.get("ResourceId");
    expect(createRes.status).toBe(201);

    const delRes = await del(
      `${API}/maps/${mapId}/comments/${commentId}`,
      { headers: editor.authHeaders },
    );
    expect(delRes.status).toBe(204);

    // Confirm it is gone.
    const list = await json(
      get(`${API}/maps/${mapId}/comments`, { headers: owner.authHeaders }),
    );
    expect(list.count).toBe(0);
  });

  test("map owner can delete any comment — 204", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const mapId = await createMap(owner, "Owner Deletes");

    await share(owner, mapId, editor.email, "editor");

    const createRes = await createComment(editor, mapId, "t-1", "Owner deletes this");
    const commentId = createRes.headers.get("ResourceId");

    const delRes = await del(
      `${API}/maps/${mapId}/comments/${commentId}`,
      { headers: owner.authHeaders },
    );
    expect(delRes.status).toBe(204);
  });

  test("another editor (non-author, non-owner) gets 403", async () => {
    const owner = await createUser();
    const editor1 = await createUser();
    const editor2 = await createUser();
    const mapId = await createMap(owner, "Non-author Forbidden");

    // Use PUT /collabs/ to add both editors additively (POST /collabs/ replaces).
    await put(`${API}/maps/${mapId}/collabs`, {
      headers: owner.authHeaders,
      json: {
        collaborations: [
          { email: editor1.email, role: "editor" },
          { email: editor2.email, role: "editor" },
        ],
        message: null,
      },
    });

    const createRes = await createComment(editor1, mapId, "t-1", "I wrote this");
    expect(createRes.status).toBe(201);
    const commentId = createRes.headers.get("ResourceId");

    const delRes = await del(
      `${API}/maps/${mapId}/comments/${commentId}`,
      { headers: editor2.authHeaders },
    );
    expect(delRes.status).toBe(403);
  });

  test("viewer gets 403 trying to delete", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const mapId = await createMap(owner, "Viewer Delete Forbidden");

    await share(owner, mapId, viewer.email, "viewer");

    const createRes = await createComment(owner, mapId, "t-1", "Owner's comment");
    const commentId = createRes.headers.get("ResourceId");

    const delRes = await del(
      `${API}/maps/${mapId}/comments/${commentId}`,
      { headers: viewer.authHeaders },
    );
    expect(delRes.status).toBe(403);
  });

  test("unauthenticated request returns 401", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Unauth Delete");

    const createRes = await createComment(owner, mapId, "t-1", "A comment");
    const commentId = createRes.headers.get("ResourceId");

    const delRes = await del(`${API}/maps/${mapId}/comments/${commentId}`);
    expect(delRes.status).toBe(401);
  });

  test("deleting non-existent comment returns 404", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Delete 404");

    const delRes = await del(
      `${API}/maps/${mapId}/comments/99999`,
      { headers: owner.authHeaders },
    );
    expect(delRes.status).toBe(404);
  });

  test("deleting comment on a different map returns 404", async () => {
    const owner = await createUser();
    const map1 = await createMap(owner, "Map One");
    const map2 = await createMap(owner, "Map Two");

    const createRes = await createComment(owner, map1, "t-1", "On map 1");
    const commentId = createRes.headers.get("ResourceId");

    // Attempt to delete via map2 which doesn't own this comment.
    const delRes = await del(
      `${API}/maps/${map2}/comments/${commentId}`,
      { headers: owner.authHeaders },
    );
    expect(delRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Cascade delete on map removal
// ---------------------------------------------------------------------------

describe("cascade delete — map deletion removes comments", () => {
  test("deleting a map deletes all its comments", async () => {
    const owner = await createUser();
    const mapId = await createMap(owner, "Cascade Map");

    await createComment(owner, mapId, "t-1", "Comment A");
    await createComment(owner, mapId, "t-2", "Comment B");

    // Verify they exist.
    const before = await json(
      get(`${API}/maps/${mapId}/comments`, { headers: owner.authHeaders }),
    );
    expect(before.count).toBe(2);

    // Delete the map.
    const delMap = await del(`${API}/maps/${mapId}`, {
      headers: owner.authHeaders,
    });
    expect(delMap.status).toBe(204);

    // Comments are gone — verified by listing on the now-deleted map (404).
    const after = await get(`${API}/maps/${mapId}/comments`, {
      headers: owner.authHeaders,
    });
    expect(after.status).toBe(404);
  });
});
