-- CE-OWNED tracker migration (tracker.* DDL ownership moved to this repo with
-- the engine migration; geo keeps only its historical migrations).
-- Source: geo PR #194 finding R22. APPLY AT GO-LIVE.
--
-- tracker.members previously allowed duplicate (org_id, user_id) rows, so a
-- user invited twice into one org got a non-deterministic membership row on
-- resolution — a latent tenant-isolation break in geo's tracker CRUD. This
-- service NEVER writes members rows (its tenancy is one org per team, no
-- members), but it inherits guardianship of the table.
--
-- PARTIAL (WHERE user_id IS NOT NULL): user_id is NULL for pending invites —
-- multiple pending invites per org are fine. Once accepted, user_id is stamped
-- and must be unique per org. Multi-org membership (same user across orgs)
-- remains allowed by design.

CREATE UNIQUE INDEX IF NOT EXISTS tracker_members_org_user_uniq
  ON tracker.members(org_id, user_id)
  WHERE user_id IS NOT NULL;
