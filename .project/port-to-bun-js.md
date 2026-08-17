# Port WiseMapping core API to Bun + TypeScript + bun:sqlite

## Context

The WiseMapping backend is a ~28k LOC Spring Boot 4 / Java 24 app (`wise-api/`) with 65 REST
endpoints, 11 JPA entities, ~99 hand-written DAO methods, a 7-strategy spam pipeline, LDAP +
OAuth2, 5 cron batch jobs, and 13 i18n locales. Running it costs an always-on JVM sized ~1 GB.
The goal is a small, fast, cheap-to-host replacement: a single Bun process with an embedded
SQLite file, no JVM and no database container.

This is a **reimplementation, not a port** — no Java code is translated. The Java app is the
behavioral reference and stays in the repo untouched.

Decisions taken (do not revisit):

|                |                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scope**      | Core maps + auth only. Out: LDAP, OAuth2, spam pipeline, all 5 batch jobs, 21 admin endpoints, inactive-user/map machinery, Velocity email, i18n bundles (English literals), Ehcache, Micrometer/OTLP |
| **Database**   | Greenfield SQLite. No data migration, no legacy hash compatibility                                                                                                                                    |
| **Driver**     | `bun:sqlite` (built-in) — not better-sqlite3                                                                                                                                                          |
| **Deployment** | No production traffic. Java app is reference only; no strangler routing                                                                                                                               |

The hard constraint is the **frontend** (`github.com/wisemapping/wisemapping-frontend`, not in
this repo). It is a fixed consumer with exact expectations about JSON key names, content types,
and status codes. A wrong field name breaks the app silently. Everything below is subordinate to
that contract.

## Implementation status

**All six milestones are complete.** Implemented in `wise-api-bun/`: 42 routes,
155 tests passing, clean `tsc --noEmit`, verified end to end against a real
server and file-backed database.

Three corrections to this plan discovered during implementation:

1. **Hono's `route()` normalises the mount path**, so the plan's "register both
   trailing-slash spellings" instruction does not work — the two registrations
   collapse and the trailing-slash form 404s. The app is built with
   `strict: false` instead, which is safe because no two in-scope handlers differ
   only by a trailing slash on the same method.
2. **`bun:sqlite`'s `.get()` returns `null`, not `undefined`.** Every repository
   uses `== null`.
3. **Two DTOs silently drop fields**, which this plan did not capture:
   `RestMindmap` omits `public` and `spamDetected`, and `/metadata` omits
   `isLocked` and `starred` — all four are is-getters on classes that set
   `isGetterVisibility = NONE`. `RestMindmapInfo` declares its booleans as plain
   getters and therefore *does* carry `public` and `spamDetected`.

Also note the lock timings are two distinct constants: a lock lives **30 minutes**
(`LockInfo.EXPIRATION_MIN`), while the sweeper runs every **1 minute**
(`LockManagerImpl.ONE_MINUTE_MILLISECONDS`).

The remaining open item is unchanged: `RestUser.creationDate` is the one field
whose wire format was inferred rather than read off a getter, and still needs a
differential check against a running Java instance.

## Scope: 42 routes

All under `/api/restful`. Full inventory with content types is in `rest/MindmapController.java`
(30 of them) plus the five smaller controllers. Non-obvious contract facts, each verified:

- `POST /authenticate` returns the **bare JWT string as the body** (`text/plain`, no JSON, no
  quotes) _and_ sets `Authorization: Bearer <token>` as a **response** header. Both.
  (`rest/JwtAuthController.java:68-70`)
- 11 routes are `consumes = "text/plain"` with a raw string body: `PUT /maps/{id}/{title,
description,starred,lock}`, `PUT /maps/{id}/document/xml`, `PUT /account/{password,firstname,
lastname,locale}`.
- `GET /maps/{id}/document/xml` and `/xml-pub` produce `application/xml; charset=UTF-8`.
  `GET /maps/{id}/starred` produces `text/plain` `"true"`/`"false"`.
