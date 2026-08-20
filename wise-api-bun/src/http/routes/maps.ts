import { Hono, type Context } from "hono";

import * as accounts from "../../db/repos/accounts.ts";
import * as collaborations from "../../db/repos/collaborations.ts";
import * as history from "../../db/repos/history.ts";
import * as labels from "../../db/repos/labels.ts";
import * as mindmaps from "../../db/repos/mindmaps.ts";
import { bunLockManager } from "../../services/lockManager.ts";
import type { LockManager } from "../../services/lockManager.interface.ts";
import * as mindmapService from "../../services/mindmapService.ts";
import { config } from "../../config.ts";
import { dbAdapter } from "../../db/client.ts";
import type { Statement } from "../../db/adapter.ts";
import { accepts, parseFilter } from "../../domain/mindmapFilter.ts";
import { defaultMindmapXml } from "../../domain/mindmapXml.ts";
import { parseRole } from "../../domain/roles.ts";
import {
  DEFAULT_MINDMAP_PROPERTIES,
  type MindmapWithPeople,
} from "../../domain/types.ts";
import {
  AccessDeniedError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../domain/errors.ts";
import {
  toRestCollaborationList,
  toRestMindmapHistory,
} from "../dto/restCollaboration.ts";
import { toRestMindmap, toRestMindmapInfo } from "../dto/restMindmap.ts";
import { toRestMindmapMetadata } from "../dto/restMindmapMetadata.ts";
import {
  currentMap,
  requireMapAccess,
} from "../middleware/requireMapAccess.ts";
import { currentUser, requireUser } from "../middleware/requireUser.ts";
import type { Env } from "../env.ts";

export const mapRoutes = new Hono<Env>();

function resolveLockManager(c: Context<Env>): LockManager {
  return c.get("lockManager") ?? bunLockManager;
}

const XML_CONTENT_TYPE = "application/xml; charset=UTF-8";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function jsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    return ((await c.req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    throw new BadRequestError("A JSON body is required.");
  }
}

/** The caller's per-map view state, defaulted for admins and public viewers. */
async function viewState(
  mapId: number,
  userId: number,
): Promise<{ properties: string; starred: boolean }> {
  const collab = await collaborations.findForMapAndAccount(mapId, userId);
  return collab === null
    ? { properties: DEFAULT_MINDMAP_PROPERTIES, starred: false }
    : { properties: collab.mindmapProperties, starred: collab.starred };
}

// ---------------------------------------------------------------------------
// Listing. Registered before `/:id` so `/maps/batch` is never read as an id.
// ---------------------------------------------------------------------------

/**
 * DELETE /maps/batch?ids=1,2,3
 *
 * Pre-validates every map id and permission before running deletions,
 * preserving the property that a bad id or permission failure deletes nothing.
 */
mapRoutes.delete("/batch", requireUser, async (c) => {
  const user = currentUser(c);
  const raw = c.req.query("ids");
  if (raw === undefined || raw === "") {
    throw new BadRequestError("The ids parameter is required.");
  }

  const ids = raw.split(",").map((s) => Number(s.trim()));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new BadRequestError(`Invalid map ids: ${raw}`);
  }

  // Pre-validate all maps and permissions BEFORE any deletion, preserving
  // the property that a bad id or permission failure deletes nothing.
  const mapsToDelete: MindmapWithPeople[] = [];
  for (const id of ids) {
    const map = await mindmaps.findById(id);
    if (map === null) {
      throw new NotFoundError(`Map with id ${id} could not be found.`);
    }
    // Deletion requires only READ, as in MindmapServiceImpl.removeMindmap.
    if (!(await mindmapService.hasMapPermission(user, map, "viewer"))) {
      throw new AccessDeniedError(`Maps could not be deleted: ${raw}`);
    }
    mapsToDelete.push(map);
  }

  for (const map of mapsToDelete) {
    await mindmapService.removeMindmapOrLeave(map, user);
  }

  return c.body(null, 204);
});

