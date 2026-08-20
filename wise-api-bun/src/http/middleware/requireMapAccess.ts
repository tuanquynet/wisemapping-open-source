import { createMiddleware } from "hono/factory";

import * as mindmaps from "../../db/repos/mindmaps.ts";
import { hasMapPermission } from "../../services/mindmapService.ts";
import {
  AccessDeniedError,
  BadRequestError,
  MapNotFoundError,
} from "../../domain/errors.ts";
import { unauthorizedBody } from "./errorHandler.ts";
import type { Role } from "../../domain/roles.ts";
import type { Env } from "../env.ts";

/**
 * Loads the map named by `:id` and enforces the required role.
 *
 * Three properties this has over the Spring AOP arrangement it replaces:
 *   - the required role is declarative and grep-able at the route table, rather
 *     than split across an annotation, an evaluator and two advice subclasses;
 *   - the map is loaded exactly ONCE per request (the Java path loads it in the
 *     advice and again in the handler);
 *   - using it WITHOUT `requireUser` is precisely the `permitAll()` public-map
 *     case, so those routes need no `if (user == null)` branch of their own.
 *
 * A missing map is 404, never 403, so the API does not reveal which ids exist.
 */
export const requireMapAccess = (required: Role) =>
  createMiddleware<Env>(async (c, next) => {
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestError(`Invalid map id: ${raw}`);
    }

    const map = await mindmaps.findById(id);
    if (map === null) {
      throw new MapNotFoundError(id);
    }

    const user = c.get("user");

    // Anything beyond reading needs an identity; say "unauthenticated" rather
    // than "forbidden" so the client knows to log in instead of giving up.
    if (required !== "viewer" && user === null) {
      return c.json(unauthorizedBody(), 401);
    }

    if (!(await hasMapPermission(user, map, required))) {
      throw new AccessDeniedError();
    }

    c.set("map", map);
    await next();
  });

/** Narrowing accessor for handlers running behind `requireMapAccess`. */
export function currentMap(c: { get: (k: "map") => Env["Variables"]["map"] }) {
  const map = c.get("map");
  if (map === null || map === undefined) {
    throw new Error("currentMap() used on a route without requireMapAccess");
  }
  return map;
}