- `PUT /maps/{id}/lock` → 200 + `RestLockInfo` on lock, **204 empty on unlock**.
- Create/duplicate/register return 201 with both `Location` **and** a custom `ResourceId` header.
  CORS must expose them.
- **DTO JSON is defined by getter names, not fields** — 22 of 26 DTOs set
  `@JsonAutoDetect(fieldVisibility = NONE, getterVisibility = PUBLIC_ONLY)`. Six also set
  `isGetterVisibility = NONE`, which is why they define `getPublic()` / `getStarred()` instead of
  `isPublic()`. Transcribe every DTO's getter list literally from `rest/model/`.
- `RestMindmapInfo` exposes `getSpamDetected()` — the key must exist in the list response even
  though the spam pipeline is out of scope. Hardcode `false`.
- Trailing slashes are inconsistent and significant (`/maps/` and `/labels/` have one,
  `/maps` create does not). Register both spellings per route; do not add a normalizer.
- `POST /maps/{id}/labels` takes a **bare JSON integer** as the body.
- Error body is `RestErrors`: `{globalErrors: string[], fieldErrors: {field: msg},
globalSeverity: "WARNING"|...}`. But the 401 from the filter chain is a _different_ shape —
  `{"msg":"Unauthorized"}` — produced in `config/AppConfig.java:132`, bypassing the handler.

## Architecture

New sibling directory `wise-api-bun/` in this repo (not inside `wise-api/`, whose Maven resource
filtering would pick up stray files; not a separate repo, so side-by-side diffing stays easy).

```
wise-api-bun/
  src/
    index.ts            Bun.serve + graceful shutdown
    app.ts              Hono instance, middleware, route mounting
    config.ts           env -> frozen typed config, validated at import
    db/
      client.ts         Database + pragmas
      schema.sql        DDL
      migrate.ts        PRAGMA user_version runner
      rows.ts           snake_case row types mirroring the DDL
      repos/            accounts labels mindmaps mindmapXml history collaborations
    domain/
      roles.ts          Role + power table + roleSatisfies()
      errors.ts         AppError hierarchy -> status + RestErrors body
      xmlCodec.ts       the one storage seam
      mindmapXmlValidate.ts
      defaultMindmap.ts
    services/           authService accountService mindmapService labelService
                        collaborationService lockManager
    http/
      middleware/       jwt requireUser requireMapAccess errorHandler
      routes/           auth users account app labels maps mapsDocument
                        mapsCollabs mapsHistory mapsLabels
      dto/              one module per Rest* shape
  test/
```

**Framework: Hono.** Two runtime deps total (`hono`; `hono/jwt` covers JWT). Chosen because
non-JSON bodies are first-class (`c.req.text()`, `c.text()`, `c.body(s, 200, {headers})`) rather
than an escape hatch — 15 of 42 routes are `text/plain` or `application/xml`. Its middleware
model with a typed `Variables` generic is the natural shape for `requireMapAccess`. Bare
`Bun.serve` would mean reimplementing a router and middleware composition; Elysia's schema DSL
and 8-stage lifecycle are more machinery than 42 routes justify.

**Data access: raw `bun:sqlite` prepared statements, no ORM.** The core scope needs ~32 queries
(the other ~65 DAO methods serve admin/spam/batch, all out of scope). `db.query()` already
caches prepared statements keyed by SQL text, so an ORM buys little here and adds a second
toolchain. One `const` per SQL string in `db/repos/*.ts`; `snake_case` row interfaces in
`db/rows.ts`; a `map*Row()` per entity doing `0|1 → boolean` and `number → Date`. Multi-table
writes wrap in `db.transaction(fn)`.

## Schema

Full DDL in `db/schema.sql`. Design changes from `schema-postgresql.sql`, each deliberate:

- **Collapse `collaborator` + `account` into one `account` table.** The JOINED split exists only
  because JPA needed a supertype for "shared with an email that has no account yet". One table
  with a nullable `password_hash` (NULL = invitee placeholder) says the same thing, removes a
  join from every collaboration read, and kills the proxy-narrowing workarounds visible in
  `dao/MindmapManagerImpl.getMindmapById`.
