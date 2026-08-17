import { Hono } from "hono";

import * as labels from "../../db/repos/labels.ts";
import { toRestLabel } from "../dto/restMindmap.ts";
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from "../../domain/errors.ts";
import { currentUser, requireUser } from "../middleware/requireUser.ts";
import type { Env } from "../env.ts";

export const labelRoutes = new Hono<Env>();

// LabelController carries a class-level
// @PreAuthorize("isAuthenticated() and hasRole('ROLE_USER')").
labelRoutes.use("*", requireUser);

/** From `model/Constants.MAX_LABEL_NAME_LENGTH`. */
const MAX_TITLE_LENGTH = 30;
const DEFAULT_COLOR = "#000000";

/**
 * POST /api/restful/labels
 *
 * 201 with `Location` and `ResourceId`. A `?title=` query parameter overrides the
 * body's title, which is what `LabelController.createLabel` does.
 */
labelRoutes.post("/", async (c) => {
  const user = currentUser(c);

  let body: Record<string, unknown>;
  try {
    body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    throw new BadRequestError("A JSON body is required.");
  }

  const override = c.req.query("title");
  const rawTitle =
    override !== undefined && override !== "" ? override : body.title;
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";

  if (title === "") {
    throw new ValidationError(
      { title: "This field is required." },
      "The label title can not be empty.",
    );
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      {
        title: `The title must have less than ${MAX_TITLE_LENGTH} characters.`,
      },
      `The title must have less than ${MAX_TITLE_LENGTH} characters.`,
    );
  }
  if (labels.findByTitleForAccount(title, user.id) !== null) {
    throw new ValidationError(
      { title: "You already have a label with this title." },
      "You already have a label with this title.",
    );
  }

  const color =
    typeof body.color === "string" && body.color !== ""
      ? body.color
      : DEFAULT_COLOR;
  const label = labels.insert(title, color, user.id);

  c.header("Location", `/api/restful/labels/${label.id}`);
  c.header("ResourceId", String(label.id));
  return c.body(null, 201);
});

/** GET /api/restful/labels/ -- note: `{labels: [...]}`, with no `count`. */
labelRoutes.get("/", (c) => {
  const list = labels.listForAccount(currentUser(c).id).map(toRestLabel);
  return c.json({ labels: list });
});

/**
 * DELETE /api/restful/labels/{id}
 *
 * Removing a label unlinks it from every map without deleting the maps -- the
 * behaviour `RestMindmapDeleteWithLabelsTest` pins. Here that falls out of
 * `ON DELETE CASCADE` on the link table.
 */
labelRoutes.delete("/:id", (c) => {
  const user = currentUser(c);
  const id = Number(c.req.param("id"));

  if (
    !Number.isInteger(id) ||
    labels.findByIdForAccount(id, user.id) === null
  ) {
    // Scoped by creator, so another user's label is indistinguishable from a
    // nonexistent one.
    throw new NotFoundError(
      `Label could not be found. Id: ${c.req.param("id")}`,
    );
  }

  labels.deleteById(id);
  return c.body(null, 204);
});