/** GET /maps/ -- the caller's maps, filtered by `?q=`. */
mapRoutes.get("/", requireUser, async (c) => {
  const user = currentUser(c);

  // The 500-map cap is applied BEFORE filtering, matching the Java order, so a
  // filter can return fewer results than actually match.
  const all = await mindmaps.listForAccount(user.id, config.mapListMaxSize);

  const labelRows = await labels.listForMaps(
    all.map((m) => m.id),
    user.id,
  );
  const labelsByMapId = new Map<number, typeof labelRows>();
  const titlesByMapId = new Map<number, string[]>();
  for (const row of labelRows) {
    let forMap = labelsByMapId.get(row.mindmapId);
    if (forMap === undefined) {
      forMap = [];
      labelsByMapId.set(row.mindmapId, forMap);
      titlesByMapId.set(row.mindmapId, []);
    }
    forMap.push(row);
    titlesByMapId.get(row.mindmapId)!.push(row.title);
  }

  const filter = parseFilter(c.req.query("q"));
  const visible = all.filter((m) =>
    accepts(filter, m, {
      accountId: user.id,
      labelTitlesByMapId: titlesByMapId,
    }),
  );

  const mindmapsInfo = visible.map((m) =>
    toRestMindmapInfo(m, labelsByMapId.get(m.id) ?? []),
  );
  return c.json({ count: mindmapsInfo.length, mindmapsInfo });
});

/**
 * POST /maps?title=&description=&layout=&sourceType=&sourceId=
 *
 * Body is the optional raw XML or JSON; supports creating local maps or registering
 * Google Drive linked maps without duplicating map XML in the database.
 */
mapRoutes.post("/", requireUser, async (c) => {
  const user = currentUser(c);

  const queryTitle = c.req.query("title");
  const queryDesc = c.req.query("description");
  const querySourceType = c.req.query("sourceType");
  const querySourceId = c.req.query("sourceId");
  const layout = c.req.query("layout") ?? "mindmap";

  const bodyText = (await c.req.text()).trim();
  let jsonBody: Record<string, unknown> | null = null;
  if (bodyText.startsWith("{") && bodyText.endsWith("}")) {
    try {
      jsonBody = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      jsonBody = null;
    }
  }

  const titleRaw = queryTitle || (jsonBody && typeof jsonBody.title === "string" ? jsonBody.title : undefined);
  const title = mindmapService.requireTitle(titleRaw);
  const description = queryDesc ?? (jsonBody && typeof jsonBody.description === "string" ? jsonBody.description : null);
  const rawSourceType = querySourceType || (jsonBody && typeof jsonBody.sourceType === "string" ? jsonBody.sourceType : "local");
  const sourceType = rawSourceType === "gdrive" ? "gdrive" : "local";
  const sourceId = querySourceId || (jsonBody && typeof jsonBody.sourceId === "string" ? jsonBody.sourceId : null);

  if (sourceType === "gdrive" && sourceId) {
    const existing = await mindmaps.findByCreatorAndSource(user.id, "gdrive", sourceId);
    if (existing) {
      if (title && existing.title !== title) {
        try {
          await mindmaps.updateTitle(existing.id, title);
        } catch {
          // duplicate title ignored on update
        }
      }
      await mindmaps.touch(existing.id, user.id);
      c.header("Location", `/api/restful/maps/${existing.id}`);
      c.header("ResourceId", String(existing.id));
      return c.body(null, 201);
    }
  }

  let finalTitle = title;
  const existingTitleMap = await mindmaps.findByCreatorAndTitle(user.id, title);
  if (existingTitleMap) {
    if (sourceType === "gdrive") {
      finalTitle = `${title} (Google Drive)`;
      if (await mindmaps.findByCreatorAndTitle(user.id, finalTitle)) {
        finalTitle = `${title} (${sourceId ? sourceId.substring(0, 6) : Date.now()})`;
      }
    } else {
      await mindmapService.assertTitleAvailable(user.id, title);
    }
  }

  const xmlContent = bodyText !== "" && !jsonBody ? bodyText : defaultMindmapXml(finalTitle, layout);
  const xml = mindmapService.validateAndNormalizeXml(xmlContent);

  const map = await mindmaps.insert(
    { title: finalTitle, description, creatorId: user.id, isPublic: false, sourceType, sourceId },
    xml,
  );

  c.header("Location", `/api/restful/maps/${map.id}`);
  c.header("ResourceId", String(map.id));
  return c.body(null, 201);
});

