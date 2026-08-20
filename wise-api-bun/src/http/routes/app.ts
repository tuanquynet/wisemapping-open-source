import { Hono } from "hono";

import { config } from "../../config.ts";
import { buildAppConfig } from "../dto/restAppConfig.ts";
import type { Env } from "../env.ts";

export const appRoutes = new Hono<Env>();

/** GET /api/restful/app/config -- public; the frontend reads this at boot. */
appRoutes.get("/config", (c) => c.json(buildAppConfig(c.get("config") ?? config)));
