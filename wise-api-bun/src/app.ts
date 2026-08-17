import { Hono } from "hono";
import { cors } from "hono/cors";

import { config } from "./config.ts";
import { errorHandler } from "./http/middleware/errorHandler.ts";
import { jwt } from "./http/middleware/jwt.ts";
import { accountRoutes } from "./http/routes/account.ts";
import { appRoutes } from "./http/routes/app.ts";
import { authRoutes } from "./http/routes/auth.ts";
import { labelRoutes } from "./http/routes/labels.ts";
import { mapRoutes } from "./http/routes/maps.ts";
import { userRoutes } from "./http/routes/users.ts";
import type { Env } from "./http/env.ts";

/**
 * `strict: false` makes `/maps` and `/maps/` route identically.
 *
 * The Java controllers are inconsistent about trailing slashes -- `/maps/` and
 * `/labels/` and `/maps/{id}/collabs/` have one, `/maps` (create) does not -- and
 * the frontend calls whichever spelling each controller declared. Registering
 * both explicitly does not work: Hono's `route()` normalises the mount path, so
 * the two registrations collapse and the trailing-slash form 404s.
 *
 * This is safe rather than a papered-over ambiguity: no two in-scope handlers
 * differ only by a trailing slash on the same HTTP method, so nothing is
 * shadowed by accepting both.
 */
export const app = new Hono<Env>({ strict: false });

/**
 * CORS. `exposeHeaders` is load-bearing, not boilerplate: the browser cannot
 * read `Authorization` (returned by login), `Location`, or the custom
 * `ResourceId` header (returned by every create) unless they are exposed. The
 * Java app achieves this with `exposedHeaders: *`.
 */
app.use(
  "/api/*",
  cors({
    origin: config.corsAllowedOrigins,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    exposeHeaders: ["Authorization", "Location", "ResourceId"],
    maxAge: 3600,
    credentials: true,
  }),
);

app.onError(errorHandler);

/**
 * Resolve the caller on every API request. Non-failing by design -- it sets the
 * user or null, and `requireUser` is what rejects. Registered before the routes
 * so both public and guarded handlers can read `c.get('user')`.
 */
app.use("/api/*", jwt);

app.route("/api/restful/app", appRoutes);
app.route("/api/restful/account", accountRoutes);
app.route("/api/restful/users", userRoutes);
app.route("/api/restful/maps", mapRoutes);
app.route("/api/restful/labels", labelRoutes);
// authRoutes owns /authenticate and /logout, which sit directly under /restful.
app.route("/api/restful", authRoutes);

export type App = typeof app;
