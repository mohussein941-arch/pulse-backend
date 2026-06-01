-- Session D3: enforce at-most-one-primary email account per user at DB level
-- Closes TECH_DEBT item from m3d.4 OAuth saga (commit edea803).

CREATE UNIQUE INDEX IF NOT EXISTS email_accounts_one_primary_per_user
  ON email_accounts (user_id)
  WHERE is_primary = true;