- **Collapse `collaboration_properties` into `collaboration`.** Strictly 1:1, always fetched with
  its parent, two columns.
- **Keep `mindmap_xml` separate.** Not JPA noise — it is LAZY on purpose so `GET /maps/`
  (up to 500 rows) never pages in documents. There is a dedicated Java test for this
  (`model/MindmapXmlLazyLoadingTest.java`).
- **Roles as `TEXT CHECK (role IN ('owner','editor','viewer'))`**, not `role_id` ordinals.
  The wire format is already the lowercase name; ordinal storage means reordering an enum
  silently rewrites permissions.
- **Drop the single-char enum columns.** With LDAP/OAuth out, `authentication_type` has one value.
- **Timestamps as `INTEGER` Unix millis**; booleans as `INTEGER CHECK (x IN (0,1))`. SQLite has
  neither type natively. Format to ISO-8601 only at the DTO boundary.
- **`STRICT` tables** throughout — turns type confusion into an error instead of silent affinity
  coercion.
- **Add the indexes the current schema entirely lacks** (it declares zero). The three that matter:
  `ix_collab_account(account_id, mindmap_id)` drives the map list;
  `ix_history_map_created(mindmap_id, created_at DESC, id DESC)` is a covering index for the
  history list with no sort step; `ux_collab_map_account(mindmap_id, account_id)` turns the
  application-level find-or-create race into a DB guarantee (see `dao/CollaborationConstraintTest`).
- **Drop entirely:** `mindmap_spam_info`, `access_auditory`, `mindmap_inactive_user`, and the
  `account` columns for OAuth, suspension, and `authenticator_uri`.
- **No `collaboratorCount`.** The JPA `@Formula` on `model/Mindmap.java:118` is consumed only by
  `AdminRestMap` — out of scope. `RestMindmapInfo` has no such getter. Nothing to build.

Connection setup in `db/client.ts` — `journal_mode = WAL`, `foreign_keys = ON` (per-connection,
off by default, must run before any statement), `busy_timeout = 5000`,
`synchronous = NORMAL`, `cache_size = -16000`. Migrations keyed on `PRAGMA user_version`.

## XML storage: plain TEXT

Store map XML uncompressed as UTF-8 `TEXT` in `mindmap_xml.xml` and `mindmap_history.xml`.

The Java app wraps it in a single-entry ZIP named `"content"` (`util/ZipUtils.java`) whose only
value was on-disk compatibility — explicitly discarded by the greenfield decision. `Bun.gzipSync`
would save real space at scale (~80% on 2–30 KB documents) but costs a codec hop on every read
and makes `sqlite3 ... "select xml"`, `grep`, and every data-fix script useless. For a system
whose whole value is a document you will be eyeballing constantly during a rewrite, transparent
storage wins. Large TEXT lives in overflow pages, and because `mindmap_xml` is its own table,
listing queries never touch them.

All XML in/out goes through `domain/xmlCodec.ts` (`encodeXml`/`decodeXml`, identity for now) so
switching to gzip later is two function bodies, two column types, and one migration.

Validation ports `model/MindmapUtils.verifyMindmap` and the `endsWith("</map>")` check in
`MindmapServiceImpl.updateMindmap`. Note what it actually does: `startsWith("<map")` +
`endsWith("</map>")` + `split("<topic").length <= 4000`. **`mindmap.xsd` is referenced nowhere in
the codebase** — do not start validating against it, or you will reject maps the current server
accepts.

## Authorization

The 18 `@PreAuthorize` annotations, `MapAccessPermissionEvaluation`,
`MapPermissionsSecurityAdvice`, `ReadSecurityAdvise`, and `UpdateSecurityAdvise` collapse to one
predicate plus one middleware factory. The predicate is a line-for-line transcription of
`service/MindmapServiceImpl.java:71` — admin, then creator, then collaboration role, then
fall through to `map.isPublic && required === 'viewer'`.

