-- TOS/EULA click-wrap consent records (legal, immutable)
CREATE TABLE IF NOT EXISTS consent_records (
  id           text PRIMARY KEY,
  user_id      text NOT NULL,
  email        text NOT NULL,
  tos_version  text NOT NULL,
  eula_version text NOT NULL,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  ip_address   text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup: "has this user consented?"
CREATE INDEX IF NOT EXISTS idx_consent_records_user_id ON consent_records(user_id);

-- Prevent duplicate consent rows per user per version combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_user_versions ON consent_records(user_id, tos_version, eula_version);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Consent records are a legal audit trail. Once written they must be immutable.
-- No UPDATE or DELETE policies are defined — rows cannot be modified or removed
-- by anyone, including the record owner.

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;

-- Service role (used by API routes via the admin client) may insert.
-- The policy checks that the inserting user_id matches auth.uid() OR that the
-- request is made via the service role (which bypasses RLS entirely — this
-- policy applies to anon/authenticated JWT requests only).
CREATE POLICY consent_insert
  ON consent_records
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid()::text);

-- Authenticated users may read their own consent history.
CREATE POLICY consent_select_own
  ON consent_records
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid()::text);

-- No UPDATE policy — immutable by omission.
-- No DELETE policy — immutable by omission.
