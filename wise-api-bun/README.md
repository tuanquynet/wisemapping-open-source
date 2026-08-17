# wise-api-bun

A Bun + TypeScript + SQLite reimplementation of the **core** of the WiseMapping
API. The Java app in [`../wise-api/`](../wise-api/) is the behavioral reference
and is not modified.

Goal: one process, one file, no JVM and no database container.

## Status

| Milestone | Scope                                                                   | State    |
| --------- | ----------------------------------------------------------------------- | -------- |
| M1        | Skeleton, schema, migrations, config, error contract, `GET /app/config` | **done** |
| M2        | Auth: register, activate, login, logout, password reset, `/account`     | **done** |
| M3        | Mindmap CRUD + XML, `requireMapAccess`                                  | **done** |
| M4        | Sharing, starred, publish, map list + `?q=` filters                     | **done** |
| M5        | History + revert, labels                                                | **done** |
| M6        | Edit locks, `/metadata`, hardening                                      | **done** |

All 42 in-scope routes are implemented. `bun test` — 155 tests passing.
`bun run typecheck` — clean.

## Quick start

```sh
bun install
cp .env.example .env
# JWT_SECRET is required; the server refuses to start without it.
echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env
bun run dev            # http://localhost:8080
```

```sh
bun test               # full suite, in-memory DB, no server needed
bun run typecheck
```

## Deliberate differences from the Java app

Not accidents — each is a decision recorded here so it is not silently "fixed"
back:

- **Greenfield database.** No migration path from the Java schema, and none of
  its legacy password formats (`ENC:` unsalted SHA-1, `{bcrypt}` prefixes) are
  supported. Passwords are argon2id via `Bun.password`.
- **`JWT_SECRET` is required.** The Java app ships a hardcoded default and only
  logs a warning when it is still in use. Here an unset or too-short secret is a
  startup failure.
- **`EMAIL_CONFIRMATION_ENABLED` defaults to `false`.** There is no mailer in
  scope; when enabled, activation and password-reset URLs are written to stdout.
- **`PUT /users/resetPassword` always reports `EMAIL_SENT`.** The Java app throws
  `EmailNotExistsException` for an unknown address, which makes the endpoint an
  account-existence oracle.
- **Schema is redesigned**, not translated. `collaborator`/`account` are one
  table, `collaboration_properties` is folded into `collaboration`, roles are
  `TEXT` rather than enum ordinals, tables are `STRICT`, and indexes exist — the
  Java schema declares none, in any dialect.
- **403 where the Java app returns 400.** Its inline collaboration and publish
  checks throw `IllegalArgumentException`, and its `UndeclaredThrowableException`
  handler flattens every AOP-wrapped error to 400.
- **`Mindmap.escapeXmlAttribute`'s bug is not reproduced.** The Java version does
  `replace("gt", "&gt;")` — replacing the literal letters `gt`, not `>` — which
  corrupts any title containing them. `>` is escaped properly here.
- **Batch delete is atomic.** One transaction, so a partial batch cannot commit.
  The Java loop deletes maps one at a time and rethrows any failure as an access
  error, leaving earlier deletions applied.
- **Lock expiry is checked on read**, not only by the sweeper. The Java
  `getLockInfo` returns expired entries, so a stale lock blocks other editors for
  up to a minute. This can only ever release a lock earlier, never later.

## Contract notes

The frontend (`wisemapping-frontend`, a separate repository) is a fixed
consumer. Things that are easy to get wrong and are covered by tests:

- `POST /authenticate` returns the **bare JWT string** as the body — not JSON,
  not quoted — _and_ echoes it in an `Authorization: Bearer …` response header.
- Scalar update routes take **`text/plain`**, not JSON:
  `PUT /account/{password,firstname,lastname,locale}`.
- Error bodies are `{fieldErrors, globalSeverity, globalErrors}`, except the
  unauthenticated 401, which is `{"msg":"Unauthorized"}` — two shapes, matching
  the Java app's split between `GlobalExceptionHandler` and the security filter
  chain's entry point.
