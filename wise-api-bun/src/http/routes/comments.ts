import { Hono } from "hono";

import * as commentService from "../../services/commentService.ts";
import { toRestComment, toRestCommentList } from "../dto/restComment.ts";
import { BadRequestError } from "../../domain/errors.ts";
import { currentMap } from "../middleware/requireMapAccess.ts";
import { currentUser, requireUser } from "../middleware/requireUser.ts";
import { requireMapAccess } from "../middleware/requireMapAccess.ts";
import type { Env } from "../env.ts";

export const commentRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET /:id/comments[?topicId=]
// Viewer+ can list comments; public maps readable by anyone.
// ---------------------------------------------------------------------------

commentRoutes.get(
  "/",
  requireMapAccess("viewer"),
  async (c) => {
    const map = currentMap(c);
    const topicId = c.req.query("topicId");
    const user = c.get("user");
    const comments = await commentService.listComments(
      map.id,
      user,
      topicId,
    );
    return c.json(toRestCommentList(comments), 200);
  },
);

// ---------------------------------------------------------------------------
// POST /:id/comments
// Editor+ may create a comment.
// ---------------------------------------------------------------------------

commentRoutes.post(
  "/",
  requireUser,
  requireMapAccess("viewer"),
  async (c) => {
    const map = currentMap(c);
    const user = currentUser(c);

    let body: Record<string, unknown>;
    try {
      body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
    } catch {
      throw new BadRequestError("A JSON body is required.");
    }

    const topicId = body.topicId;
    const commentBody = body.body;

    if (typeof topicId !== "string" || !topicId.trim()) {
      throw new BadRequestError("topicId is required and must be a non-empty string.");
    }
    if (typeof commentBody !== "string") {
      throw new BadRequestError("body is required and must be a string.");
    }

    const comment = await commentService.createComment(
      map.id,
      user,
      topicId.trim(),
      commentBody,
    );

    c.header("Location", `/api/restful/maps/${map.id}/comments/${comment.id}`);
    c.header("ResourceId", String(comment.id));
    return c.json(toRestComment(comment), 201);
  },
);

// ---------------------------------------------------------------------------
// DELETE /:id/comments/:commentId
// Author or map owner may delete.
// ---------------------------------------------------------------------------

commentRoutes.delete(
  "/:commentId",
  requireUser,
  requireMapAccess("viewer"),
  async (c) => {
    const map = currentMap(c);
    const user = currentUser(c);

    const rawCommentId = c.req.param("commentId");
    const commentId = Number(rawCommentId);
    if (!Number.isInteger(commentId) || commentId <= 0) {
      throw new BadRequestError(`Invalid comment id: ${rawCommentId}`);
    }

    await commentService.deleteComment(map.id, commentId, user);
    return c.body(null, 204);
  },
);