/**
 * POST /maps/validate-note -- text/plain note content.
 *
 * MUST be registered before `/:id`, or the `:id` pattern captures
 * "validate-note" and the request fails as an invalid map id.
 *
 * Only the length rule is in scope; the HTML sanitisation the Java version also
 * applies belongs to the spam pipeline, which is not.
 */
mapRoutes.post("/validate-note", requireUser, async (c) => {
  const note = await c.req.text();
  const characterCount = note.length;
  return c.json({
    valid: characterCount <= config.noteMaxLength,
    characterCount,
    maxLength: config.noteMaxLength,
  });
});

// ---------------------------------------------------------------------------
// Single map
// ---------------------------------------------------------------------------

/** GET /maps/{id} -- note: no `public` or `spamDetected` key. See restMindmap.ts. */
mapRoutes.get("/:id", requireUser, requireMapAccess("viewer"), async (c) => {
  const map = currentMap(c);
  const user = currentUser(c);
  const state = await viewState(map.id, user.id);
  return c.json(
    toRestMindmap(
      map,
      await mindmapService.readXml(map.id),
      state.properties,
      state.starred,
    ),
  );
});

/**
 * GET /maps/{id}/metadata?xml=
 *
 * `permitAll()` in Java: `requireMapAccess('viewer')` WITHOUT `requireUser` is
 * exactly that, since the permission predicate grants viewer access to a public
 * map for a null user.
 */
mapRoutes.get("/:id/metadata", requireMapAccess("viewer"), async (c) => {
  const map = currentMap(c);
  const user = c.get("user");

  const collab =
    user === null ? null : await collaborations.findForMapAndAccount(map.id, user.id);

  // The holder sees their own lock as absent; only another user's name appears.
  const lock = await resolveLockManager(c).getLockInfo(map.id);
  const lockedByFullName =
    lock !== null && (user === null || lock.userId !== user.id)
      ? lock.userFullName
      : null;

  const wantsXml = c.req.query("xml") === "true";
  const xml = wantsXml ? await mindmapService.readXml(map.id) : undefined;

  return c.json(
    toRestMindmapMetadata({
      map,
      properties: collab?.mindmapProperties ?? DEFAULT_MINDMAP_PROPERTIES,
      role: collab?.role ?? null,
      lockedByFullName,
      ...(xml !== undefined && { xml }),
    }),
  );
});

/** GET /maps/{id}/document/xml and /xml-pub -- public, raw XML body. */
for (const path of ["/:id/document/xml", "/:id/document/xml-pub"] as const) {
  mapRoutes.get(path, requireMapAccess("viewer"), async (c) =>
    c.body(await mindmapService.readXml(currentMap(c).id), 200, {
      "Content-Type": XML_CONTENT_TYPE,
    }),
  );
}

/**
 * PUT /maps/{id}/document/xml -- text/plain raw XML.
 *
 * Java calls `saveMindmapDocument(false, ...)`, i.e. always writes a history
 * entry, and returns 200 (not 204) because the method has no @ResponseStatus.
 */
mapRoutes.put(
  "/:id/document/xml",
  requireUser,
  requireMapAccess("editor"),
  async (c) => {
    const map = currentMap(c);
    const xml = mindmapService.validateAndNormalizeXml(await c.req.text());
    await mindmapService.saveDocument(map, currentUser(c), xml, { minor: false });
    return c.body(null, 200);
  },
);

/**
 * PUT /maps/{id}/document?minor= -- JSON `{xml, properties}`.
 *
 * Takes the edit lock, and takes it AFTER the permission check so a denied
 * request never acquires one. `properties` being null is an error in Java.
 */
