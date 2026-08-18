import { beforeEach, describe, expect, test } from "bun:test";

import { API, get, json, post, put } from "./helpers/client.ts";
import { createUser } from "./helpers/auth.ts";
import { createMap, share, SAMPLE_XML } from "./helpers/maps.ts";
import { resetDb } from "./helpers/db.ts";
import * as lockManager from "../src/services/lockManager.ts";

beforeEach(() => {
  resetDb();
  lockManager.clearAll();
});

describe("PUT /maps/{id}/lock", () => {
  test("returns 200 with a RestLockInfo body when locking", async () => {
    const user = await createUser();
    const id = await createMap(user, "Lockable");

    const res = await put(`${API}/maps/${id}/lock`, {
      text: "true",
      headers: user.authHeaders,
    });
    expect(res.status).toBe(200);
    // RestLockInfo has exactly one serialised property.
    expect(await json(res)).toEqual({ email: user.email });
  });

  test("returns 204 with an EMPTY body when unlocking", async () => {
    // Asymmetric on purpose: 200+body to lock, 204+nothing to unlock.
    const user = await createUser();
    const id = await createMap(user, "Unlockable");

    await put(`${API}/maps/${id}/lock`, {
      text: "true",
      headers: user.authHeaders,
    });
    const res = await put(`${API}/maps/${id}/lock`, {
      text: "false",
      headers: user.authHeaders,
    });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("a second editor is refused with 409 while the lock is held", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const id = await createMap(owner, "Contested", { xml: SAMPLE_XML });
    await share(owner, id, editor.email, "editor");

    expect(
      (
        await put(`${API}/maps/${id}/lock`, {
          text: "true",
          headers: owner.authHeaders,
        })
      ).status,
    ).toBe(200);

    const res = await put(`${API}/maps/${id}/lock`, {
      text: "true",
      headers: editor.authHeaders,
    });
    expect(res.status).toBe(409);
    expect((await json(res)).globalErrors[0]).toContain("another user");
  });

  test("re-locking your own map succeeds and refreshes the lease", async () => {
    const user = await createUser();
    const id = await createMap(user, "Relock");

    await put(`${API}/maps/${id}/lock`, {
      text: "true",
      headers: user.authHeaders,
    });
    const before = (await lockManager.getLockInfo(id))!.expiresAt;

    await Bun.sleep(5);
    await put(`${API}/maps/${id}/lock`, {
      text: "true",
      headers: user.authHeaders,
    });
    // The lock is a lease; every call extends it, which is how the editor's
    // save heartbeat keeps a session alive.
    expect((await lockManager.getLockInfo(id))!.expiresAt).toBeGreaterThan(before);
  });

  test("another editor may take the lock once it expires", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const id = await createMap(owner, "Expiring");
    await share(owner, id, editor.email, "editor");

    await put(`${API}/maps/${id}/lock`, {
      text: "true",
      headers: owner.authHeaders,
    });
    expect(
      (
        await put(`${API}/maps/${id}/lock`, {
          text: "true",
          headers: editor.authHeaders,
        })
      ).status,
    ).toBe(409);

    // Expiry is checked lazily on read, so it takes effect immediately rather
    // than waiting up to a minute for the sweeper.
    lockManager.expireForTest(id);

    expect(
      (
        await put(`${API}/maps/${id}/lock`, {
          text: "true",
          headers: editor.authHeaders,
        })
      ).status,
    ).toBe(200);
  });

  test("unlocking a lock held by someone else is refused", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const id = await createMap(owner, "Foreign Unlock");
    await share(owner, id, editor.email, "editor");

    await put(`${API}/maps/${id}/lock`, {
      text: "true",
      headers: owner.authHeaders,
    });
    const res = await put(`${API}/maps/${id}/lock`, {
      text: "false",
      headers: editor.authHeaders,
    });
    expect(res.status).toBe(409);
  });

  test("unlocking when nothing is locked is a no-op", async () => {
    const user = await createUser();
    const id = await createMap(user, "Idempotent Unlock");
    expect(
      (
        await put(`${API}/maps/${id}/lock`, {
          text: "false",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(204);
  });

  test("requires editor permission", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const id = await createMap(owner, "Lock Perms");
    await share(owner, id, viewer.email, "viewer");

    expect(
      (
        await put(`${API}/maps/${id}/lock`, {
          text: "true",
          headers: viewer.authHeaders,
        })
      ).status,
    ).toBe(403);
  });

  test("saving the document takes the lock", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const id = await createMap(owner, "Save Locks");
    await share(owner, id, editor.email, "editor");

    await put(`${API}/maps/${id}/document`, {
      headers: owner.authHeaders,
      json: { xml: SAMPLE_XML, properties: "{}" },
    });

    expect((await lockManager.getLockInfo(id))?.userId).toBeDefined();
    // The other editor is now blocked.
    expect(
      (
        await put(`${API}/maps/${id}/lock`, {
          text: "true",
          headers: editor.authHeaders,
        })
      ).status,
    ).toBe(409);
  });

  test("a denied save never acquires a lock", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const id = await createMap(owner, "No Lock On Deny");
    await share(owner, id, viewer.email, "viewer");

    const res = await put(`${API}/maps/${id}/document`, {
      headers: viewer.authHeaders,
      json: { xml: SAMPLE_XML, properties: "{}" },
    });
    expect(res.status).toBe(403);
    // The lock is taken inside the handler, after the permission middleware.
    expect(await lockManager.getLockInfo(id)).toBeNull();
  });
});

