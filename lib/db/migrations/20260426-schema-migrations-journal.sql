-- ES-wave-3 §A2 AC-A2-1 — lightweight migration journal.
--
-- Records which migration files have been applied + when + by whom. Adds a
-- minimal audit trail without forcing the team to relocate to drizzle-kit's
-- ./drizzle directory + meta/_journal.json snapshot system.
--
-- Chicken-and-egg note: this file CREATES the journal table, so the row that
-- records THIS file must be inserted by the same statement (or by the runner
-- right after the CREATE). The backfill block at the bottom inserts a row
-- per existing migration — including this one — using ON CONFLICT DO NOTHING
-- so re-runs are no-ops (HP-W3-MIN-1).
--
-- The runner script (scripts/migrations/apply-pending.ts) computes a
-- checksum for new migrations applied through the runner; backfilled rows
-- carry NULL in `checksum`.

CREATE TABLE IF NOT EXISTS __schema_migrations (
  filename    text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT NOW(),
  applied_by  text        NOT NULL DEFAULT current_user,
  checksum    text
);

-- Backfill rows for every existing migration. ON CONFLICT (filename) DO
-- NOTHING per HP-W3-MIN-1 so concurrent operator runs and re-applies are
-- absorbed safely.
INSERT INTO __schema_migrations (filename, applied_at, applied_by, checksum)
VALUES
  ('20260302-batch-id.sql',                          NOW(), 'backfill-2026-04-26', NULL),
  ('20260302-citation-checks.sql',                   NOW(), 'backfill-2026-04-26', NULL),
  ('20260302-rate-limit-persistence.sql',            NOW(), 'backfill-2026-04-26', NULL),
  ('20260303-api-clients-created-by.sql',            NOW(), 'backfill-2026-04-26', NULL),
  ('20260303-api-clients.sql',                       NOW(), 'backfill-2026-04-26', NULL),
  ('20260304-crawl-failed-urls.sql',                 NOW(), 'backfill-2026-04-26', NULL),
  ('20260304-crawl-fanout-columns.sql',              NOW(), 'backfill-2026-04-26', NULL),
  ('20260314-per-page-fixes.sql',                    NOW(), 'backfill-2026-04-26', NULL),
  ('20260323-tree-columns.sql',                      NOW(), 'backfill-2026-04-26', NULL),
  ('20260324-tier2-columns.sql',                     NOW(), 'backfill-2026-04-26', NULL),
  ('20260324-tier3-columns.sql',                     NOW(), 'backfill-2026-04-26', NULL),
  ('20260324-tier4-columns.sql',                     NOW(), 'backfill-2026-04-26', NULL),
  ('20260325-brand-keywords-categories.sql',         NOW(), 'backfill-2026-04-26', NULL),
  ('20260325-prompt-architecture-version.sql',       NOW(), 'backfill-2026-04-26', NULL),
  ('20260402-consent-records.sql',                   NOW(), 'backfill-2026-04-26', NULL),
  ('20260404-hallucination-risk.sql',                NOW(), 'backfill-2026-04-26', NULL),
  ('20260409-auto-discovered-url-count.sql',         NOW(), 'backfill-2026-04-26', NULL),
  ('20260409-tree-extraction-failed-at.sql',         NOW(), 'backfill-2026-04-26', NULL),
  ('20260415-es090-security-hardening.sql',          NOW(), 'backfill-2026-04-26', NULL),
  ('20260421-add-pre-analyze-done.sql',              NOW(), 'backfill-2026-04-26', NULL),
  ('20260421-pageviews-api-blocking.sql',            NOW(), 'backfill-2026-04-26', NULL),
  ('20260426-re-audit-actions.sql',                  NOW(), 'backfill-2026-04-26', NULL),
  ('20260426-pre-analyze-done-set-not-null.sql',     NOW(), 'backfill-2026-04-26', NULL),
  ('20260426-schema-migrations-journal.sql',         NOW(), 'backfill-2026-04-26', NULL)
ON CONFLICT (filename) DO NOTHING;
