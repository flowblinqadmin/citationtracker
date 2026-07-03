# Migration runner — runbook

ES-wave-3 §A2 AC-A2-4. Authoritative reference for applying schema migrations to local + production environments.

## Authoring a migration

1. Create a SQL file under `lib/db/migrations/` named `YYYYMMDD-short-description.sql`. Lexicographic ordering = chronological ordering; use `YYYYMMDD-N-name.sql` if multiple migrations land on the same day.
2. Body is plain SQL. Prefer `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ALTER COLUMN ... SET NOT NULL` (idempotent on already-NOT-NULL columns), so re-running on partially-applied prod is safe.
3. Update `lib/db/schema.ts` to match. The schema-drift Vitest test (`__tests__/schema-drift.test.ts`) snapshots the column NAME set per table — extend its snapshot when adding columns.
4. Commit + push. PR review covers SQL correctness.

## Local-dev fast iteration

- `npm run db:push:local` — drizzle-kit `push --force` against the local Supabase (127.0.0.1:54322). Fast, schema-only, no journal entry. Use for in-development iteration on uncommitted schema changes.
- `npm run db:migrate:apply-pending` — applies any new migration files in lex order to the local DB and records them in `__schema_migrations`. Use for verifying a freshly-authored migration end-to-end before opening a PR.

## Production

After deployment of a PR that includes new migration files:

```
DATABASE_URL=postgresql://...prod-host... \
  npm run db:migrate:apply-pending -- --prod
```

The `--prod` flag is required when `DATABASE_URL` points at a non-local host (anything other than 127.0.0.1 or localhost). Without it the runner refuses to fire — guards against accidentally running against prod from a developer shell.

The runner:
1. Reads `lib/db/migrations/*.sql` in lex order.
2. Queries `__schema_migrations` for already-applied filenames (skipped silently).
3. Applies each pending file inside its own transaction.
4. Records the filename + sha256 checksum in the journal on success.
5. Logs each step (filename + truncated checksum prefix).

Concurrent runs: `ON CONFLICT (filename) DO NOTHING` on the journal absorbs the race; whichever process inserts first wins, the other no-ops on its INSERT but still runs its (idempotent) DDL. **Convention**: only one operator runs migrations at a time. A future enhancement (out of scope for ES-wave-3) is a PostgreSQL advisory lock around the apply loop.

## Journal table

```sql
CREATE TABLE __schema_migrations (
  filename    text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT NOW(),
  applied_by  text        NOT NULL DEFAULT current_user,
  checksum    text                          -- NULL for backfilled rows; sha256 hex for runner-applied
);
```

Created by `lib/db/migrations/20260426-schema-migrations-journal.sql` with a backfill block listing every migration that existed at that time. Backfilled rows carry `applied_by='backfill-2026-04-26'` and `checksum=NULL`.

### Existing migration files (covered by the backfill)

- 20260302-batch-id.sql
- 20260302-citation-checks.sql
- 20260302-rate-limit-persistence.sql
- 20260303-api-clients-created-by.sql
- 20260303-api-clients.sql
- 20260304-crawl-failed-urls.sql
- 20260304-crawl-fanout-columns.sql
- 20260314-per-page-fixes.sql
- 20260323-tree-columns.sql
- 20260324-tier2-columns.sql
- 20260324-tier3-columns.sql
- 20260324-tier4-columns.sql
- 20260325-brand-keywords-categories.sql
- 20260325-prompt-architecture-version.sql
- 20260402-consent-records.sql
- 20260404-hallucination-risk.sql
- 20260409-auto-discovered-url-count.sql
- 20260409-tree-extraction-failed-at.sql
- 20260415-es090-security-hardening.sql
- 20260421-add-pre-analyze-done.sql
- 20260421-pageviews-api-blocking.sql
- 20260426-re-audit-actions.sql
- 20260426-pre-analyze-done-set-not-null.sql
- 20260426-schema-migrations-journal.sql

## Rollback

The journal does not run revert SQL — manual revert is required:

1. Author + apply a follow-up migration with the inverse DDL (e.g. `ALTER COLUMN X DROP NOT NULL`, `DROP TABLE Y`). Preferred — keeps the audit trail complete.
2. Or, for an emergency rollback: `DELETE FROM __schema_migrations WHERE filename = '<name>';` and run the inverse SQL by hand. Only do this with operator agreement; the journal then no longer reflects DB state.

## Why not drizzle-kit `migrate`

drizzle-kit's `migrate` runner expects authored migrations under `./drizzle` with a `meta/_journal.json` snapshot system. Adopting it would require relocating every existing `lib/db/migrations/*.sql` file, regenerating drizzle-kit's snapshot/journal, and changing operator habit. Lightweight journal (this approach) preserves the existing authoring pattern and adds the missing audit trail with one small table + ~140 LOC of script. drizzle-kit's `push --force` workflow is preserved for local-dev fast iteration.
