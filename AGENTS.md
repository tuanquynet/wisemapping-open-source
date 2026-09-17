# AGENTS.md

Guidance and project knowledge for AI assistants working in the WiseMapping repository.

---

## 1. Project Overview

WiseMapping is a free, open-source mind mapping platform. This repository hosts the **REST API backend**, located entirely in [`wise-api-bun/`](wise-api-bun/).

> **Migration Status:** The backend has been completely migrated to **TypeScript + Bun + Hono + SQLite / Cloudflare D1**. The legacy Java 24 / Spring Boot 4 service (`wise-api/`) was removed in commit `e7ad268f`. The single active backend implementation is `wise-api-bun/`.

The frontend is maintained separately at [`https://github.com/wisemapping/wisemapping-frontend`](https://github.com/wisemapping/wisemapping-frontend). It expects an exact REST contract (JSON key names, response formats, headers, and status codes). **The frontend requires zero code changes; the backend strictly adapts to the frontend's expectations.**

---

## 2. Tech Stack

- **Runtime Environments:**
  - **Bun** (v1.1+): Primary runtime for local development, CI, and containerized deployment.
  - **Cloudflare Workers**: Edge serverless deployment target (`src/workers.ts`).
- **HTTP Framework:** [Hono](https://hono.dev/) v4 (`strict: false` mode to handle legacy trailing-slash differences).
- **Language:** TypeScript 5 (strict mode, `tsc --noEmit` must pass cleanly).
- **Database & Storage:**
  - **Bun:** Embedded SQLite via `bun:sqlite` (WAL journal mode, `foreign_keys = ON`, `busy_timeout = 5000`).
  - **Cloudflare Workers:** Serverless SQLite via **Cloudflare D1** (`D1Adapter`).
  - **Schema:** 6 core STRICT tables + indexes; migrations managed with `PRAGMA user_version` (Bun) and SQL files under `migrations/` (D1).
- **Concurrency & Locks:**
  - **Bun:** In-memory `Map` with 60-second sweeper timer (`src/services/lockManager.ts`).
  - **Cloudflare Workers:** Distributed edit locks via **Cloudflare Durable Objects** (`MapLockDurableObject` with `alarm()`-driven 30-min lease expiry).
- **Password Hashing:**
  - **Bun:** Argon2id via native `Bun.password`.
  - **Cloudflare Workers:** OWASP-compliant WebCrypto PBKDF2 (SHA-512, 100k iterations) via `workerPasswordHasher` (`src/util/passwordHash.worker.ts`).
- **Authentication:** JWT (HMAC-SHA256) via standard `Authorization: Bearer <token>` headers. Google OAuth2 supported (`/api/restful/oauth2`).

---

## 3. Directory Layout

```
.
├── AGENTS.md                      # This AI instructions and project knowledge document
├── CLAUDE.md                      # AI assistant context file
├── README.md                      # Public project README
├── .project/
│   └── port-to-bun-js.md          # Architecture and migration design specification
├── .github/workflows/
│   ├── cloudflare-deploy.yml      # CI/CD: runs bun test, typecheck, dry-run, and deploys
│   └── maven.yml                  # Legacy workflow (being phased out)
└── wise-api-bun/                  # ACTIVE BACKEND ROOT
    ├── package.json               # Dependencies and npm scripts
    ├── tsconfig.json              # Strict TypeScript configuration
    ├── wrangler.toml              # Cloudflare Workers, D1, and Durable Object bindings
    ├── .env.example               # Template for environment configuration
    ├── migrations/                # D1 migration scripts (0001_base_schema.sql, 0002_add_comments.sql)
    ├── scripts/                   # Verification and maintenance scripts (verify-worker-e2e.ts)
    ├── docs/                      # Deployment documentation (cloudflare-deploy.md)
    ├── src/
    │   ├── index.ts               # Bun entrypoint (Bun.serve, signal handlers, shutdown)
    │   ├── workers.ts             # Cloudflare Workers entrypoint (fetch handler, DO export)
    │   ├── app.ts                 # Hono app instance, global middleware, route mounts
    │   ├── config.ts              # Runtime-agnostic config factory and schema validation
    │   ├── config.bun.ts          # Bun eager config singleton (Bun.env)
    │   ├── db/
    │   │   ├── adapter.ts         # DbAdapter interface (get, all, run, batch)
    │   │   ├── bunAdapter.ts      # DbAdapter implementation for bun:sqlite
    │   │   ├── d1Adapter.ts       # DbAdapter implementation for Cloudflare D1
    │   │   ├── client.ts          # Shared runtime-agnostic dbAdapter holder
    │   │   ├── client.bun.ts      # Bun SQLite initialization and pragmas
    │   │   ├── schema.sql         # Base DDL schema (STRICT tables, indexes)
    │   │   ├── migrate.ts         # Append-only PRAGMA user_version migration runner
    │   │   ├── rows.ts            # Snake_case SQLite row interfaces
    │   │   └── repos/             # Data access repositories (accounts, mindmaps, collaborations, history, labels, mindmapXml, commentsRepo)
    │   ├── domain/                # Shared business errors, roles, types, XML utilities, filter parsing
    │   ├── services/              # Business logic (authService, mindmapService, commentService, lockManager, workerLockManager)
    │   ├── durable-objects/       # MapLockDurableObject for edge collaborative locks
    │   ├── http/
    │   │   ├── env.ts             # Hono execution environment context type (Env)
    │   │   ├── middleware/        # jwt, requireUser, requireMapAccess, requireAdmin, errorHandler
    │   │   ├── routes/            # auth, account, users, maps, comments, labels, admin, oauth2, app
    │   │   └── dto/               # REST DTO transformers mapping DB rows to frontend JSON wire shapes
    │   └── util/                  # jwt, passwordHash, logger, iso8601
    └── test/                      # Comprehensive test suite (Bun test runner against in-memory DB)
        └── helpers/               # Test fixtures, in-memory DB reset helpers, auth and map mocks
```

---

## 4. Essential Commands

All development, testing, and typechecking commands run from inside `wise-api-bun/`:

```sh
cd wise-api-bun

# Setup
bun install
cp .env.example .env
echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env

# Local Development (Bun)
bun run dev              # Hot-reload development server (http://localhost:8080)
bun start                # Run production server (bun src/index.ts)

# Testing & Type Checking
bun test                 # Run all 300+ unit and integration tests (in-memory SQLite)
bun test test/maps.test.ts # Run a single test file
bun run typecheck        # Run TypeScript type check (tsc --noEmit)

# Cloudflare Workers Local Testing
bunx wrangler d1 migrations apply DB --local   # Apply D1 migrations to local emulator
bunx wrangler dev --local --port 8080          # Run local worker emulator
bun run scripts/verify-worker-e2e.ts           # Run 14-step E2E verification against Worker
bunx wrangler deploy --dry-run                 # Validate bundle without deploying
```

---

## 5. Architecture & Runtime Design

### Dual-Runtime Abstraction

The codebase runs identically on **Bun** and **Cloudflare Workers** without code duplication:

| Capability | Bun Runtime (`src/index.ts`) | Cloudflare Workers (`src/workers.ts`) |
| :--- | :--- | :--- |
| **Server** | `Bun.serve({ fetch: app.fetch })` | Export default `{ fetch: workerApp.fetch }` |
| **Config** | Eager singleton `src/config.bun.ts` using `Bun.env` | Dynamic `buildConfig(c.env)` cached per isolate |
| **Database** | `bun:sqlite` wrapped in `BunSqliteAdapter` | Cloudflare D1 wrapped in `D1Adapter` |
| **Transactions**| Synchronous `db.transaction()` via `adapter.batch()` | Atomic D1 statements via `adapter.batch()` |
| **Edit Locks** | In-memory `Map` + 60s sweeper interval | Durable Object (`MapLockDurableObject`) + 30m alarm |
| **Password Hash**| Argon2id via `Bun.password` | WebCrypto PBKDF2 (100k iter SHA-512) via `hash-wasm` / `crypto.subtle` |

### Database Layer Rules

1. **`dbAdapter` is the only database gateway:** All repositories in `src/db/repos/` MUST import `dbAdapter` from `src/db/client.ts`. Never import raw `Database` from `bun:sqlite` inside repository or service code.
2. **Handle `.get()` returning `null`:** Both SQLite adapters return `null` (not `undefined`) when a row is not found. Always check `=== null` or `== null`.
3. **Atomic Operations with `batch()`:** Cloudflare D1 does not support interactive `BEGIN`/`COMMIT` over Workers bindings. Use `dbAdapter.batch([statement1, statement2])` for atomic multi-statement operations.
4. **Append-Only Migrations:**
   - On Bun, migrations in `src/db/migrate.ts` are indexed by `PRAGMA user_version`. **Never edit or reorder an existing migration step**; only append new steps.
   - For Cloudflare D1, add corresponding SQL files in `migrations/` (e.g. `0003_xxx.sql`).

---

## 6. Critical Frontend Wire Contracts & Quirks

The frontend (`wisemapping-frontend`) expects precise wire behaviors. **Do NOT "clean up" or refactor these without verifying against frontend expectations:**

### 1. Authentication & Token Exchange
- `POST /api/restful/authenticate` returns the **bare JWT string** as `text/plain` in the response body (no JSON, no quotes) **AND** sets the `Authorization: Bearer <token>` response header. Both are mandatory.
- Unauthenticated 401 response is `{"msg":"Unauthorized"}` (contrasted with standard error payloads).

### 2. Scalar Text Updates
- 11 routes consume `text/plain` scalar payloads instead of JSON:
  - `PUT /api/restful/maps/{id}/title`
  - `PUT /api/restful/maps/{id}/description`
  - `PUT /api/restful/maps/{id}/starred` (`"true"` or `"false"`)
  - `PUT /api/restful/maps/{id}/lock` (`"true"` to acquire, `"false"` to release)
  - `PUT /api/restful/maps/{id}/document/xml`
  - `PUT /api/restful/account/{password,firstname,lastname,locale}`
- `GET /api/restful/maps/{id}/starred` returns `text/plain` `"true"`/`"false"`, not a JSON boolean.
- `POST /api/restful/maps/{id}/labels` takes a **bare JSON integer** (e.g., `42`) as its request body.

### 3. Resource Creation & CORS Headers
- Creating, duplicating, or registering resources (`POST /maps`, `POST /users`, etc.) returns HTTP 201 with **both**:
  - `Location` header (e.g., `/api/restful/maps/123`)
  - `ResourceId` header (e.g., `123`)
- CORS must explicitly expose `Authorization`, `Location`, and `ResourceId` in `exposeHeaders`.

### 4. DTO Visibility & Asymmetry
- **`GET /api/restful/maps/{id}` (`RestMindmap`):** Omits `public` and `spamDetected` keys due to legacy Jackson getter annotations.
- **`GET /api/restful/maps/` (`RestMindmapInfo` list):** **Does** carry `public` (boolean) and `spamDetected` (hardcoded `false`).
- **`GET /api/restful/maps/{id}/metadata`:** Omits `isLocked` and `starred` keys. Clients infer lock status by checking if `isLockedBy` is non-null.
- **`GET /api/restful/labels/`:** Returns `{labels: [...]}` with **no `count`** property (unlike maps list which includes `count`).

### 5. Lock Management Semantics
- `PUT /api/restful/maps/{id}/lock` (body `"true"`): Returns HTTP 200 with `{ email: "user@example.com" }`.
- `PUT /api/restful/maps/{id}/lock` (body `"false"`): Returns **HTTP 204 with an empty body**.
- Lock lease duration: **30 minutes**. Locks expire automatically.

### 6. Map Filtering & Query Semantics (`?q=`)
- `?q=` is an overloaded namespace:
  - Reserved keywords: `all`, `my_maps`, `shared_with_me`, `starred`, `public`.
  - Any other value is treated as a **label title** (if no label matches, returns empty list).
- `?q=shared_with_me` is implemented as `!my_maps` (includes public maps the caller does not own).
- Map listings are capped at **500 maps before filtering**.

### 7. Mindmap History & Deletion
- History is capped at **30 revisions** per map.
- `POST /api/restful/maps/{id}/history/{historyId}/revert`: Reverting to a specific revision creates a new history entry; reverting to `latest` does not.
- `?minor=true` on document save suppresses history creation.
- `DELETE /api/restful/maps/{id}`:
  - If creator/owner: hard-deletes the mindmap, XML, history, and collaborations.
  - If collaborator (editor/viewer): removes only caller's collaboration (the "leave map" action).

### 8. Standard Error Format
Non-401 application errors return HTTP 400/403/404/409 with `RestErrors` shape:
```json
{
  "globalSeverity": "WARNING",
  "globalErrors": ["Error description message"],
  "fieldErrors": {
    "field": "Field-specific error message"
  }
}
```

---

## 7. Development & Coding Conventions

### TypeScript & Code Quality
- Strict typing enabled; never use `any` when an interface or generic can be defined.
- Run `bun run typecheck` and `bun test` before declaring any task complete.
- Use ES module imports with `.ts` extensions (`import { app } from "./app.ts";`).

### Database Repositories
- Located in `src/db/repos/`.
- All SQL queries use parameterized bindings (`?1`, `?2`, etc.).
- Always use typed row representations from `src/db/rows.ts`.
- Repositories return domain objects or row structures, never raw HTTP responses.

### Route Definitions
- Sub-routers created with `new Hono<Env>()` and mounted onto `app` in `src/app.ts`.
- `app = new Hono<Env>({ strict: false })` ensures both `/resource` and `/resource/` route identically.
- Access control enforced through middleware:
  - `requireUser`: Ensures caller is authenticated (`c.get("user")`).
  - `requireMapAccess(role)`: Validates permissions (`viewer`, `editor`, `owner`) on `/maps/:id`.
  - `requireAdmin`: Checks `isAdmin(user)` against `ADMIN_EMAIL` or admin flag.

### Testing Conventions
- Tests are written using Bun's native test runner (`import { describe, it, expect, beforeEach } from "bun:test"`).
- Tests drive the app in-memory using `app.fetch(req)` without binding to a network port.
- Before each test modifying data, reset the database via `resetDb()` from `test/helpers/db.ts`.

---

## 8. Anti-Patterns & Boundaries

| Anti-Pattern | Correct Approach |
| :--- | :--- |
| **Translating legacy Java code directly** | The Java codebase was retired. Build idiomatic TypeScript following existing repository and service patterns. |
| **Importing `bun:sqlite` in repos/services** | Always use `dbAdapter` from `src/db/client.ts` so code works on Cloudflare Workers / D1. |
| **Using `BEGIN TRANSACTION` directly in queries** | Use `dbAdapter.batch([...])` to ensure compatibility with Cloudflare D1. |
| **Altering REST JSON response keys** | Check `src/http/dto/` and tests. The frontend depends on exact casing and field visibility. |
| **Changing 204 No Content to 200 with body** | Certain endpoints (like unlock) require 204 empty body. Follow existing route specs. |
| **Modifying existing DB migration entries** | `src/db/migrate.ts` is append-only. Add new versions at the end of the `steps` array. |
| **Committing secrets or `.env`** | Never commit `.env`. Use `.env.example` as reference; set secrets in CI or Wrangler. |