`domain/roles.ts` inverts the comparison: Java does `role.ordinal() <= required.ordinal()` with
`OWNER=0/EDITOR=1/VIEWER=2`, which is correct but reads backwards and invites a wrong "fix". Use
a power table where bigger means more and compare with `>=`. Ordinals never touch storage, so
nothing depends on the numbering.

`http/middleware/requireMapAccess.ts` loads the map once, 404s if absent (never 403 — don't leak
existence), 401s if a write role is required with no user, then `c.set('map', map)` so the
handler needs no second SELECT. Applied per route so the required role is grep-able at the route
table:

```ts
maps.get("/:id", requireUser, requireMapAccess("viewer"), retrieve);
maps.get("/:id/metadata", requireMapAccess("viewer"), retrieveMetadata);
maps.put(
  "/:id/document",
  requireUser,
  requireMapAccess("editor"),
  updateDocument,
);
maps.put("/:id/publish", requireUser, requireMapAccess("owner"), updatePublish);
```

`requireMapAccess('viewer')` without `requireUser` is exactly the `permitAll()` public-map case.
The four owner-only checks that are inline `if (!hasPermissions(user, OWNER)) throw` in the Java
controller move onto the route. Acquire the edit lock **inside** the handler, after the
permission check, so a denied request never takes a lock.

Admin stays a configured email (a roles table for one principal is scope creep) but normalize
**both** sides with `.trim().toLowerCase()` — the Java version trims only the user's email, so a
config value with trailing whitespace silently grants nobody admin — and treat empty config as
"no admin exists". One comparison, in `isAdmin()`; today it is duplicated across four classes.

## Auth

JWT HS256, `sub` = email only, `iat`, `exp`; secret base64-decoded before use as the HMAC key;
default expiry 10080 min (`security/JwtTokenUtil.java`). Use `hono/jwt`. Keep `sub` = email
rather than id — it is what the existing token contract assumes and the per-request
`findByEmailLower` is covered by a unique index.

The global `jwt` middleware is **non-failing**: it sets `c.set('user', account | null)`.
`requireUser` is what 401s. That is what lets the two public map routes work without branching.

**Password hashing: `Bun.password` with argon2id.** Greenfield means `LegacyPasswordEncoder`
(unsalted SHA-1 with an `ENC:` prefix) and the `{bcrypt}` dispatch in
`DefaultPasswordEncoderFactories` are simply not needed. Keep the 8–40 char validation anyway
because the frontend enforces it client-side. `Bun.password.hash`/`verify` are async and run off
the main thread — always `await`, never the `*Sync` variants in a handler.

Two porting hazards, both the same class of bug — a 64-bit value silently losing precision as a
JS `number`:

1. **Activation code.** Java uses `UUID.randomUUID().getLeastSignificantBits()`, a signed 64-bit
   long passed as `?code=<19 digits>`. Generate with `BigInt64Array`, store as TEXT, compare as
   TEXT. `Number(code)` loses precision and activation silently always fails.
2. **Lock session id.** Java uses `System.nanoTime()`. `Bun.nanoseconds()` exceeds
   `Number.MAX_SAFE_INTEGER` within hours of uptime and this value round-trips to the frontend
   as JSON. Return a string.

Registration has one non-obvious step: if an **invitee placeholder** row already exists for that
email (created by a share before the person signed up), upgrade it in place —
`UPDATE ... WHERE id = ? AND password_hash IS NULL` — rather than inserting a second row. That is
what preserves collaborations granted pre-signup, and it replaces the two-table
`createUser(user, collaborator)` dance in `dao/UserManagerImpl`.

With no mailer in scope, log the activation and password-reset URLs to stdout. The endpoints and
flows stay real and testable; only the transport is stubbed.

## Locks

Port `service/LockManagerImpl.java` + `service/LockInfo.java` as a module singleton over
`Map<number, LockInfo>`. Verified constants: `MAX_LOCKS = 1000`, warn at 80%,
**TTL 30 minutes** (`LockInfo.java:30`), **sweeper every 1 minute** (`LockManagerImpl.java:38`) —
two different numbers, both needed.

