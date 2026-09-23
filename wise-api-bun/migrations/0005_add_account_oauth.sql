-- ===========================================================================
-- account_oauth: records linked OAuth provider identities per account.
-- Enables linking existing password-based accounts to SSO providers (e.g. Google)
-- while preserving password authentication and preventing account duplication.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS account_oauth (
  account_id       INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  provider         TEXT    NOT NULL,
  provider_user_id TEXT,
  email            TEXT    NOT NULL,
  linked_at        INTEGER NOT NULL,
  PRIMARY KEY (account_id, provider)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_account_oauth_email ON account_oauth (email);
