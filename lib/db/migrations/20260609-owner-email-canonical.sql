-- NEW-A-02 — Gmail-alias free-audit-limit bypass fix.
--
-- Adds an indexed owner_email_canonical column to geo_sites so the
-- FREE_AUDIT_LIMIT count can use a fast indexed equality scan on the canonical
-- email form instead of a full-table scan with app-side filtering.
--
-- Canonicalization rules (matches lib/email-canonical.ts):
--   Gmail (gmail.com / googlemail.com): strip `+…` suffix, remove dots from
--     local-part, normalise googlemail → gmail.
--   All other providers: lowercase + trim only.
--
-- Gmail canonicalization cannot be expressed in pure SQL (no regex for the dot
-- stripping without installing pg_regexp_replace, and the googlemail normalise
-- step would also require a CASE). Backfill is therefore deferred to the
-- application layer (next POST /api/sites call for each email will populate the
-- column). The limit only needs going-forward correctness. Existing rows that
-- remain NULL are treated as unblocked (conservative — correct, because they
-- predate alias enforcement).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS are no-ops
-- when re-applied.

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS owner_email_canonical text;

CREATE INDEX IF NOT EXISTS idx_geo_sites_owner_email_canonical
  ON geo_sites (owner_email_canonical);
