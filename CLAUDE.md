# CLAUDE.md

This file provides guidance to AI assistants working with code in this repository.

## What this repo is

The REST API backend for WiseMapping, written in TypeScript using **Bun + Hono + SQLite** (`wise-api-bun/`). It provides authentication, mindmap CRUD, sharing, export/import XML, revision history, starred maps, labels, and admin management for the separately-versioned frontend (`wisemapping-frontend`).

> **Note:** The backend has been completely migrated to **Bun + Hono + SQLite** (`wise-api-bun/`).

The frontend is **not** in this repo. Local dev requires checking out `https://github.com/wisemapping/wisemapping-frontend` separately and pointing it at this API.

## Common commands

All backend commands are run inside the `wise-api-bun/` directory using `bun`.

```sh
cd wise-api-bun

# Setup
bun install
cp .env.example .env
# Set JWT_SECRET (required for server startup)
echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env

# Development & Running (Bun)
bun run dev              # dev server with hot reload (http://localhost:8080)
bun start                # production start (bun src/index.ts)

# Development & Running (Cloudflare Workers + D1)
bunx wrangler d1 migrations apply DB --local   # apply D1 migrations locally
bunx wrangler dev --local --port 8080          # local Workers dev server with D1 & DO
bun run scripts/verify-worker-e2e.ts           # run 14-step E2E verification on Workers
bunx wrangler deploy                           # deploy to Cloudflare Workers

# Testing & Quality
bun test                 # run full test suite (193 tests, in-memory SQLite DB)
bun run typecheck        # TypeScript type check (tsc --noEmit)

## Configuration model

Configuration is managed via environment variables (loaded from `.env` file via `src/config.ts`):

Key environment variables (see `.env.example` for the full set — this highlights the ones that most affect startup):
- `PORT` — server port (default: `8080`).
- `JWT_SECRET` — **Required**. Startup fails if unset or under 32 chars.
- `DB_PATH` — path to SQLite database file (default: `./data/wisemapping.db`; use `:memory:` for testing).
- `EMAIL_CONFIRMATION_ENABLED` — boolean (default: `false`). When `true`, activation and password reset tokens are logged to stdout.
- `UI_BASE_URL` / `API_BASE_URL` — base URLs used for links and CORS (defaults: `http://localhost:3000` / `http://localhost:8080`).

## Architecture (big picture)

Single-process Bun HTTP server built with Hono and `bun:sqlite`. Entry point: `src/index.ts`.

```
src/
  config.ts        Env vars -> frozen typed config validated at startup
  app.ts           Hono instance, middleware order, route mounting
  index.ts         Bun.serve + graceful shutdown
  db/              SQLite client, pragmas, schema.sql, migrations, repositories
  domain/          Domain errors and shared entity types
  services/        Business logic (MindmapService, UserService, etc.)
  http/            Routes, middleware (JWT auth, map access validation), DTOs
util/              Logger, JWT helpers, ISO-8601 utilities
test/              bun test suite driving app.fetch against in-memory DB
```

### Key Architectural Features
- **Dual Deployment Targets:** Supports both single-process Bun (`bun:sqlite` + in-memory locks) and Cloudflare Workers (Cloudflare D1 via `D1Adapter` + Cloudflare Durable Objects via `MapLockDurableObject`).
- **Password Hashing:** Argon2id on Bun (`Bun.password`) and WebCrypto PBKDF2 (SHA-512, 100k iter) on Workers (`workerPasswordHasher`).
- **Strict Error & Type Handling:** Standardized error contracts (`{fieldErrors, globalSeverity, globalErrors}`).
- **REST Route Coverage:** All 42 REST routes required by `wisemapping-frontend` implemented and verified on both runtimes.
- **Frontend Compatibility:** `wisemapping-frontend` requires zero code changes (config change only).
## Code conventions

- **TypeScript:** Strict type checking enabled (`bun run typecheck`).
- **Imports:** Use ES module syntax (`import ... from ...`).
- **HTTP Routing:** Hono framework routing (`src/http/routes/`).
- **Database:** Repositories in `src/db/repos/` executing parameterised SQLite queries.
- **Testing:** Unit & integration tests in `test/` running via `bun test` against an in-memory SQLite database.

<!-- bmad:context -->
<!-- Verified 2026-08-16 against fb78c50acb3ec4a9af4ea15b789b68fe8b1b01f5. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## Policy

- Treat `wise-api-bun` as dev/pre-cutover, not production-authoritative: CI (`maven.yml`, `docker-api-publish.yml`, `docker-app-publish.yml`) still builds and publishes production Docker images from the legacy `wise-api/` Java jar.

## Where things are

- Adding a migration? Read the module comment in `wise-api-bun/src/db/migrate.ts` first — steps are append-only; editing an already-shipped step desyncs deployed databases.

## Running and verifying

- Automated CI runs in `.github/workflows/cloudflare-deploy.yml` on every push/PR touching `wise-api-bun/**`, executing `bun test`, `bun run typecheck`, and `wrangler deploy --dry-run`.
- Run `bun test` and `bun run typecheck` locally before pushing.
<!-- /bmad:context -->