import { beforeEach, describe, expect, test } from "bun:test";

import { API, del, get, json, post, put } from "./helpers/client.ts";
import { createUser } from "./helpers/auth.ts";
import { createMap, SAMPLE_XML } from "./helpers/maps.ts";
import { resetDb } from "./helpers/db.ts";
import * as lockManager from "../src/services/lockManager.ts";

beforeEach(() => {
  resetDb();
  lockManager.clearAll();
});

describe("POST /maps (create)", () => {
  test("returns 201 with Location and ResourceId", async () => {
    const user = await createUser();
    const res = await post(`${API}/maps?title=My%20Map`, {
      headers: user.authHeaders,
    });

    expect(res.status).toBe(201);
    const id = res.headers.get("ResourceId");
    expect(id).toBe("1");
    expect(res.headers.get("Location")).toBe(`/api/restful/maps/${id}`);
  });

  test("generates a default document when no body is sent", async () => {
    const user = await createUser();
    const id = await createMap(user, "Default Doc");

    const res = await get(`${API}/maps/${id}/document/xml`, {
      headers: user.authHeaders,
    });
    const xml = await res.text();

    expect(xml).toContain('version="tango"');
    expect(xml).toContain('theme="prism"');
    expect(xml).toContain('layout="mindmap"');
    expect(xml).toContain('text="Default Doc"');
  });

  test("honours the layout parameter", async () => {
    const user = await createUser();
    const res = await post(`${API}/maps?title=Tree&layout=tree`, {
      headers: user.authHeaders,
    });
    const id = res.headers.get("ResourceId");
    const xml = await (
      await get(`${API}/maps/${id}/document/xml`, { headers: user.authHeaders })
    ).text();
    expect(xml).toContain('layout="tree"');
  });

  test("escapes the title into the default document", async () => {
    const user = await createUser();
    const id = await createMap(user, 'A & B <c> "d"');
    const xml = await (
      await get(`${API}/maps/${id}/document/xml`, { headers: user.authHeaders })
    ).text();

    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&quot;");
    // The Java escapeXmlAttribute replaces the LETTERS "gt" rather than ">".
    // That bug is deliberately not reproduced, so ">" escapes properly and no
    // stray "&gt;" appears where the letters g-t occurred.
    expect(xml).toContain("&gt;");
  });

  test("accepts a supplied XML body", async () => {
    const user = await createUser();
    const custom =
      '<map version="tango"><topic central="true" text="Mine"/></map>';
    const id = await createMap(user, "Custom", { xml: custom });

    const xml = await (
      await get(`${API}/maps/${id}/document/xml`, { headers: user.authHeaders })
    ).text();
    expect(xml).toBe(custom);
  });

  test("rejects a missing title", async () => {
    const user = await createUser();
    const res = await post(`${API}/maps`, { headers: user.authHeaders });
    expect(res.status).toBe(400);
    expect((await json(res)).fieldErrors.title).toBeTruthy();
  });

  test("rejects a duplicate title for the same creator", async () => {
    const user = await createUser();
    await createMap(user, "Same");
    const res = await post(`${API}/maps?title=Same`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).fieldErrors.title).toContain("already have a map");
  });

  test("allows the same title for different creators", async () => {
    const a = await createUser();
    const b = await createUser();
    await createMap(a, "Shared Title");
    // Uniqueness is per creator, not global.
    expect(await createMap(b, "Shared Title")).toBeGreaterThan(0);
  });

  test("rejects malformed XML", async () => {
    const user = await createUser();
    const res = await post(`${API}/maps?title=Bad`, {
      headers: user.authHeaders,
      raw: { body: "<notamap/>", contentType: "application/xml" },
    });
    expect(res.status).toBe(400);
  });

  test("requires authentication", async () => {
    expect((await post(`${API}/maps?title=X`)).status).toBe(401);
  });
});