- `lock()` refreshes `expiresAt` on every call — the lock is a lease and the frontend's save
  heartbeat is what keeps it alive.
- Expiry must be **lazy on read as well as swept**, or a stale lock survives up to 60s.
- `GET /maps/{id}/metadata` reports the holder's name only when someone _else_ holds it; your own
  lock reports as unlocked (`MindmapController.retrieveMetadata`).
- `unlockAll(user)` on `POST /logout` (replaces `listener/UnlockOnExpireListener`).
- `.unref()` the sweeper interval so it never holds the process open, and expose `shutdown()` —
  a leaked interval across `bun test` files is the usual way this bites.

Single-process only, inherited from the Java design. Document it in the README rather than
solving it.

## Config

`src/config.ts` reads `Bun.env`, coerces, validates, exports a frozen object; `.env.example`
documents it. ~15 keys replace the 74-key `application.yml`, most of which is Spring framework
config (Hikari, Hibernate, Ehcache, Micrometer, resilience4j) with no analogue here.

Keys: `PORT`, `DB_PATH`, `JWT_SECRET`, `JWT_EXPIRATION_MIN`, `ADMIN_EMAIL`, `UI_BASE_URL`,
`API_BASE_URL`, `CORS_ALLOWED_ORIGINS`, `REGISTRATION_ENABLED`, `EMAIL_CONFIRMATION_ENABLED`,
`CAPTCHA_ENABLED`, `CAPTCHA_SITE_KEY`, `ANALYTICS_ACCOUNT`, `MAP_LIST_MAX_SIZE`,
`NOTE_MAX_LENGTH`, `LOG_LEVEL`.

Two deliberate divergences: **`JWT_SECRET` is required and hard-fails** (Java merely logs a
warning when the hardcoded default is in use, so the default ships), and
`EMAIL_CONFIRMATION_ENABLED` defaults to `false` since there is no mailer.

`GET /app/config` reads straight off this object with `googleOauth2Enabled` /
`facebookOauth2Enabled` hardcoded `false`. Transcribe the field names from
`rest/model/RestAppConfig.java` literally — note it exposes the captcha fields as `recaptcha2*`
while the config keys are `captcha.*`.

## Milestones

Each ends in something runnable and testable. Sequenced so the riskiest contract questions (XML
round-trip, per-map authorization) settle early.

1. **Skeleton + schema + config** — scaffold, `config.ts` fail-fast, `db/client.ts` pragmas,
   `schema.sql`, `migrate.ts`, Hono app with `errorHandler` emitting `RestErrors`,
   `GET /app/config`, and a `bun test` fixture building an in-memory DB from `schema.sql`.
2. **Auth** — account repo, argon2, JWT, non-failing `jwt` middleware, `requireUser`,
   register/activate/login/logout, all six `/account` routes.
3. **Mindmap CRUD + XML** — mindmap/mindmapXml repos, `xmlCodec`, validation port, default-map
   generator, `hasMapPermission` + `requireMapAccess`, routes for get/list/create/delete/
   title/description/XML get+put.
4. **Sharing, starred, publish** — collaboration repo, the full list query with `my_role` /
   `my_starred`, `MindmapFilter` port (5 filters + label filter), collabs routes, owner guards.
   Most behavioral subtlety of any milestone; budget accordingly.
5. **History + revert + labels** — history repo with the save-on-non-minor rule, history routes,
   all label routes.
6. **Locks + metadata + hardening** — lockManager, lock route, `/metadata` incl. `?xml=true` and
   the other-user rule, `unlockAll` on logout, CORS with exposed headers, graceful shutdown.

## Behavioral quirks to reproduce, not fix

These are places where the obvious implementation differs from what the Java app does. Each is
frontend-visible.

- **`DELETE /maps/{id}` requires only READ**, and branches internally: creator → hard delete;
  non-creator → drop only their own collaboration. This is the "leave a shared map" path
  (`MindmapServiceImpl.removeMindmap`).