describe("lock visibility via /metadata", () => {
  test("reports the OTHER holder's full name, and nothing for your own lock", async () => {
    const owner = await createUser({
      email: "holder@example.org",
      firstname: "Lock",
      lastname: "Holder",
    });
    const editor = await createUser();
    const id = await createMap(owner, "Lock Metadata");
    await share(owner, id, editor.email, "editor");

    await put(`${API}/maps/${id}/lock`, {
      text: "true",
      headers: owner.authHeaders,
    });

    // The other user sees who holds it...
    const seenByEditor = await json(
      get(`${API}/maps/${id}/metadata`, { headers: editor.authHeaders }),
    );
    expect(seenByEditor.isLockedBy).toBe("Lock Holder");

    // ...but the holder sees their own map as unlocked.
    const seenByOwner = await json(
      get(`${API}/maps/${id}/metadata`, { headers: owner.authHeaders }),
    );
    expect(seenByOwner.isLockedBy).toBeNull();
  });

  test("isLockedBy is null when nothing holds the lock", async () => {
    const user = await createUser();
    const id = await createMap(user, "Unlocked Metadata");
    const body = await json(
      get(`${API}/maps/${id}/metadata`, { headers: user.authHeaders }),
    );
    expect(body.isLockedBy).toBeNull();
  });
});

describe("logout releases locks", () => {
  test("clears every lock held by the user", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const a = await createMap(owner, "Lock A");
    const b = await createMap(owner, "Lock B");
    await share(owner, a, editor.email, "editor");

    await put(`${API}/maps/${a}/lock`, {
      text: "true",
      headers: owner.authHeaders,
    });
    await put(`${API}/maps/${b}/lock`, {
      text: "true",
      headers: owner.authHeaders,
    });
    expect(await lockManager.getLockInfo(a)).not.toBeNull();
    expect(await lockManager.getLockInfo(b)).not.toBeNull();

    expect(
      (await post(`${API}/logout`, { headers: owner.authHeaders })).status,
    ).toBe(200);

    // Without this, a signed-out user's lock would block others for 30 minutes.
    expect(await lockManager.getLockInfo(a)).toBeNull();
    expect(await lockManager.getLockInfo(b)).toBeNull();
    expect(
      (
        await put(`${API}/maps/${a}/lock`, {
          text: "true",
          headers: editor.authHeaders,
        })
      ).status,
    ).toBe(200);
  });

  test("leaves other users' locks alone", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const id = await createMap(owner, "Other Lock");
    await share(owner, id, editor.email, "editor");

    await put(`${API}/maps/${id}/lock`, {
      text: "true",
      headers: editor.authHeaders,
    });
    await post(`${API}/logout`, { headers: owner.authHeaders });

    expect((await lockManager.getLockInfo(id))?.userId).toBe(
      (await json(get(`${API}/account`, { headers: editor.authHeaders }))).id,
    );
  });
});

describe("lock manager internals", () => {
  test("the session id is a string, not a number", async () => {
    // Bun.nanoseconds() exceeds Number.MAX_SAFE_INTEGER within hours of uptime,
    // and this value is serialised to the client.
    const map = { id: 1 } as never;
    const user = {
      id: 1,
      email: "x@example.org",
      firstname: "A",
      lastname: "B",
    } as never;

    const info = await lockManager.lock(map, user);
    expect(typeof info.session).toBe("string");
    lockManager.clearAll();
  });
});
