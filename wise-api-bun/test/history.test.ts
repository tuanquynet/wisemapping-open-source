import { beforeEach, describe, expect, test } from "bun:test";

import { API, get, json, post, put } from "./helpers/client.ts";
import { createUser } from "./helpers/auth.ts";
import { createMap, SAMPLE_XML } from "./helpers/maps.ts";
import { resetDb } from "./helpers/db.ts";
import * as historyRepo from "../src/db/repos/history.ts";
import * as lockManager from "../src/services/lockManager.ts";

beforeEach(() => {
  resetDb();
  lockManager.clearAll();
});

const xmlWith = (text: string) =>
  `<map version="tango"><topic central="true" text="${text}"/></map>`;

describe("history", () => {
  test("each non-minor save appends an entry", async () => {
    const user = await createUser();
    const id = await createMap(user, "Versioned");

    for (const text of ["v1", "v2", "v3"]) {
      await put(`${API}/maps/${id}/document/xml`, {
        text: xmlWith(text),
        headers: user.authHeaders,
      });
    }

    const body = await json(
      get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
    );
    expect(body.count).toBe(3);
    expect(body.changes).toHaveLength(3);
    // The list key is `changes`, not `history`.
    expect(Object.keys(body).sort()).toEqual(["changes", "count"]);
  });

  test("entries carry id, creator and creationTime", async () => {
    const user = await createUser();
    const id = await createMap(user, "Entry Shape");
    await put(`${API}/maps/${id}/document/xml`, {
      text: SAMPLE_XML,
      headers: user.authHeaders,
    });

    const entry = (
      await json(
        get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
      )
    ).changes[0];
    expect(typeof entry.id).toBe("number");
    expect(entry.creator).toBe(user.email);
    expect(typeof entry.creationTime).toBe("string");
  });

  test("?minor=true suppresses the history entry", async () => {
    const user = await createUser();
    const id = await createMap(user, "Minor");

    await put(`${API}/maps/${id}/document?minor=true`, {
      headers: user.authHeaders,
      json: { xml: xmlWith("minor"), properties: "{}" },
    });
    expect(
      (
        await json(
          get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
        )
      ).count,
    ).toBe(0);

    // Without the flag, an entry appears.
    await put(`${API}/maps/${id}/document`, {
      headers: user.authHeaders,
      json: { xml: xmlWith("major"), properties: "{}" },
    });
    expect(
      (
        await json(
          get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
        )
      ).count,
    ).toBe(1);
  });

  test("is newest-first", async () => {
    const user = await createUser();
    const id = await createMap(user, "Ordering");
    for (const text of ["first", "second"]) {
      await put(`${API}/maps/${id}/document/xml`, {
        text: xmlWith(text),
        headers: user.authHeaders,
      });
    }

    const changes = (
      await json(
        get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
      )
    ).changes as { id: number }[];
    expect(changes[0]!.id).toBeGreaterThan(changes[1]!.id);
  });

  test("is capped at 30 entries", async () => {
    // MindmapManagerImpl.getHistoryFrom hardcodes setMaxResults(30).
    const user = await createUser();
    const id = await createMap(user, "Capped");

    for (let i = 0; i < 35; i++) {
      historyRepo.insert(id, 1, xmlWith(`v${i}`));
    }

    const body = await json(
      get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
    );
    expect(body.count).toBe(30);
    // The rows still exist; only the API view is capped.
    expect(historyRepo.countForMap(id)).toBe(35);
  });

  test("an entry older than the 30-cap is unreachable by id", async () => {
    // The Java findMindmapHistory(mapId, hid) linear-scans the already-capped
    // list, so older revisions cannot be fetched even though they exist.
    const user = await createUser();
    const id = await createMap(user, "Unreachable");

    for (let i = 0; i < 35; i++) {
      historyRepo.insert(id, 1, xmlWith(`v${i}`));
    }

    const all = historyRepo.countForMap(id);
    expect(all).toBe(35);

    // The oldest entry has the lowest id; it is outside the newest 30.
    const oldestId = 1;
    const res = await get(`${API}/maps/${id}/${oldestId}/document/xml`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test("a historical revision is served as raw XML", async () => {
    const user = await createUser();
    const id = await createMap(user, "Fetch Revision");
    await put(`${API}/maps/${id}/document/xml`, {
      text: xmlWith("saved"),
      headers: user.authHeaders,
    });

    const hid = (
      await json(
        get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
      )
    ).changes[0].id;

    const res = await get(`${API}/maps/${id}/${hid}/document/xml`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/xml; charset=UTF-8",
    );
    expect(await res.text()).toBe(xmlWith("saved"));
  });
});

describe("revert", () => {
  test("restores a specific revision AND appends a new entry", async () => {
    // revertChange -> updateMindmap(map, true) -> saveHistory. So reverting is
    // itself a recorded change.
    const user = await createUser();
    const id = await createMap(user, "Revert Specific");

    await put(`${API}/maps/${id}/document/xml`, {
      text: xmlWith("original"),
      headers: user.authHeaders,
    });
    await put(`${API}/maps/${id}/document/xml`, {
      text: xmlWith("changed"),
      headers: user.authHeaders,
    });

    const changes = (
      await json(
        get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
      )
    ).changes as { id: number }[];
    expect(changes).toHaveLength(2);
    const originalHid = changes[1]!.id;

    const res = await post(`${API}/maps/${id}/history/${originalHid}`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(204);

    const current = await (
      await get(`${API}/maps/${id}/document/xml`, { headers: user.authHeaders })
    ).text();
    expect(current).toBe(xmlWith("original"));

    // Three now: the revert recorded itself.
    expect(
      (
        await json(
          get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
        )
      ).count,
    ).toBe(3);
  });

  test('revert to "latest" does NOT append an entry', async () => {
    // Asymmetry from the Java source: the "latest" branch calls
    // saveMindmapDocument(true, ...) -> updateMindmap(map, false), so no history
    // is written -- the opposite of reverting to a specific id.
    const user = await createUser();
    const id = await createMap(user, "Revert Latest");

    await put(`${API}/maps/${id}/document/xml`, {
      text: xmlWith("saved"),
      headers: user.authHeaders,
    });
    expect(
      (
        await json(
          get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
        )
      ).count,
    ).toBe(1);

    const res = await post(`${API}/maps/${id}/history/latest`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(204);

    expect(
      (
        await json(
          get(`${API}/maps/${id}/history/`, { headers: user.authHeaders }),
        )
      ).count,
    ).toBe(1);
  });

  test('revert to "latest" with no history is a silent no-op', async () => {
    const user = await createUser();
    const id = await createMap(user, "No History");
    const res = await post(`${API}/maps/${id}/history/latest`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(204);
  });

  test("404s on an unknown revision id", async () => {
    const user = await createUser();
    const id = await createMap(user, "Bad Revision");
    expect(
      (
        await post(`${API}/maps/${id}/history/9999`, {
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(404);
  });

  test("requires editor permission", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const id = await createMap(owner, "Revert Perms");
    await post(`${API}/maps/${id}/collabs/`, {
      headers: owner.authHeaders,
      json: {
        collaborations: [{ email: viewer.email, role: "viewer" }],
        message: null,
      },
    });

    expect(
      (
        await post(`${API}/maps/${id}/history/latest`, {
          headers: viewer.authHeaders,
        })
      ).status,
    ).toBe(403);
  });
});
