-- Task 7.1 — Add userId, teamId, magicLink, stripeChargeId to audit_purchases.
-- Additive only — no destructive changes. Existing rows leave new columns NULL.
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when re-applied.

ALTER TABLE audit_purchases
  ADD COLUMN IF NOT EXISTS user_id          text,
  ADD COLUMN IF NOT EXISTS team_id          text,
  ADD COLUMN IF NOT EXISTS magic_link       text,
  ADD COLUMN IF NOT EXISTS stripe_charge_id text;

CREATE INDEX IF NOT EXISTS audit_purchases_stripe_charge_idx
  ON audit_purchases (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_purchases_team_id_idx
  ON audit_purchases (team_id)
  WHERE team_id IS NOT NULL;
