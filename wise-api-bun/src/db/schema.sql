-- ---------------------------------------------------------------------------
-- WiseMapping core schema (SQLite).
--
-- Greenfield: this is NOT a translation of schema-postgresql.sql. Deliberate
-- differences from the Java schema, each justified:
--
--   * `collaborator` and `account` are ONE table. The JPA JOINED-inheritance
--     split existed only so a map could be shared with an email that has no
--     registered account. A nullable password_hash says the same thing and
--     removes a join from every collaboration read.
--   * `collaboration_properties` is folded into `collaboration` (strictly 1:1,
--     always loaded with its parent, two columns).
--   * `mindmap_xml` stays a separate table -- not JPA noise. It is lazily
--     loaded on purpose so listing up to 500 maps never pages in documents.
--   * Roles are TEXT, not the ordinal `role_id SMALLINT` the Java app stores.
--     Reordering an enum must not silently rewrite everyone's permissions.
--   * Timestamps are INTEGER Unix milliseconds; booleans are INTEGER 0/1.
--     SQLite has neither type natively.
--   * STRICT tables everywhere, so type confusion is an error rather than
--     silent affinity coercion.
--   * Indexes exist. The Java schema declares zero, in any dialect.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- account -- registered users AND not-yet-registered share targets.
--   password_hash IS NULL => invitee placeholder; cannot log in.
--   activated_at  IS NULL => registered but not yet activated.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS account (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  email               TEXT    NOT NULL,
  email_lower         TEXT    NOT NULL,
  firstname           TEXT,
  lastname            TEXT,
  password_hash       TEXT,
  locale              TEXT,
  -- Stored as TEXT: the Java activation code is a signed 64-bit long, which
  -- loses precision as a JS number. Never parse it, only compare it.
  activation_code     TEXT,
  activated_at        INTEGER,
  reset_token         TEXT,
  reset_token_expires INTEGER,
  created_at          INTEGER NOT NULL,
  CONSTRAINT account_registered_complete CHECK (
    password_hash IS NULL
    OR (firstname IS NOT NULL AND lastname IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_account_email_lower
  ON account (email_lower);
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_activation_code
  ON account (activation_code) WHERE activation_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_reset_token
  ON account (reset_token) WHERE reset_token IS NOT NULL;

-- ===========================================================================
-- mindmap
-- ===========================================================================
CREATE TABLE IF NOT EXISTS mindmap (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL,
  description    TEXT,
  is_public      INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  creator_id     INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  last_editor_id INTEGER NOT NULL REFERENCES account (id),
  created_at     INTEGER NOT NULL,
  edited_at      INTEGER NOT NULL,
  source_type    TEXT    NOT NULL DEFAULT 'local' CHECK (source_type IN ('local', 'gdrive')),
  source_id      TEXT
) STRICT;

-- MapInfoValidator rejects a duplicate title for the same creator; make the
-- database enforce it rather than trusting a check-then-insert.
CREATE UNIQUE INDEX IF NOT EXISTS ux_mindmap_creator_title
  ON mindmap (creator_id, title);
CREATE INDEX IF NOT EXISTS ix_mindmap_creator
  ON mindmap (creator_id);
CREATE INDEX IF NOT EXISTS ix_mindmap_source
  ON mindmap (creator_id, source_type, source_id);

-- ===========================================================================
-- mindmap_xml -- separate table so `SELECT ... FROM mindmap` never reads
-- document overflow pages.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS mindmap_xml (
  mindmap_id INTEGER PRIMARY KEY REFERENCES mindmap (id) ON DELETE CASCADE,
  xml        TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- ===========================================================================
-- mindmap_history
-- ===========================================================================
CREATE TABLE IF NOT EXISTS mindmap_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mindmap_id INTEGER NOT NULL REFERENCES mindmap (id) ON DELETE CASCADE,
  editor_id  INTEGER NOT NULL REFERENCES account (id),
  xml        TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- Covering the newest-first capped history listing, so there is no sort step.
CREATE INDEX IF NOT EXISTS ix_history_map_created
  ON mindmap_history (mindmap_id, created_at DESC, id DESC);

-- ===========================================================================
-- labels
-- ===========================================================================
CREATE TABLE IF NOT EXISTS mindmap_label (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  color      TEXT    NOT NULL,
  creator_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_label_creator_title
  ON mindmap_label (creator_id, title);

CREATE TABLE IF NOT EXISTS mindmap_label_link (
  mindmap_id INTEGER NOT NULL REFERENCES mindmap (id) ON DELETE CASCADE,
  label_id   INTEGER NOT NULL REFERENCES mindmap_label (id) ON DELETE CASCADE,
  PRIMARY KEY (mindmap_id, label_id)
) STRICT, WITHOUT ROWID;

-- Reverse direction: "delete this label -> which maps" and label-filtered lists.
CREATE INDEX IF NOT EXISTS ix_label_link_label
  ON mindmap_label_link (label_id);

-- ===========================================================================
-- collaboration -- who can see which map, with their per-user view state.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS collaboration (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  mindmap_id         INTEGER NOT NULL REFERENCES mindmap (id) ON DELETE CASCADE,
  account_id         INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  role               TEXT    NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  starred            INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
  -- NULL is read back as '{"zoom":0.8}' -- the Java default lives in
  -- CollaborationProperties.getMindmapProperties(), not in the database.
  mindmap_properties TEXT,
  created_at         INTEGER NOT NULL
) STRICT;

-- The invariant CollaborationConstraintTest asserts, and what lets the
-- find-or-create in MindmapManagerImpl stop being a race.
CREATE UNIQUE INDEX IF NOT EXISTS ux_collab_map_account
  ON collaboration (mindmap_id, account_id);
-- The hot path: "every map I can see" drives from here.
CREATE INDEX IF NOT EXISTS ix_collab_account
  ON collaboration (account_id, mindmap_id);
-- Exactly one owner per map.
CREATE UNIQUE INDEX IF NOT EXISTS ux_collab_one_owner
  ON collaboration (mindmap_id) WHERE role = 'owner';
