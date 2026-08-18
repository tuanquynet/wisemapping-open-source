import { beforeEach, describe, expect, test } from "bun:test";

import { API, del, get, json, post, put } from "./helpers/client.ts";
import { createUser, login } from "./helpers/auth.ts";
import { createMap, share, SAMPLE_XML } from "./helpers/maps.ts";
import { resetDb } from "./helpers/db.ts";
import * as lockManager from "../src/services/lockManager.ts";

beforeEach(() => {
  resetDb();
  lockManager.clearAll();
});

describe("sharing (POST /maps/{id}/collabs/)", () => {
  test("grants an editor write access but not publish", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const id = await createMap(owner, "Collab", { xml: SAMPLE_XML });

    expect((await share(owner, id, editor.email, "editor")).status).toBe(204);

    // Editor can read and write the document...
    expect(
      (await get(`${API}/maps/${id}`, { headers: editor.authHeaders })).status,
    ).toBe(200);
    expect(
      (
        await put(`${API}/maps/${id}/document/xml`, {
          text: SAMPLE_XML,
          headers: editor.authHeaders,
        })
      ).status,
    ).toBe(200);

    // ...but publishing is owner-only.
    expect(
      (
        await put(`${API}/maps/${id}/publish`, {
          headers: editor.authHeaders,
          json: { isPublic: true },
        })
      ).status,
    ).toBe(403);
  });

  test("a viewer can read but not write", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const id = await createMap(owner, "ReadOnly", { xml: SAMPLE_XML });
    await share(owner, id, viewer.email, "viewer");

    expect(
      (await get(`${API}/maps/${id}`, { headers: viewer.authHeaders })).status,
    ).toBe(200);
    expect(
      (
        await put(`${API}/maps/${id}/document/xml`, {
          text: SAMPLE_XML,
          headers: viewer.authHeaders,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await put(`${API}/maps/${id}/title`, {
          text: "Nope",
          headers: viewer.authHeaders,
        })
      ).status,
    ).toBe(403);
  });

  test("returns the collaboration list with the owner included", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const id = await createMap(owner, "List Collabs");
    await share(owner, id, editor.email, "editor");

    const body = await json(
      get(`${API}/maps/${id}/collabs`, { headers: owner.authHeaders }),
    );

    expect(body.count).toBe(2);
    expect(body.message).toBeNull();
    const byEmail = Object.fromEntries(
      (body.collaborations as { email: string; role: string }[]).map((x) => [
        x.email,
        x.role,
      ]),
    );
    expect(byEmail[owner.email]).toBe("owner");
    expect(byEmail[editor.email]).toBe("editor");
  });

  test("POST replaces the set, removing anyone omitted", async () => {
    const owner = await createUser();
    const a = await createUser();
    const b = await createUser();
    const id = await createMap(owner, "Replace");

    await post(`${API}/maps/${id}/collabs/`, {
      headers: owner.authHeaders,
      json: {
        collaborations: [
          { email: a.email, role: "editor" },
          { email: b.email, role: "viewer" },
        ],
        message: null,
      },
    });
    expect(
      (
        await json(
          get(`${API}/maps/${id}/collabs`, { headers: owner.authHeaders }),
        )
      ).count,
    ).toBe(3);

    // Now send only `a`: `b` must be dropped, owner must survive.
    await post(`${API}/maps/${id}/collabs/`, {
      headers: owner.authHeaders,
      json: {
        collaborations: [{ email: a.email, role: "editor" }],
        message: null,
      },
    });

    const after = await json(
      get(`${API}/maps/${id}/collabs`, { headers: owner.authHeaders }),
    );
    const emails = (after.collaborations as { email: string }[]).map(
      (x) => x.email,
    );
    expect(emails).toContain(owner.email);
    expect(emails).toContain(a.email);
    expect(emails).not.toContain(b.email);
    expect(
      (await get(`${API}/maps/${id}`, { headers: b.authHeaders })).status,
    ).toBe(403);
  });

  test("PUT adds or changes roles without removing anyone", async () => {
    const owner = await createUser();
    const a = await createUser();
    const b = await createUser();
    const id = await createMap(owner, "Additive");

    await share(owner, id, a.email, "viewer");
    await put(`${API}/maps/${id}/collabs/`, {
      headers: owner.authHeaders,
      json: {
        collaborations: [{ email: b.email, role: "editor" }],
        message: null,
      },
    });

    // `a` is still there -- PUT is additive, unlike POST.
    const body = await json(
      get(`${API}/maps/${id}/collabs`, { headers: owner.authHeaders }),
    );
    expect(body.count).toBe(3);

    // Role change on an existing collaborator.
    await put(`${API}/maps/${id}/collabs/`, {
      headers: owner.authHeaders,
      json: {
        collaborations: [{ email: a.email, role: "editor" }],
        message: null,
      },
    });
    const roles = Object.fromEntries(
      (
        (
          await json(
            get(`${API}/maps/${id}/collabs`, { headers: owner.authHeaders }),
          )
        ).collaborations as { email: string; role: string }[]
      ).map((x) => [x.email, x.role]),
    );
    expect(roles[a.email]).toBe("editor");
  });

  test("rejects granting the owner role", async () => {
    const owner = await createUser();
    const other = await createUser();
    const id = await createMap(owner, "NoOwnerGrant");

    const res = await post(`${API}/maps/${id}/collabs/`, {
      headers: owner.authHeaders,
      json: {
        collaborations: [{ email: other.email, role: "owner" }],
        message: null,
      },
    });
    expect(res.status).toBe(409);
  });

  test("rejects an invalid email with a field error", async () => {
    const owner = await createUser();
    const id = await createMap(owner, "BadEmail");

    const res = await post(`${API}/maps/${id}/collabs/`, {
      headers: owner.authHeaders,
      json: {
        collaborations: [{ email: "not-an-email", role: "editor" }],
        message: null,
      },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).fieldErrors.email).toContain("Invalid email");
  });

  test("rejects an unknown role", async () => {
    const owner = await createUser();
    const other = await createUser();
    const id = await createMap(owner, "BadRole");

    const res = await post(`${API}/maps/${id}/collabs/`, {
      headers: owner.authHeaders,
      json: {
        collaborations: [{ email: other.email, role: "admin" }],
        message: null,
      },
    });
    expect(res.status).toBe(400);
  });

  test("only the owner may change collaborators", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const third = await createUser();
    const id = await createMap(owner, "OwnerGate");
    await share(owner, id, editor.email, "editor");

    // 403, not the 400 the Java IllegalArgumentException produces. Documented
    // divergence: an editor attempting to re-share is a permission failure.
    const res = await share(editor, id, third.email, "viewer");
    expect(res.status).toBe(403);
  });

  test("DELETE /collabs?email= removes one collaborator", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const id = await createMap(owner, "RemoveOne");
    await share(owner, id, editor.email, "editor");

    expect(
      (
        await del(
          `${API}/maps/${id}/collabs?email=${encodeURIComponent(editor.email)}`,
          {
            headers: owner.authHeaders,
          },
        )
      ).status,
    ).toBe(204);
    expect(
      (await get(`${API}/maps/${id}`, { headers: editor.authHeaders })).status,
    ).toBe(403);
  });

  test("refuses to remove the owner collaboration", async () => {
    const owner = await createUser();
    const id = await createMap(owner, "KeepOwner");

    const res = await del(
      `${API}/maps/${id}/collabs?email=${encodeURIComponent(owner.email)}`,
      { headers: owner.authHeaders },
    );
    expect(res.status).toBe(409);
  });

  test("removing a nonexistent collaborator is a silent no-op", async () => {
    const owner = await createUser();
    const id = await createMap(owner, "NoopRemove");
    const res = await del(
      `${API}/maps/${id}/collabs?email=nobody@example.org`,
      {
        headers: owner.authHeaders,
      },
    );
    expect(res.status).toBe(204);
  });
});