- `isActive`, `isSuspended` and `isAdmin` keep their `is` prefix; every other
  boolean drops it. This follows Jackson's `@JsonProperty` overrides on
  `RestUser`.
- **`GET /maps/{id}` has no `public` or `spamDetected` key.** `RestMindmap` sets
  `isGetterVisibility = NONE` and declares those two as is-getters, so Jackson
  drops them. `RestMindmapInfo` (the list DTO) declares them as plain getters and
  therefore _does_ carry both. Same concept, two different payloads.
- **`/metadata` has no `isLocked` or `starred` key**, for the same reason — only
  `isPublic()` survives there, because it alone carries `@JsonProperty("public")`.
  Clients read lock state from `isLockedBy` being non-null.
- `PUT /maps/{id}/lock` returns 200 + `{email}` on lock but **204 with an empty
  body** on unlock.
- `GET /maps/{id}/starred` returns `text/plain` `"true"`/`"false"`, not JSON.
- `POST /maps/{id}/labels` takes a **bare JSON integer** as its body.
- `GET /labels/` returns `{labels: [...]}` with **no `count`**, unlike every other
  list response.
- Creates return 201 with both `Location` and a custom `ResourceId` header. CORS
  must expose them or the browser cannot read them.
- The app is built with Hono's `strict: false`, so `/users` and `/users/` both
  route. The Java controllers are inconsistent about trailing slashes and the
  frontend calls whichever spelling each controller declared.

### Open item

`RestUser.creationDate` is emitted as an ISO-8601 string. In the Java app that
field is a raw `java.util.Calendar` left to Jackson, so the exact format depends
on the effective `ObjectMapper` configuration. **This is the one field whose wire
format was inferred rather than read off a getter** — confirm it against a
running Java instance before pointing a real frontend at this server.

## Behaviour reproduced on purpose

Places where the obvious implementation differs from what the Java app does. Each
is covered by a test that says so:

- **`DELETE /maps/{id}` needs only viewer permission.** The creator hard-deletes;
  anyone else just drops their own collaboration. That second branch is the
  "leave a shared map" action.
- **`?q=` is an overloaded namespace.** Five reserved names, and _any_ other value
  is a label title — so an unknown filter silently matches nothing.
- **`?q=shared_with_me` is literally `!my_maps`**, so it includes public maps you
  don't own, not just maps shared with you.
- **The 500-map cap applies before filtering**, so a filter can return fewer
  results than actually match.
- **History is capped at 30 entries**, and an older revision is unreachable by id
  even though the row still exists.
- **Reverting to a specific revision writes a new history entry; reverting to
  `latest` does not.** Same endpoint, opposite behaviour.
- **`{"zoom":0.8}` is applied at read time**, not as a column default.
- `?minor=true` on a document save suppresses the history entry.
- Deleting a label unlinks it from maps without deleting them.
- `mindmap.xsd` exists in the Java resources but is referenced nowhere, so no XSD
  validation happens here either. Adding it would reject documents the current
  server accepts.

## Constraints

- **Single process only.** Edit locks are in-memory (M6), as in the Java app, so
  the API cannot be horizontally scaled without moving them to SQLite or Redis.
- SQLite runs in WAL mode with `foreign_keys` on. Back up by copying the `.db`
  file with the server stopped, or via `VACUUM INTO`.

## Layout

```
src/
  config.ts        env -> frozen typed config, validated at import
  app.ts           Hono instance, middleware order, route mounting
  index.ts         Bun.serve + graceful shutdown
  db/              client (pragmas), schema.sql, migrate, row types, repos/
  domain/          errors, shared types
  services/        business logic
  http/            middleware/, routes/, dto/ (one module per Rest* shape)
util/              logger, jwt, iso8601
test/              bun test, driven through app.fetch
```
