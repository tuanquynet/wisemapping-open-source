import * as collaborations from "../db/repos/collaborations.ts";
import * as commentsRepo from "../db/repos/commentsRepo.ts";
import * as mindmaps from "../db/repos/mindmaps.ts";
import { isAdmin } from "./authService.ts";
import { roleSatisfies } from "../domain/roles.ts";
import type { CommentWithAuthor } from "../domain/comment.ts";
import {
  AccessDeniedError,
  BadRequestError,
  MapNotFoundError,
  NotFoundError,
} from "../domain/errors.ts";
import type { Account, Mindmap } from "../domain/types.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the caller's role on the map, or null if they have none.
 * Admins are treated as owners for every permission check.
 */
async function callerRole(
  user: Account,
  map: Mindmap,
): Promise<"owner" | "editor" | "viewer" | null> {
  if (isAdmin(user)) return "owner";
  if (map.creatorId === user.id) return "owner";
  const collab = await collaborations.findForMapAndAccount(map.id, user.id);
  return collab?.role ?? null;
}

/** Asserts the map exists and returns it. */
async function requireMap(mapId: number): Promise<Mindmap> {
  const map = await mindmaps.findById(mapId);
  if (!map) throw new MapNotFoundError(mapId);
  return map;
}

// ---------------------------------------------------------------------------
// Public service API
// ---------------------------------------------------------------------------

/**
 * Lists all comments for a map.
 * Viewers, editors, and owners may all read.
 * Public maps are readable without authentication (user = null).
 */
export async function listComments(
  mapId: number,
  user: Account | null,
  topicId?: string,
): Promise<CommentWithAuthor[]> {
  const map = await requireMap(mapId);

  if (!map.isPublic) {
    // Private map: caller must be authenticated with at least viewer role.
    if (user === null) {
      throw new AccessDeniedError();
    }
    const role = await callerRole(user, map);
    if (role === null) {
      throw new AccessDeniedError();
    }
  }

  return commentsRepo.listForMap(mapId, topicId);
}

/**
 * Creates a comment.
 * Requires editor or owner role — viewers may not post.
 */
export async function createComment(
  mapId: number,
  user: Account,
  topicId: string,
  body: string,
): Promise<CommentWithAuthor> {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new BadRequestError("comment body must not be blank");
  }

  const map = await requireMap(mapId);
  const role = await callerRole(user, map);

  if (role === null || !roleSatisfies(role, "editor")) {
    throw new AccessDeniedError();
  }

  return commentsRepo.insert(mapId, topicId, user.id, trimmed);
}

/**
 * Deletes a comment.
 * Only the comment's author or the map owner may delete.
 */
export async function deleteComment(
  mapId: number,
  commentId: number,
  user: Account,
): Promise<void> {
  const map = await requireMap(mapId);

  const comment = await commentsRepo.findById(commentId);
  if (!comment || comment.mindmapId !== mapId) {
    throw new NotFoundError(`comment ${commentId} not found on map ${mapId}`);
  }

  const role = await callerRole(user, map);
  const isAuthor = comment.authorId === user.id;
  const isOwner = role === "owner";

  if (!isAuthor && !isOwner) {
    throw new AccessDeniedError();
  }

  await commentsRepo.deleteById(commentId);
}