mapRoutes.put(
  "/:id/document",
  requireUser,
  requireMapAccess("editor"),
  async (c) => {
    const map = currentMap(c);
    const user = currentUser(c);
    const body = await jsonBody(c);

    if (typeof body.properties !== "string") {
      throw new BadRequestError("Map properties can not be null");
    }

    await resolveLockManager(c).lock(map, user);

    const xml = mindmapService.validateAndNormalizeXml(body.xml);
    const minor = c.req.query("minor") === "true";

    await collaborations.updateProperties(
      map.id,
      user.id,
      body.properties,
    );
    await mindmapService.saveDocument(map, user, xml, { minor });

    return c.body(null, 204);
  },
);

/** PUT /maps/{id} -- multi-property update. */
mapRoutes.put("/:id", requireUser, requireMapAccess("editor"), async (c) => {
  const map = currentMap(c);
  const user = currentUser(c);
  const body = await jsonBody(c);

  const minor = c.req.query("minor") === "true";

  const xml =
    typeof body.xml === "string" && body.xml !== ""
      ? mindmapService.validateAndNormalizeXml(body.xml)
      : await mindmapService.readXml(map.id);

  if (typeof body.title === "string" && body.title !== map.title) {
    const title = mindmapService.requireTitle(body.title);
    await mindmapService.assertTitleAvailable(user.id, title, map.id);
    await mindmaps.updateTitle(map.id, title);
  }
  if (typeof body.description === "string") {
    await mindmaps.updateDescription(map.id, body.description);
  }
  if (typeof body.properties === "string") {
    await collaborations.updateProperties(map.id, user.id, body.properties);
  }
  await mindmapService.saveDocument(map, user, xml, { minor });

  return c.body(null, 204);
});

/** PUT /maps/{id}/title -- text/plain. */
mapRoutes.put(
  "/:id/title",
  requireUser,
  requireMapAccess("editor"),
  async (c) => {
    const map = currentMap(c);
    const user = currentUser(c);
    const title = mindmapService.requireTitle(await c.req.text());

    await mindmapService.assertTitleAvailable(user.id, title, map.id);
    await mindmaps.updateTitle(map.id, title);
    return c.body(null, 204);
  },
);

/** PUT /maps/{id}/description -- text/plain. */
mapRoutes.put(
  "/:id/description",
  requireUser,
  requireMapAccess("editor"),
  async (c) => {
    await mindmaps.updateDescription(currentMap(c).id, await c.req.text());
    return c.body(null, 204);
  },
);

/** PUT /maps/{id}/publish -- JSON `{isPublic}`, owner only. */
mapRoutes.put(
  "/:id/publish",
  requireUser,
  requireMapAccess("owner"),
  async (c) => {
    const body = await jsonBody(c);
    if (typeof body.isPublic !== "boolean") {
      throw new BadRequestError("Map properties can not be null");
    }
    await mindmaps.updatePublic(currentMap(c).id, body.isPublic);
    return c.body(null, 204);
  },
);

/**
 * DELETE /maps/{id}
 *
 * Requires only viewer: the creator deletes the map, anyone else leaves it. This
 * is the Java behaviour and the frontend's "remove from my list" action.
 */
mapRoutes.delete("/:id", requireUser, requireMapAccess("viewer"), async (c) => {
  await mindmapService.removeMindmapOrLeave(currentMap(c), currentUser(c));
  return c.body(null, 204);
});

/** POST /maps/{id} -- duplicate. */
mapRoutes.post("/:id", requireUser, requireMapAccess("viewer"), async (c) => {
  const source = currentMap(c);
  const user = currentUser(c);
  const body = await jsonBody(c);

  const title = mindmapService.requireTitle(body.title);
  await mindmapService.assertTitleAvailable(user.id, title);

  const description =
    typeof body.description === "string" ? body.description : null;
  const copy = await mindmaps.insert(
    { title, description, creatorId: user.id, isPublic: false },
    await mindmapService.readXml(source.id),
  );

  c.header("Location", `/api/restful/maps/${copy.id}`);
  c.header("ResourceId", String(copy.id));
  return c.body(null, 201);
});

// ---------------------------------------------------------------------------
// Starred (per-user state)
// ---------------------------------------------------------------------------

