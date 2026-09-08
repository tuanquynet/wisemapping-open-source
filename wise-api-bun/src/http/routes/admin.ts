import { Hono } from "hono";

import * as accounts from "../../db/repos/accounts.ts";
import { isAdmin } from "../../services/authService.ts";
import { requireAdmin } from "../middleware/requireAdmin.ts";
import { toRestUser, type RestUser } from "../dto/restUser.ts";
import type { Env } from "../env.ts";

export const adminRoutes = new Hono<Env>();

// All admin routes require admin privileges
adminRoutes.use("*", requireAdmin);

export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  totalElements: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

/**
 * GET /api/restful/admin/users
 *
 * Query params:
 *   page: 0-indexed page number (default 0)
 *   pageSize: items per page (default 10, max 200)
 *   search: query substring in email, firstname, lastname
 *   sortBy: column to sort by (default created_at, or email, firstname, lastname)
 *   sortOrder: 'asc' | 'desc' (default asc)
 *   filterActive: 'true' | 'false' (optional)
 */
adminRoutes.get("/users", async (c) => {
  const pageRaw = c.req.query("page");
  const pageSizeRaw = c.req.query("pageSize");
  const search = c.req.query("search");
  const sortBy = c.req.query("sortBy");
  const sortOrder = c.req.query("sortOrder") as "asc" | "desc" | undefined;
  const filterActiveRaw = c.req.query("filterActive");

  const page = Math.max(0, pageRaw ? parseInt(pageRaw, 10) || 0 : 0);
  const pageSize = Math.min(
    200,
    Math.max(1, pageSizeRaw ? parseInt(pageSizeRaw, 10) || 10 : 10),
  );

  let filterActive: boolean | undefined;
  if (filterActiveRaw === "true") {
    filterActive = true;
  } else if (filterActiveRaw === "false") {
    filterActive = false;
  }

  const filterOpts: accounts.AccountFilterOptions = {
    page,
    pageSize,
    search,
    sortBy,
    sortOrder,
    filterActive,
  };

  const [userList, totalElements] = await Promise.all([
    accounts.findWithFilters(filterOpts),
    accounts.countWithFilters(filterOpts),
  ]);

  const totalPages = Math.ceil(totalElements / pageSize);
  const hasNext = page < totalPages - 1;
  const hasPrevious = page > 0;

  const data: RestUser[] = userList.map((u) => toRestUser(u, isAdmin(u)));

  const response: PaginatedResponse<RestUser> = {
    data,
    page,
    pageSize,
    totalElements,
    totalPages,
    hasNext,
    hasPrevious,
  };

  return c.json(response);
});

/**
 * GET /api/restful/admin/users/email/:email
 *
 * Retrieve user details by email address.
 */
adminRoutes.get("/users/email/:email", async (c) => {
  const email = c.req.param("email");
  const account = await accounts.findByEmail(email);
  if (account === null) {
    return c.text(`User '${email}' could not be found`, 404);
  }
  return c.json(toRestUser(account, isAdmin(account)));
});

/**
 * GET /api/restful/admin/users/:id
 *
 * Retrieve user details by numeric ID.
 */
adminRoutes.get("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.text("User could not be found", 404);
  }
  const account = await accounts.findById(id);
  if (account === null) {
    return c.text("User could not be found", 404);
  }
  return c.json(toRestUser(account, isAdmin(account)));
});