describe("GET /maps/{id}", () => {
  test("returns the RestMindmap contract keys", async () => {
    const user = await createUser();
    const id = await createMap(user, "Contract", { xml: SAMPLE_XML });

    const body = await json(
      get(`${API}/maps/${id}`, { headers: user.authHeaders }),
    );

    expect(body.id).toBe(id);
    expect(body.title).toBe("Contract");
    expect(body.creator).toBe(user.email);
    expect(body.owner).toBe(user.email);
    expect(body.xml).toBe(SAMPLE_XML);
    expect(body.starred).toBe(false);
    expect(body.properties).toBe('{"zoom":0.8}');
    expect(body.lastModifierUser).toMatchObject({ email: user.email });
  });

  test("omits `public` and `spamDetected` -- isGetterVisibility=NONE drops them", async () => {
    // RestMindmap declares isPublic()/isSpamDetected() as is-getters while
    // setting isGetterVisibility=NONE, so Jackson never serialises them.
    // RestMindmapInfo (the list DTO) DOES carry both. Verified against the Java
    // source; emitting them here would silently diverge.
    const user = await createUser();
    const id = await createMap(user, "NoPublicKey");
    const body = await json(
      get(`${API}/maps/${id}`, { headers: user.authHeaders }),
    );

    expect("public" in body).toBe(false);
    expect("spamDetected" in body).toBe(false);
  });

  test("defaults mindmap properties to the Java-side default", async () => {
    // CollaborationProperties.getMindmapProperties() returns this when the
    // column is null; the default lives in code, not the schema.
    const user = await createUser();
    const id = await createMap(user, "Props");
    const body = await json(
      get(`${API}/maps/${id}`, { headers: user.authHeaders }),
    );
    expect(body.properties).toBe('{"zoom":0.8}');
  });

  test("404s for a nonexistent map, and for another user's map", async () => {
    const owner = await createUser();
    const other = await createUser();
    const id = await createMap(owner, "Private");

    expect(
      (await get(`${API}/maps/9999`, { headers: owner.authHeaders })).status,
    ).toBe(404);
    // A private map the caller cannot see is 403, not 404: the map exists and
    // the id came from somewhere, so hiding existence buys nothing here.
    expect(
      (await get(`${API}/maps/${id}`, { headers: other.authHeaders })).status,
    ).toBe(403);
  });

  test("400s on a non-numeric id", async () => {
    const user = await createUser();
    expect(
      (await get(`${API}/maps/abc`, { headers: user.authHeaders })).status,
    ).toBe(400);
  });
});

describe("document read/write", () => {
  test("round-trips XML byte-for-byte", async () => {
    const user = await createUser();
    const id = await createMap(user, "RoundTrip");

    const updated =
      '<map version="tango"><topic central="true" text="Updated"/><topic text="Child"/></map>';
    const put1 = await put(`${API}/maps/${id}/document/xml`, {
      text: updated,
      headers: user.authHeaders,
    });
    expect(put1.status).toBe(200);

    const res = await get(`${API}/maps/${id}/document/xml`, {
      headers: user.authHeaders,
    });
    expect(await res.text()).toBe(updated);
    expect(res.headers.get("Content-Type")).toBe(
      "application/xml; charset=UTF-8",
    );
  });

  test("preserves UTF-8 content exactly", async () => {
    const user = await createUser();
    const id = await createMap(user, "Unicode");
    const xml =
      '<map version="tango"><topic central="true" text="日本語 · émoji 🗺 · &amp;"/></map>';

    await put(`${API}/maps/${id}/document/xml`, {
      text: xml,
      headers: user.authHeaders,
    });
    const got = await (
      await get(`${API}/maps/${id}/document/xml`, { headers: user.authHeaders })
    ).text();
    expect(got).toBe(xml);
  });

  test("rejects XML that does not close the map tag", async () => {
    const user = await createUser();
    const id = await createMap(user, "BadXml");
    const res = await put(`${API}/maps/${id}/document/xml`, {
      text: "<map>unclosed",
      headers: user.authHeaders,
    });
    expect(res.status).toBe(400);
  });

  test("rejects a document exceeding the node cap", async () => {
    const user = await createUser();
    const id = await createMap(user, "TooBig");
    const huge = `<map version="tango">${"<topic text='x'/>".repeat(4100)}</map>`;
    const res = await put(`${API}/maps/${id}/document/xml`, {
      text: huge,
      headers: user.authHeaders,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).globalErrors[0]).toContain("too big");
  });

  test("PUT /document requires a properties field", async () => {
    const user = await createUser();
    const id = await createMap(user, "NoProps");
    const res = await put(`${API}/maps/${id}/document`, {
      headers: user.authHeaders,
      json: { xml: SAMPLE_XML },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).globalErrors[0]).toContain("properties");
  });

  test("PUT /document stores xml and properties together", async () => {
    const user = await createUser();
    const id = await createMap(user, "WithProps");

    const res = await put(`${API}/maps/${id}/document`, {
      headers: user.authHeaders,
      json: { xml: SAMPLE_XML, properties: '{"zoom":1.5}' },
    });
    expect(res.status).toBe(204);

    const body = await json(
      get(`${API}/maps/${id}`, { headers: user.authHeaders }),
    );
    expect(body.properties).toBe('{"zoom":1.5}');
  });
});