describe("sharing with an unregistered email", () => {
  test("creates a placeholder, and registration inherits the shared map", async () => {
    const owner = await createUser();
    const id = await createMap(owner, "Invite", { xml: SAMPLE_XML });

    expect(
      (await share(owner, id, "newcomer@example.org", "editor")).status,
    ).toBe(204);

    // The invitee now registers with that address.
    const reg = await post(`${API}/users/`, {
      json: {
        email: "newcomer@example.org",
        firstname: "New",
        lastname: "Comer",
        password: "password123",
        acceptedTerms: true,
      },
    });
    expect(reg.status).toBe(201);

    const token = await login("newcomer@example.org", "password123");
    const headers = { Authorization: `Bearer ${token}` };

    // The collaboration granted before signup survived, because registration
    // upgraded the placeholder row instead of inserting a new account.
    const list = await json(get(`${API}/maps/`, { headers }));
    expect(list.count).toBe(1);
    expect(list.mindmapsInfo[0].id).toBe(id);
    expect(list.mindmapsInfo[0].role).toBe("editor");
  });
});

describe("starred (per-user state)", () => {
  test("is text/plain in both directions", async () => {
    const user = await createUser();
    const id = await createMap(user, "Star");

    const initial = await get(`${API}/maps/${id}/starred`, {
      headers: user.authHeaders,
    });
    expect(initial.headers.get("Content-Type")).toContain("text/plain");
    expect(await initial.text()).toBe("false");

    expect(
      (
        await put(`${API}/maps/${id}/starred`, {
          text: "true",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(204);
    expect(
      await (
        await get(`${API}/maps/${id}/starred`, { headers: user.authHeaders })
      ).text(),
    ).toBe("true");
  });

  test('treats any non-"true" value as false, like Boolean.parseBoolean', async () => {
    const user = await createUser();
    const id = await createMap(user, "ParseBool");

    await put(`${API}/maps/${id}/starred`, {
      text: "true",
      headers: user.authHeaders,
    });
    await put(`${API}/maps/${id}/starred`, {
      text: "yes",
      headers: user.authHeaders,
    });
    expect(
      await (
        await get(`${API}/maps/${id}/starred`, { headers: user.authHeaders })
      ).text(),
    ).toBe("false");
  });

  test("is independent per user", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const id = await createMap(owner, "PerUserStar");
    await share(owner, id, editor.email, "editor");

    await put(`${API}/maps/${id}/starred`, {
      text: "true",
      headers: editor.authHeaders,
    });

    expect(
      await (
        await get(`${API}/maps/${id}/starred`, { headers: editor.authHeaders })
      ).text(),
    ).toBe("true");
    // Starring is collaboration-scoped, so the owner's view is unaffected.
    expect(
      await (
        await get(`${API}/maps/${id}/starred`, { headers: owner.authHeaders })
      ).text(),
    ).toBe("false");
  });
});

describe("GET /maps/ filters", () => {
  async function fixture() {
    const owner = await createUser();
    const other = await createUser();

    const mine = await createMap(owner, "Mine");
    const starred = await createMap(owner, "Starred");
    const published = await createMap(owner, "Published");
    const theirs = await createMap(other, "Theirs");

    await put(`${API}/maps/${starred}/starred`, {
      text: "true",
      headers: owner.authHeaders,
    });
    await put(`${API}/maps/${published}/publish`, {
      headers: owner.authHeaders,
      json: { isPublic: true },
    });
    await share(other, theirs, owner.email, "editor");

    return { owner, other, mine, starred, published, theirs };
  }

  const idsOf = (body: Record<string, any>) =>
    (body.mindmapsInfo as { id: number }[])
      .map((m) => m.id)
      .sort((a, b) => a - b);

  test("no q returns everything visible", async () => {
    const f = await fixture();
    const body = await json(
      get(`${API}/maps/`, { headers: f.owner.authHeaders }),
    );
    expect(body.count).toBe(4);
  });

  test("q=my_maps returns only maps I created", async () => {
    const f = await fixture();
    const body = await json(
      get(`${API}/maps/?q=my_maps`, { headers: f.owner.authHeaders }),
    );
    expect(idsOf(body)).toEqual(
      [f.mine, f.starred, f.published].sort((a, b) => a - b),
    );
  });

  test("q=starred returns only starred maps", async () => {
    const f = await fixture();
    const body = await json(
      get(`${API}/maps/?q=starred`, { headers: f.owner.authHeaders }),
    );
    expect(idsOf(body)).toEqual([f.starred]);
  });

  test("q=public returns only public maps", async () => {
    const f = await fixture();
    const body = await json(
      get(`${API}/maps/?q=public`, { headers: f.owner.authHeaders }),
    );
    expect(idsOf(body)).toEqual([f.published]);
  });

  test("q=shared_with_me is literally NOT-my_maps", async () => {
    // The Java filter defines shared_with_me as !my_maps, so it means "maps I
    // did not create" rather than "maps explicitly shared with me". Reproduced.
    const f = await fixture();
    const body = await json(
      get(`${API}/maps/?q=shared_with_me`, { headers: f.owner.authHeaders }),
    );
    expect(idsOf(body)).toEqual([f.theirs]);
  });

  test("an unrecognised q is treated as a LABEL title", async () => {
    // ?q= is an overloaded namespace: anything not one of the five reserved
    // names becomes a label filter, so an unknown value matches nothing.
    const f = await fixture();
    const body = await json(
      get(`${API}/maps/?q=not-a-real-filter`, { headers: f.owner.authHeaders }),
    );
    expect(body.count).toBe(0);
  });

  test("the list DTO carries `public` and `spamDetected`, unlike the single-map DTO", async () => {
    const f = await fixture();
    const body = await json(
      get(`${API}/maps/?q=my_maps`, { headers: f.owner.authHeaders }),
    );
    const entry = (body.mindmapsInfo as Record<string, unknown>[])[0]!;

    expect("public" in entry).toBe(true);
    expect("spamDetected" in entry).toBe(true);
    expect(entry.spamDetected).toBe(false);
    // lastModifierUser is a plain string here and an object in RestMindmap.
    expect(typeof entry.lastModifierUser).toBe("string");
    expect(entry.role).toBe("owner");
    expect(Array.isArray(entry.labels)).toBe(true);
  });

  test("does not leak maps the caller cannot see", async () => {
    const f = await fixture();
    const body = await json(
      get(`${API}/maps/`, { headers: f.other.authHeaders }),
    );
    // `other` created `theirs` only; the owner's maps are invisible even though
    // one of them is public -- the list is driven by collaboration rows.
    expect(idsOf(body)).toEqual([f.theirs]);
  });
});