- **`?q=` is an overloaded namespace.** `rest/MindmapFilter.java` matches five reserved names
  (`all`, `my_maps`, `public`, `starred`, `shared_with_me`) and treats **any other string as a
  label title**. `shared_with_me` is literally `!my_maps`, so it includes public maps you don't own.
- **`GET /maps/` caps at 500 (`app.mindmap.list.max-size`) BEFORE filtering**, so a filter can
  return fewer results than exist.
- **History is capped at a hardcoded 30 entries** (`setMaxResults(30)` in
  `MindmapManagerImpl.getHistoryFrom`), and `findMindmapHistory(mapId, hid)` linear-scans that
  capped list — so an entry older than the 30 most recent is unreachable.
- **A revert itself creates a new history entry.**
- **`CollaborationProperties.getMindmapProperties()` defaults to `{"zoom":0.8}` in Java, not the
  DB.** Apply the default at read time.
- `?minor=true` on document save suppresses the history entry.
- Deleting a label unlinks it from maps without deleting them
  (`test/rest/RestMindmapDeleteWithLabelsTest`).

Two Java bugs worth **not** porting: the inline collab/publish checks throw
`IllegalArgumentException` → HTTP 400 where 403 is meant
(`MindmapController.updateCollabs`), and `Mindmap.escapeXmlAttribute` does
`replace("gt", "&gt;")` — replacing the literal letters `gt`, not `>`.

## Verification

1. **`bun test` as the primary suite.** Port assertions from the Java HTTP integration tests —
   `test/rest/RestMindmapControllerTest.java` (1543 LOC, 43 tests) is the closest thing to an
   executable spec for the map contract, plus `RestLabelControllerTest`,
   `RestAccountControllerTest`, `RestJwtAuthControllerTest`, `RestAppControllerTest`,
   `RestMindmapDeletionTest`, `RestMindmapDeleteWithLabelsTest`, and
   `dao/CollaborationConstraintTest`. Run against `app.fetch` with an in-memory DB per file — no
   server needed. Do this continuously, not as a final milestone.
2. **Differential testing against the Java app.** Run both servers, replay the same request
   sequence, diff status + headers + JSON keys. This is the only thing that catches a silently
   renamed field. Boot the Java app with `mvn -f wise-api/pom.xml spring-boot:run` (HSQLDB
   in-memory, seed users `test@wisemapping.org` / `password` and
   `admin@wisemapping.org` / `testAdmin123` from `data-hsqldb.sql`) and set
   `app.api.http-basic-enabled: true` as the test config does.
3. **Point the real frontend at the Bun server** at the end of milestone 2 (sign-in works) and
   again at milestone 4. Clone `wisemapping-frontend` separately per the README's "Option 2" and
   grep its API client for the field names it actually reads — that is the ground truth the DTO
   modules must match.
4. **Manual smoke path** end to end: register → activate (code from stdout) → login → create map
   → open in the frontend editor → save → check history → share as editor with a second account →
   verify that account can edit but not publish → star → filter by `?q=starred` → revert →
   delete.

## Critical files (Java reference)

- `wise-api/src/main/java/com/wisemapping/rest/MindmapController.java` — 30 of 42 routes;
  authoritative for paths, content types, status codes, trailing slashes
- `wise-api/src/main/java/com/wisemapping/rest/model/` — the JSON contract, getter by getter
- `wise-api/src/main/java/com/wisemapping/service/MindmapServiceImpl.java:71` — `hasPermissions`
- `wise-api/src/main/java/com/wisemapping/service/LockManagerImpl.java` + `LockInfo.java`
- `wise-api/src/main/java/com/wisemapping/security/JwtTokenUtil.java`
- `wise-api/src/main/java/com/wisemapping/rest/MindmapFilter.java`
- `wise-api/src/main/resources/schema-postgresql.sql` — the schema being replaced
- `wise-api/src/test/java/com/wisemapping/test/rest/` — the acceptance suite to port