describe("public maps", () => {
  test("are readable without authentication once published", async () => {
    const owner = await createUser();
    const id = await createMap(owner, "Public Map", { xml: SAMPLE_XML });

    // Private first: anonymous access is refused.
    expect((await get(`${API}/maps/${id}/document/xml`)).status).toBe(403);

    expect(
      (
        await put(`${API}/maps/${id}/publish`, {
          headers: owner.authHeaders,
          json: { isPublic: true },
        })
      ).status,
    ).toBe(204);

    // Now anonymous access works -- this is the permitAll() path, expressed as
    // requireMapAccess('viewer') with no requireUser.
    const res = await get(`${API}/maps/${id}/document/xml`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SAMPLE_XML);

    // xml-pub is the same handler under a second path.
    expect((await get(`${API}/maps/${id}/document/xml-pub`)).status).toBe(200);
  });

  test("metadata is public and carries the `public` key", async () => {
    const owner = await createUser();
    const id = await createMap(owner, "Meta");
    await put(`${API}/maps/${id}/publish`, {
      headers: owner.authHeaders,
      json: { isPublic: true },
    });

    const body = await json(get(`${API}/maps/${id}/metadata`));
    expect(body.public).toBe(true);
    expect(body.title).toBe("Meta");
    expect(body.createdBy).toBe(owner.email);
    // isLocked() and isStarred() are is-getters with isGetterVisibility=NONE and
    // no @JsonProperty, so they are NOT serialised. Only isPublic() survives,
    // via @JsonProperty("public").
    expect("isLocked" in body).toBe(false);
    expect("starred" in body).toBe(false);
    expect("isStarred" in body).toBe(false);
  });

  test("metadata includes xml only when ?xml=true", async () => {
    const owner = await createUser();
    const id = await createMap(owner, "MetaXml", { xml: SAMPLE_XML });

    const without = await json(
      get(`${API}/maps/${id}/metadata`, { headers: owner.authHeaders }),
    );
    expect("xml" in without).toBe(false);

    const withXml = await json(
      get(`${API}/maps/${id}/metadata?xml=true`, {
        headers: owner.authHeaders,
      }),
    );
    expect(withXml.xml).toBe(SAMPLE_XML);
  });

  test("publish requires ownership", async () => {
    const owner = await createUser();
    const other = await createUser();
    const id = await createMap(owner, "OwnerOnly");

    const res = await put(`${API}/maps/${id}/publish`, {
      headers: other.authHeaders,
      json: { isPublic: true },
    });
    expect(res.status).toBe(403);
  });

  test("publish rejects a missing isPublic flag", async () => {
    const owner = await createUser();
    const id = await createMap(owner, "NoFlag");
    const res = await put(`${API}/maps/${id}/publish`, {
      headers: owner.authHeaders,
      json: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("title and description", () => {
  test("updates via text/plain bodies", async () => {
    const user = await createUser();
    const id = await createMap(user, "Original");

    expect(
      (
        await put(`${API}/maps/${id}/title`, {
          text: "Renamed",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await put(`${API}/maps/${id}/description`, {
          text: "A description",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(204);

    const body = await json(
      get(`${API}/maps/${id}`, { headers: user.authHeaders }),
    );
    expect(body.title).toBe("Renamed");
    expect(body.description).toBe("A description");
  });

  test("rejects renaming onto an existing title", async () => {
    const user = await createUser();
    await createMap(user, "Taken");
    const id = await createMap(user, "Rename Me");

    const res = await put(`${API}/maps/${id}/title`, {
      text: "Taken",
      headers: user.authHeaders,
    });
    expect(res.status).toBe(400);
  });

  test("allows renaming a map to its own title", async () => {
    const user = await createUser();
    const id = await createMap(user, "Same Name");
    const res = await put(`${API}/maps/${id}/title`, {
      text: "Same Name",
      headers: user.authHeaders,
    });
    expect(res.status).toBe(204);
  });

  test("rejects a blank title", async () => {
    const user = await createUser();
    const id = await createMap(user, "Blank Test");
    expect(
      (
        await put(`${API}/maps/${id}/title`, {
          text: "   ",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(400);
  });
});

describe("PUT /maps/{id} (multi-property)", () => {
  test("updates title, description and properties at once", async () => {
    const user = await createUser();
    const id = await createMap(user, "Multi");

    const res = await put(`${API}/maps/${id}`, {
      headers: user.authHeaders,
      json: {
        title: "Multi Renamed",
        description: "New desc",
        properties: '{"zoom":2}',
      },
    });
    expect(res.status).toBe(204);

    const body = await json(
      get(`${API}/maps/${id}`, { headers: user.authHeaders }),
    );
    expect(body.title).toBe("Multi Renamed");
    expect(body.description).toBe("New desc");
    expect(body.properties).toBe('{"zoom":2}');
  });

  test("leaves the document untouched when xml is absent", async () => {
    const user = await createUser();
    const id = await createMap(user, "KeepXml", { xml: SAMPLE_XML });

    await put(`${API}/maps/${id}`, {
      headers: user.authHeaders,
      json: { description: "only desc" },
    });

    const body = await json(
      get(`${API}/maps/${id}`, { headers: user.authHeaders }),
    );
    expect(body.xml).toBe(SAMPLE_XML);
  });
});

describe("DELETE /maps/{id}", () => {
  test("the creator hard-deletes the map", async () => {
    const user = await createUser();
    const id = await createMap(user, "Doomed");

    expect(
      (await del(`${API}/maps/${id}`, { headers: user.authHeaders })).status,
    ).toBe(204);
    expect(
      (await get(`${API}/maps/${id}`, { headers: user.authHeaders })).status,
    ).toBe(404);
  });

  test("requires only viewer permission, and a non-creator merely LEAVES the map", async () => {
    // MindmapServiceImpl.removeMindmap is annotated READ and branches on
    // creator: this is the "leave a shared map" action, not a privilege bug.
    const owner = await createUser();
    const viewer = await createUser();
    const id = await createMap(owner, "Shared");
    await post(`${API}/maps/${id}/collabs/`, {
      headers: owner.authHeaders,
      json: {
        collaborations: [{ email: viewer.email, role: "viewer" }],
        message: null,
      },
    });

    expect(
      (await del(`${API}/maps/${id}`, { headers: viewer.authHeaders })).status,
    ).toBe(204);

    // Gone for the viewer...
    expect(
      (await get(`${API}/maps/${id}`, { headers: viewer.authHeaders })).status,
    ).toBe(403);
    // ...but the owner still has it.
    expect(
      (await get(`${API}/maps/${id}`, { headers: owner.authHeaders })).status,
    ).toBe(200);
  });

  test("batch delete removes several maps", async () => {
    const user = await createUser();
    const a = await createMap(user, "A");
    const b = await createMap(user, "B");

    expect(
      (
        await del(`${API}/maps/batch?ids=${a},${b}`, {
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(204);
    expect(
      (await get(`${API}/maps/${a}`, { headers: user.authHeaders })).status,
    ).toBe(404);
    expect(
      (await get(`${API}/maps/${b}`, { headers: user.authHeaders })).status,
    ).toBe(404);
  });

  test("batch delete is atomic: one bad id deletes nothing", async () => {
    const user = await createUser();
    const other = await createUser();
    const mine = await createMap(user, "Mine");
    const theirs = await createMap(other, "Theirs");

    const res = await del(`${API}/maps/batch?ids=${mine},${theirs}`, {
      headers: user.authHeaders,
    });
    expect(res.status).toBe(403);
    // The whole batch runs in one transaction, so `mine` survives.
    expect(
      (await get(`${API}/maps/${mine}`, { headers: user.authHeaders })).status,
    ).toBe(200);
  });
});
