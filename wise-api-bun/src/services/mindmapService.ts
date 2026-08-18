import * as collaborations from "../db/repos/collaborations.ts";
import * as history from "../db/repos/history.ts";
import * as mindmaps from "../db/repos/mindmaps.ts";
import * as mindmapXml from "../db/repos/mindmapXml.ts";
import { dbAdapter } from "../db/client.ts";
import { isAdmin } from "./authService.ts";
import {
  assertClosesMapTag,
  encodeXml,
  validateMindmapXml,
} from "../domain/mindmapXml.ts";
import { roleSatisfies, type Role } from "../domain/roles.ts";
import { BadRequestError, ValidationError } from "../domain/errors.ts";
import type { Account, Mindmap } from "../domain/types.ts";

/**
 * The whole of map authorization, transcribed from
 * `MindmapServiceImpl.hasPermissions` (line 71) including its branch order:
 * admin, then creator, then collaboration role, and only then the fall-through
 * that grants read access to a public map.
 *
 * This one function replaces `MapAccessPermissionEvaluation`,
 * `MapPermissionsSecurityAdvice`, `ReadSecurityAdvise`, `UpdateSecurityAdvise`
 * and the 18 `@PreAuthorize` expressions.
 */
export function hasMapPermission(
  user: Account | null,
  map: Mindmap,
  required: Role,
): boolean {
  if (isAdmin(user)) return true;

  if (user !== null) {
    if (map.creatorId === user.id) return true;

    const collab = collaborations.findForMapAndAccount(map.id, user.id);
    if (collab !== null && roleSatisfies(collab.role, required)) return true;
  }

  return map.isPublic && required === "viewer";
}

/** Rejects a title already used by this creator for another map. */
export async function assertTitleAvailable(
  creatorId: number,
  title: string,
  exceptMapId?: number,
): Promise<void> {
  const existing = await mindmaps.findByCreatorAndTitle(creatorId, title);
  if (existing !== null && existing.id !== exceptMapId) {
    throw new ValidationError(
      { title: "You already have a map with this title." },
      "You already have a map with this title.",
    );
  }
}

export function requireTitle(title: unknown): string {
  const value = typeof title === "string" ? title.trim() : "";
  if (value === "") {
    throw new ValidationError(
      { title: "This field is required." },
      "The title can not be empty.",
    );
  }
  return value;
}

/**
 * Persists a document change, porting `MindmapController.saveMindmapDocument`
 * plus `MindmapServiceImpl.updateMindmap`.
 *
 * The history rule is the subtle part and it is inverted along the way: the
 * controller takes `minor` and calls `updateMindmap(map, !minor)`. So a minor
 * save writes NO history entry, and a normal save writes one containing the
 * NEW content (history is snapshotted after the update, not before).
 */
export async function saveDocument(
  map: Mindmap,
  user: Account,
  xml: string,
  options: { minor: boolean },
): Promise<void> {
  assertClosesMapTag(xml);

  await dbAdapter.batch([
    {
      sql: `INSERT INTO mindmap_xml (mindmap_id, xml) VALUES (?1, ?2)
            ON CONFLICT(mindmap_id) DO UPDATE SET xml = excluded.xml`,
      params: [map.id, encodeXml(xml)],
    },
    {
      sql: `UPDATE mindmap SET last_editor_id = ?1, edited_at = ?2 WHERE id = ?3`,
      params: [user.id, Date.now(), map.id],
    },
  ]);

  if (!options.minor) {
    history.insert(map.id, user.id, xml);
  }
}

/** Reads a map's document, treating a missing row as an empty document. */
export async function readXml(mapId: number): Promise<string> {
  return (await mindmapXml.get(mapId)) ?? "";
}

export function validateAndNormalizeXml(xml: unknown): string {
  return validateMindmapXml(xml);
}

/**
 * Deletes a map, or leaves it.
 *
 * Ports `MindmapServiceImpl.removeMindmap`, which is annotated with only READ
 * permission and branches internally: the creator hard-deletes; anyone else just
 * drops their own collaboration. That second branch is the "leave a shared map"
 * action the frontend relies on, so the READ-only requirement is deliberate
 * rather than an oversight.
 */
export async function removeMindmapOrLeave(
  map: Mindmap,
  user: Account,
): Promise<"deleted" | "left" | "noop"> {
  if (map.creatorId === user.id) {
    await mindmaps.deleteById(map.id);
    return "deleted";
  }

  const collab = collaborations.findForMapAndAccount(map.id, user.id);
  if (collab !== null) {
    collaborations.deleteById(collab.id);
    return "left";
  }
  return "noop";
}

/** Per-user view state; every caller with a collaboration has one. */
export function requireOwnCollaboration(mapId: number, user: Account) {
  const collab = collaborations.findForMapAndAccount(mapId, user.id);
  if (collab === null) {
    // Matches the Java "No enough permissions." on the starred endpoints, where
    // an admin or public-map viewer has access but no collaboration row.
    throw new BadRequestError("No enough permissions.");
  }
  return collab;
}
