-- ===========================================================================
-- Two-factor authentication (TOTP) persistence.
--   account_totp          -- one row per account, enrollment/activation state
--   account_recovery_code -- set-versioned, hash-only single-use codes
--   trusted_device        -- "remember this browser", absolute expiry
--   security_event        -- append-only audit trail for 2FA actions
--   account.session_epoch / account.two_factor_reenroll_required -- new columns
-- ===========================================================================
CREATE TABLE IF NOT EXISTS account_totp (
  account_id         INTEGER PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  secret_cipher      TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('pending', 'active')),
  last_accepted_step INTEGER,
  failed_attempts    INTEGER NOT NULL DEFAULT 0,
  cooldown_until     INTEGER,
  created_at         INTEGER NOT NULL,
  activated_at       INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS account_recovery_code (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  code_hash  TEXT    NOT NULL,
  generation INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_recovery_code_hash ON account_recovery_code (account_id, code_hash);
CREATE INDEX IF NOT EXISTS ix_recovery_code_unused ON account_recovery_code (account_id, used_at);

CREATE TABLE IF NOT EXISTS trusted_device (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS ix_trusted_device_account ON trusted_device (account_id, revoked_at);

CREATE TABLE IF NOT EXISTS security_event (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  affected_account_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  actor_email         TEXT    NOT NULL,
  action              TEXT    NOT NULL,
  outcome             TEXT    NOT NULL CHECK (outcome IN ('success', 'failure')),
  reason              TEXT,
  detail              TEXT,
  created_at          INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_security_event_account ON security_event (affected_account_id, created_at DESC, id DESC);

ALTER TABLE account ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account ADD COLUMN two_factor_reenroll_required INTEGER NOT NULL DEFAULT 0 CHECK (two_factor_reenroll_required IN (0, 1));