/** PUT /maps/{id}/starred -- text/plain "true"/"false". */
mapRoutes.put(
  "/:id/starred",
  requireUser,
  requireMapAccess("viewer"),
  async (c) => {
    const map = currentMap(c);
    const user = currentUser(c);
    await mindmapService.requireOwnCollaboration(map.id, user);

    // Boolean.parseBoolean semantics: anything not "true" is false.
    const starred = (await c.req.text()).trim().toLowerCase() === "true";
    await collaborations.updateStarred(map.id, user.id, starred);
    return c.body(null, 204);
  },
);

/** GET /maps/{id}/starred -- text/plain "true"/"false", NOT JSON. */
mapRoutes.get("/:id/starred", requireUser, requireMapAccess("viewer"), async (c) => {
  const collab = await mindmapService.requireOwnCollaboration(
    currentMap(c).id,
    currentUser(c),
  );
  return c.text(String(collab.starred));
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** GET /maps/{id}/history/ -- newest first, capped at 30. */
mapRoutes.get("/:id/history", requireUser, requireMapAccess("viewer"), async (c) => {
  const changes = (await history.listForMap(currentMap(c).id)).map(
    toRestMindmapHistory,
  );
  return c.json({ count: changes.length, changes });
});

/** GET /maps/{id}/{hid}/document/xml -- a historical revision, as raw XML. */
mapRoutes.get(
  "/:id/:hid/document/xml",
  requireUser,
  requireMapAccess("viewer"),
  async (c) => {
    const map = currentMap(c);
    const hid = Number(c.req.param("hid"));
    if (!Number.isInteger(hid)) {
      throw new BadRequestError(`Invalid history id: ${c.req.param("hid")}`);
    }

    const xml = await history.findByIdWithinCap(map.id, hid);
    if (xml === null) {
      throw new NotFoundError(
        `History could not be found for mapid=${map.id}, hid=${hid}`,
      );
    }
    return c.body(xml, 200, { "Content-Type": XML_CONTENT_TYPE });
  },
);

/**
 * POST /maps/{id}/history/{hid} -- revert.
 *
 * Asymmetry worth knowing, straight from the Java code: reverting to a specific
 * revision calls `revertChange` -> `updateMindmap(map, true)`, which DOES write
 * a new history entry. Reverting to `"latest"` calls
 * `saveMindmapDocument(true, ...)` -> `updateMindmap(map, false)`, which does
 * NOT. Same endpoint, opposite history behaviour.
 */
mapRoutes.post(
  "/:id/history/:hid",
  requireUser,
  requireMapAccess("editor"),
  async (c) => {
    const map = currentMap(c);
    const user = currentUser(c);
    const hid = c.req.param("hid");

    if (hid === "latest") {
      const xml = await history.latestXml(map.id);
      // No history yet is a silent no-op in Java (`if (size > 0)`).
      if (xml !== null) {
        await mindmapService.saveDocument(map, user, xml, { minor: true });
      }
      return c.body(null, 204);
    }

    const historyId = Number(hid);
    if (!Number.isInteger(historyId)) {
      throw new BadRequestError(`Invalid history id: ${hid}`);
    }

    const xml = await history.findByIdWithinCap(map.id, historyId);
    if (xml === null) {
      throw new NotFoundError(
        `History could not be found for mapid=${map.id}, hid=${historyId}`,
      );
    }
    await mindmapService.saveDocument(map, user, xml, { minor: false });
    return c.body(null, 204);
  },
);

// ---------------------------------------------------------------------------
// Labels on a map
// ---------------------------------------------------------------------------

/** POST /maps/{id}/labels -- body is a BARE JSON integer, and returns 200. */
mapRoutes.post(
  "/:id/labels",
  requireUser,
  requireMapAccess("editor"),
  async (c) => {
    const map = currentMap(c);
    const user = currentUser(c);

    const body = await c.req.text();
    const labelId = Number(body.trim());
    if (!Number.isInteger(labelId)) {
      throw new BadRequestError("A label id is required.");
    }

    if ((await labels.findByIdForAccount(labelId, user.id)) === null) {
      throw new NotFoundError(`Label could not be found. Id: ${labelId}`);
    }

    await labels.linkToMap(map.id, labelId);
    return c.body(null, 200);
  },
);

/** DELETE /maps/{id}/labels/{lid} */
mapRoutes.delete(
  "/:id/labels/:lid",
  requireUser,
  requireMapAccess("editor"),
  async (c) => {
    const map = currentMap(c);
    const user = currentUser(c);
    const labelId = Number(c.req.param("lid"));

    if (
      !Number.isInteger(labelId) ||
      (await labels.findByIdForAccount(labelId, user.id)) === null
    ) {
      throw new NotFoundError(
        `Label could not be found. Id: ${c.req.param("lid")}`,
      );
    }

    await labels.unlinkFromMap(map.id, labelId);
    return c.body(null, 204);
  },
);

// ---------------------------------------------------------------------------
// Collaborations (sharing) -- owner only for every mutation
// ---------------------------------------------------------------------------

interface ParsedCollab {
  email: string;
  role: "editor" | "viewer";
}

/** Shared validation for both collab-mutating endpoints. */
function parseCollabs(body: Record<string, unknown>): {
  collabs: ParsedCollab[];
} {
  const raw = Array.isArray(body.collaborations) ? body.collaborations : null;
  if (raw === null) {
    throw new BadRequestError("collaborations must be an array");
  }

  const collabs: ParsedCollab[] = [];
  const invalidEmails: string[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      throw new BadRequestError("invalid collaboration entry");
    }
    const email =
      typeof item.email === "string" ? item.email.trim() : "";
    if (!EMAIL_RE.test(email)) {
      invalidEmails.push(email);
      continue;
    }

    const role = parseRole(item.role);
    if (role === null) {
      throw new BadRequestError(`${String(item.role)} is not a valid role`);
    }
    // Ownership cannot be granted or transferred through sharing.
    if (role === "owner") {
      throw new ConflictError("Ownership can not be modified");
    }
    collabs.push({ email, role });
  }

  if (invalidEmails.length > 0) {
    throw new ValidationError(
      { email: `Invalid email address: ${invalidEmails.join(", ")}` },
      `Invalid email address: ${invalidEmails.join(", ")}`,
    );
  }

  return { collabs };
}

/**
 * Resolves an email to an account, creating an invitee placeholder if needed.
 *
 * `async` since Task 2.2 ported `accounts.ts` off `bun:sqlite` -- it can no
 * longer run inside `db.transaction()`'s synchronous callback below, so both
 * call sites resolve every collaborator's account id *before* opening the
 * transaction and use the pre-resolved ids inside it. This is the same
 * pre-read-before-write restructuring Task 4.2 will apply throughout this
 * file once `collaborations.ts`/`mindmaps.ts` are themselves ported
 * (Architecture Decision 2, tasks/plan.md); it lands here first because the
 * compiler forces it the moment `accounts.ts` becomes async.
 */
async function resolveCollaborator(email: string): Promise<number> {
  const existing = await accounts.findByEmail(email);
  return existing !== null ? existing.id : (await accounts.createPlaceholder(email)).id;
}

/** GET /maps/{id}/collabs */
mapRoutes.get("/:id/collabs", requireUser, requireMapAccess("viewer"), async (c) =>
  c.json(toRestCollaborationList(await collaborations.listForMap(currentMap(c).id))),
);

/**
 * POST /maps/{id}/collabs/ -- REPLACES the collaboration set.
 *
 * Anyone absent from the payload has their collaboration removed. The owner is
 * never touched, since owner roles are rejected during parsing.
 */
mapRoutes.post(
  "/:id/collabs",
  requireUser,
  requireMapAccess("owner"),
  async (c) => {
    const map = currentMap(c);
    const { collabs } = parseCollabs(await jsonBody(c));

    const keep = new Set(collabs.map((x) => x.email.toLowerCase()));

    // Resolve every non-owner email to an account id before the batch write
    // -- resolveCollaborator may write a placeholder row, so it cannot run
    // inside a batch statement array.
    const resolvedIds = new Map<string, number>();
    for (const { email } of collabs) {
      if (email.toLowerCase() === map.creatorEmail.toLowerCase()) continue;
      resolvedIds.set(email, await resolveCollaborator(email));
    }

    const existingCollabs = await collaborations.listForMap(map.id);
    const statements: Statement[] = [];
    for (const existing of existingCollabs) {
      if (
        existing.role !== "owner" &&
        !keep.has(existing.email.toLowerCase())
      ) {
        statements.push({
          sql: `DELETE FROM collaboration WHERE id = ?1`,
          params: [existing.id],
        });
      }
    }
    const now = Date.now();
    for (const { email, role } of collabs) {
      if (email.toLowerCase() === map.creatorEmail.toLowerCase()) continue;
      statements.push({
        sql: `INSERT INTO collaboration (mindmap_id, account_id, role, starred, created_at)
              VALUES (?1, ?2, ?3, 0, ?4)
              ON CONFLICT(mindmap_id, account_id) DO UPDATE SET role = excluded.role`,
        params: [map.id, resolvedIds.get(email)!, role, now],
      });
    }
    if (statements.length > 0) {
      await dbAdapter.batch(statements);
    }

    return c.body(null, 204);
  },
);

/** PUT /maps/{id}/collabs/ -- adds or changes roles without removing anyone. */
mapRoutes.put(
  "/:id/collabs",
  requireUser,
  requireMapAccess("owner"),
  async (c) => {
    const map = currentMap(c);
    const { collabs } = parseCollabs(await jsonBody(c));

    // Same pre-resolution as above; also skips the owner's own email so a
    // rejected request (see the ConflictError below) never creates an
    // unwanted placeholder row for it.
    const resolvedIds = new Map<string, number>();
    for (const { email } of collabs) {
      if (email.toLowerCase() === map.creatorEmail.toLowerCase()) continue;
      resolvedIds.set(email, await resolveCollaborator(email));
    }

    const statements: Statement[] = [];
    const now = Date.now();
    for (const { email, role } of collabs) {
      if (email.toLowerCase() === map.creatorEmail.toLowerCase()) {
        throw new ConflictError(`The user ${email} is the owner`);
      }
      const existing = await collaborations.findByEmail(map.id, email);
      if (existing !== null && existing.role === "owner") {
        throw new ConflictError(`Ownership can not be modified: ${email}`);
      }
      statements.push({
        sql: `INSERT INTO collaboration (mindmap_id, account_id, role, starred, created_at)
              VALUES (?1, ?2, ?3, 0, ?4)
              ON CONFLICT(mindmap_id, account_id) DO UPDATE SET role = excluded.role`,
        params: [map.id, resolvedIds.get(email)!, role, now],
      });
    }
    if (statements.length > 0) {
      await dbAdapter.batch(statements);
    }

    return c.body(null, 204);
  },
);

/** DELETE /maps/{id}/collabs?email= */
mapRoutes.delete(
  "/:id/collabs",
  requireUser,
  requireMapAccess("owner"),
  async (c) => {
    const map = currentMap(c);
    const email = c.req.query("email") ?? "";

    if (!EMAIL_RE.test(email.trim())) {
      throw new ValidationError(
        { email: `Invalid email address: ${email}` },
        `Invalid email address: ${email}`,
      );
    }

    const collab = await collaborations.findByEmail(map.id, email);
    if (collab !== null) {
      if (collab.role === "owner") {
        throw new ConflictError("Can not remove owner collab");
      }
      await collaborations.deleteById(collab.id);
    }
    // A missing collaboration is a silent no-op, as in Java.
    return c.body(null, 204);
  },
);

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * PUT /maps/{id}/lock -- text/plain "true"/"false".
 *
 * Asymmetric response, and the frontend depends on it: 200 with a
 * `RestLockInfo` body on lock, 204 with an EMPTY body on unlock.
 */
mapRoutes.put(
  "/:id/lock",
  requireUser,
  requireMapAccess("editor"),
  async (c) => {
    const map = currentMap(c);
    const user = currentUser(c);
    const wantsLock = (await c.req.text()).trim().toLowerCase() === "true";

    if (!wantsLock) {
      await resolveLockManager(c).unlock(map, user);
      return c.body(null, 204);
    }

    await resolveLockManager(c).lock(map, user);
    return c.json({ email: user.email }, 200);
  },
);
