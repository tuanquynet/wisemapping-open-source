# Deploying `wise-api-bun` to Cloudflare Workers + D1 (SQLite)

This guide documents how to deploy the WiseMapping API backend (`wise-api-bun`) to Cloudflare's serverless edge platform using **Cloudflare Workers**, **Cloudflare D1** (serverless SQLite), and **Cloudflare Durable Objects** (for collaborative edit locks).

---

## Architecture Overview

`wise-api-bun` supports two native deployment targets sharing the same 42 REST API routes and business logic:

1. **Bun runtime** (default for local development & single-process Docker):
   - Fast, embedded SQLite via `bun:sqlite` (WAL mode).
   - In-memory `Map` with periodic sweep timer for collaborative edit locks.
   - Argon2id password hashing via `Bun.password`.

2. **Cloudflare Workers runtime** (edge-native deployment):
   - Serverless distributed SQLite via **Cloudflare D1** (`D1Adapter`).
   - Distributed edit lock lease management via **Cloudflare Durable Objects** (`MapLockDurableObject` with `alarm()`-driven 30-minute lease expiry).
   - Native WebCrypto PBKDF2 password hashing (SHA-512, 100,000 iterations, OWASP standard) running inside `crypto.subtle`.

---

## Prerequisites

- [Bun](https://bun.sh) (v1.1+)
- A [Cloudflare account](https://dash.cloudflare.com)
- Cloudflare Workers Paid plan (required for Durable Objects)
- Logged into Wrangler:
  ```sh
  bunx wrangler login
  ```

---

## Deployment Steps

### 1. Create the D1 Database

Run the following command to create a new D1 database on your Cloudflare account:

```sh
cd wisemapping-open-source/wise-api-bun
bunx wrangler d1 create wise-api-bun-prod
```

This will output your `database_name` and `database_id`, for example:
```toml
[[d1_databases]]
binding = "DB"
database_name = "wise-api-bun-prod"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 2. Configure `wrangler.toml`

Open `wrangler.toml` and update the `[[d1_databases]]` section with your actual production `database_id`:

```toml
name = "wise-api-bun"
main = "src/workers.ts"
compatibility_date = "2024-09-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "wise-api-bun-prod"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[[durable_objects.bindings]]
name = "MAP_LOCKS"
class_name = "MapLockDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["MapLockDurableObject"]
```

### 3. Apply D1 Database Migrations

Apply the base schema migration to your remote D1 database:

```sh
bunx wrangler d1 migrations apply DB --remote
```

This applies `migrations/0001_base_schema.sql` (all 20 DDL statements: 6 STRICT tables, 14 indexes/constraints).

### 4. Set Environment Secrets

Set the required secrets in Cloudflare Workers using `wrangler secret put`:

```sh
# Required: 32+ byte base64-encoded JWT HMAC key
openssl rand -base64 48 | bunx wrangler secret put JWT_SECRET

# Optional: Admin user email
echo "admin@example.com" | bunx wrangler secret put ADMIN_EMAIL

# Optional: Site base URLs & CORS allowed origins
echo "https://app.wisemapping.com" | bunx wrangler secret put UI_BASE_URL
echo "https://app.wisemapping.com" | bunx wrangler secret put CORS_ALLOWED_ORIGINS
```

### 5. Deploy the Worker

Deploy the application to Cloudflare Workers:

```sh
bunx wrangler deploy
```

Wrangler will output the live URL of your deployed Worker (e.g. `https://wise-api-bun.<subdomain>.workers.dev`).

---

## Automated CI/CD (GitHub Actions)

The repository includes an automated workflow at `.github/workflows/cloudflare-deploy.yml`:

- **Pull Requests / Pushes to `develop` or `main`**: runs `bun test`, `bun run typecheck`, and `wrangler deploy --dry-run` to validate the bundle.
- **Manual Trigger (`workflow_dispatch`) or Git Tags (`cf-deploy-*`)**: automatically applies remote D1 migrations and deploys the Worker to Cloudflare using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

---

## Frontend Integration (`wisemapping-frontend`)

**Zero frontend code changes are required.**

The frontend application (`wisemapping-frontend`) is a runtime-agnostic client that communicates with the API exclusively via standard REST endpoints and JWT Bearer authentication headers.

To connect the frontend to your Cloudflare Worker:
1. Update `apiBaseUrl` in the frontend's configuration (e.g. `config.prod.json` or environment build setting) to point to your Worker URL (`https://wise-api-bun.<subdomain>.workers.dev`).
2. Ensure `CORS_ALLOWED_ORIGINS` on the Worker includes the domain hosting your frontend.

---

## Local Development & Testing

You can test the entire Cloudflare Workers stack locally (with local D1 and Durable Object emulation) without touching remote cloud resources:

```sh
cd wisemapping-open-source/wise-api-bun

# 1. Apply migration locally
bunx wrangler d1 migrations apply DB --local

# 2. Start local Workers dev server
bunx wrangler dev --local --port 8080

# 3. Run E2E test suite against local Worker
bun run scripts/verify-worker-e2e.ts
```
