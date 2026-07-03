# ES-Wave-3 — Schema / Migration (A1 + A2)

**Branch:** `fix/wave-3-schema-migration` (from `2a7703a`).
**Source plan:** `docs/specs/orchestration/2026-04-26-bugfix-plan.md` §Wave 3.
**Source UAT:** `docs/uat/2026-04-26-issues.md` rows A1, A2.
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — Vitest GREEN + Docker CI GREEN gate. No Playwright per-wave.
**Scope:** spec / design only. ScriptDev implements next.

---

## Overview

Two schema-management defects:

- **A1 (BLOCKER)** — `pre_analyze_done` schema/code drift. The product code at `app/api/pipeline/stage/route.ts:597` (and the surrounding fan-in counter logic at `:611-618`) writes/reads the `pre_analyze_done` column on `geo_sites`. On `e2e-comprehensive-suite` the schema is correctly defined at `lib/db/schema.ts:212` (`preAnalyzeDone: integer("pre_analyze_done").notNull().default(0)`) and a migration exists at `lib/db/migrations/20260421-add-pre-analyze-done.sql` with `ADD COLUMN IF NOT EXISTS pre_analyze_done integer NOT NULL DEFAULT 0`. **But on prod**, the column was applied OUT-OF-BAND with `nullable=YES` (no `NOT NULL` constraint) — drift. A fresh-DB deploy from current `main` would 500 at merge-crawl because the migration wasn't merged in time; the e2e-comprehensive-suite branch has it but main lags. Two corrective actions: (1) ship a follow-up migration that does `ALTER COLUMN pre_analyze_done SET NOT NULL` (idempotent — no-op if already NOT NULL on a fresh-DB deploy that ran the original migration); (2) SURFACE the prod-DB execution to Shastri so the prod-DB column gets the same `NOT NULL` constraint via a separate operator-run SQL pass.

- **A2 (MED)** — no migration runner / no `__drizzle_migrations` journal table on prod. Migrations under `lib/db/migrations/*.sql` are applied by hand. There is no record of when/who applied `pre_analyze_done` to prod, no atomic "apply pending migrations" workflow, no replay safety. Two options: (a) adopt drizzle-kit's `migrate` runner with its `__drizzle_migrations` journal (heavy — drizzle-kit's authoring flow uses `./drizzle` not `lib/db/migrations/`; would require migration-file relocation + journal backfill + workflow change); (b) document the existing manual workflow + add a lightweight `__schema_migrations` journal table + a runner script that applies pending files and records each. This ES picks option (b) as the minimal-blast-radius path; option (a) is a future cleanup if the team wants drizzle-kit's authoring tools too.

---

## A1 ACs

| AC | Target | Contract | Verify |
|----|--------|----------|--------|
| **AC-A1-1** | `lib/db/migrations/20260421-add-pre-analyze-done.sql` (existing on `e2e-comprehensive-suite`) | EXISTS with `ADD COLUMN IF NOT EXISTS pre_analyze_done integer NOT NULL DEFAULT 0`. No edit required — already correct. Verify on branch tip. | grep |
| **AC-A1-2** | `lib/db/schema.ts:212` `preAnalyzeDone: integer("pre_analyze_done").notNull().default(0)` | EXISTS on `e2e-comprehensive-suite`. Schema and migration agree. | grep |
| **AC-A1-3** | NEW `lib/db/migrations/20260426-pre-analyze-done-set-not-null.sql` | Add a follow-up migration that reconciles prod's nullable=YES drift: `ALTER TABLE geo_sites ALTER COLUMN pre_analyze_done SET NOT NULL;`. Idempotent — no-op if already NOT NULL. Includes a pre-flight comment block + a single-statement DDL body. | manual SQL review |
| **AC-A1-4** | `__tests__/schema-drift.test.ts:201` already includes `pre_analyze_done` in the column snapshot | EXISTS — no edit required. Verify the snapshot still passes after the SET NOT NULL migration is applied to a fresh local DB. | Vitest UT (existing schema-drift suite) |
| **AC-A1-5** | New Vitest IT: spin a fresh local DB, run `db:push:local` (or apply both migration files in order), then `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='geo_sites' AND column_name='pre_analyze_done'`. Assert `is_nullable='NO'`. | Verifies the migration chain produces a NOT NULL column on a fresh deploy. | Vitest IT (Docker CI) |
| **AC-A1-6** | Pre-flight check: the SET NOT NULL migration MUST first verify that no NULL rows exist (`SELECT count(*) FROM geo_sites WHERE pre_analyze_done IS NULL` returns 0). The product invariant is that the column was added with `DEFAULT 0`, so all rows should have a value. Migration includes a comment instructing the operator to run the pre-flight `SELECT` against prod BEFORE executing the `ALTER COLUMN`. If any NULL row is found, abort and surface — that indicates a row was inserted via raw SQL bypassing the default. | Operator runbook + comment in migration file |

### A1 SHASTRI SURFACE — prod DB ALTER COLUMN ready-to-run

**Pre-flight (operator runs first against prod read-replica or `psql --single-transaction` dry-run):**
```sql
-- Step 1: confirm column exists
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'geo_sites' AND column_name = 'pre_analyze_done';
-- Expected: pre_analyze_done | integer | YES (currently nullable=YES on prod) | 0 (or NULL)

-- Step 2: confirm no NULL rows (must be zero before ALTER fires)
SELECT count(*) AS null_rows FROM geo_sites WHERE pre_analyze_done IS NULL;
-- Expected: 0
-- If > 0: abort and surface — a row was inserted bypassing the default.
--         Option to backfill: UPDATE geo_sites SET pre_analyze_done = 0 WHERE pre_analyze_done IS NULL;
--         Then re-run Step 2 to confirm 0; only then proceed.
```

**Apply (operator runs against prod after pre-flight passes):**
```sql
-- Reconcile pre_analyze_done to NOT NULL (matches lib/db/schema.ts + 20260421-add-pre-analyze-done.sql intent)
-- Idempotent: no-op if already NOT NULL.
-- Run in a transaction so it rolls back cleanly if anything goes sideways.
BEGIN;
ALTER TABLE geo_sites ALTER COLUMN pre_analyze_done SET NOT NULL;
-- Verify post-state
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_name = 'geo_sites' AND column_name = 'pre_analyze_done';
-- Expected: pre_analyze_done | NO
COMMIT;
```

**Rollback (if needed):** `ALTER TABLE geo_sites ALTER COLUMN pre_analyze_done DROP NOT NULL;` — reverts to nullable=YES. No data loss; existing values preserved.

**Surface payload to Shastri:**
> A1 prod DB reconcile: ready-to-run SQL in ES-wave-3 §A1 SHASTRI SURFACE. Pre-flight (2 SELECT statements to confirm column exists + zero NULL rows) then BEGIN → ALTER COLUMN ... SET NOT NULL → verify → COMMIT. Idempotent + transactional + rollback-able. Awaits operator window.

---

## A2 ACs — chosen approach: option (b) lightweight journal + runner

**Decision rationale:** drizzle-kit `migrate` (option a) would require relocating the existing `lib/db/migrations/*.sql` files to `./drizzle`, regenerating drizzle-kit's snapshot/journal format, and changing the operator workflow from "apply SQL by hand" to "drizzle-kit migrate". That's a multi-week effort with non-trivial breakage risk on the in-flight migrations. Option (b) — document the existing workflow + add a small journal table + a runner script — preserves the current authoring habit (write `lib/db/migrations/YYYYMMDD-name.sql`) and adds the missing audit trail with ~50 LOC of script + 1 small table. If the team later wants drizzle-kit's authoring tools, that's a separate ES.

| AC | Target | Contract | Verify |
|----|--------|----------|--------|
| **AC-A2-1** | NEW `lib/db/migrations/20260426-schema-migrations-journal.sql` | Create journal table: `CREATE TABLE IF NOT EXISTS __schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT NOW(), applied_by text);`. Backfill rows for every existing migration file in `lib/db/migrations/` (hand-listed in the migration body, with `applied_by='backfill-2026-04-26'`). The journal lives in the application schema; it is its own migration so it's recorded in the journal it creates (chicken-and-egg note in the comment). | Vitest IT (apply migration → assert table exists + backfilled rows present) |
| **AC-A2-2** | NEW `scripts/migrations/apply-pending.ts` | Runner script: read `lib/db/migrations/*.sql` filenames in lexicographic order, query `__schema_migrations` for applied filenames, compute pending (set-difference), apply each pending file in a transaction, INSERT into journal on success. Logs each step. Refuses to run if `DATABASE_URL` doesn't match the AC-7-style local-or-prod gate (operator opts into prod via `--prod` flag with explicit warning). | Vitest UT (mock fs + db) |
| **AC-A2-3** | NEW `package.json` script: `db:migrate:apply-pending` runs the runner script. Operator workflow becomes: `git pull` → `npm run db:migrate:apply-pending` → script applies new files in order + records to journal. | manual review |
| **AC-A2-4** | NEW `docs/specs/ops/migration-runner.md` | Document the workflow: (1) author SQL file with `YYYYMMDD-name.sql` naming; (2) commit + push; (3) on local: `npm run db:push:local` (drizzle-kit push, fast iteration); (4) on prod: `npm run db:migrate:apply-pending --prod` after deployment runs against the journal-tracked DB. Document the journal-table schema, the backfill process, the rollback approach (`DELETE FROM __schema_migrations WHERE filename = '<X>'` + manual revert SQL), and the operator-locking convention (only one operator runs migrations at a time; future enhancement: PostgreSQL advisory lock). | manual review of doc + grep-test that doc references each existing migration file |
| **AC-A2-5** | Verification IT: on a fresh local DB, run `npm run db:migrate:apply-pending` → assert `__schema_migrations` contains a row for every file in `lib/db/migrations/*.sql`. Re-run → assert no double-apply (idempotent). | Vitest IT (Docker CI) |

**Why not drizzle-kit's `migrate`:** it expects authored migrations under `./drizzle` (with a `meta/_journal.json` snapshot system). The team already authors plain SQL under `lib/db/migrations/`. Forcing drizzle-kit's authoring flow would obsolete the existing pattern + require migration-file relocation + a one-time snapshot reconciliation. Lightweight journal (option b) gets the audit trail without that churn. The drizzle-kit `push --force` workflow stays for local-dev fast iteration (per existing `package.json:22`).

---

## Test strategy

**Vitest UTs:**
- `__tests__/migrations/apply-pending.test.ts` (NEW): mock fs.readdir + db client → assert pending-set computation + ordered apply + journal insert.
- `__tests__/migrations/safety-gate.test.ts` (NEW): assert runner refuses prod URL without `--prod` flag.

**Vitest ITs (Docker CI):**
- AC-A1-5: fresh local DB → apply both pre-analyze-done migrations → assert `is_nullable='NO'`.
- AC-A2-1: fresh local DB → apply journal migration → assert `__schema_migrations` table exists with backfilled rows.
- AC-A2-5: fresh local DB → run `db:migrate:apply-pending` → assert one journal row per migration file → re-run → assert idempotent (no double-apply).

**Existing schema-drift test (`__tests__/schema-drift.test.ts`):** continues to enforce the schema.ts ↔ DB column-set contract; the new SET NOT NULL migration shifts `is_nullable` from YES to NO but the test only snapshots column NAMES, so no snapshot update needed.

**No Playwright per-wave** per pivot.

---

## Verification gate (pivot-aligned)

Wave 3 lands when:
1. Vitest GREEN — UTs from §A1 + §A2 pass.
2. Docker CI GREEN — ITs against the containerised local Supabase pass.
3. Schema-drift test still GREEN.
4. **No Playwright globalSetup requirement** per pivot.
5. **A1 prod-DB execution** is OPERATOR-GATED — Shastri schedules a window and runs the SHASTRI SURFACE SQL block above. Wave 3 spec lands independently of when the prod execution happens; the migration FILE shipping is enough for fresh-DB deploys; the prod ALTER is a follow-up operator action.

---

## Out of scope

- **drizzle-kit migrate adoption** (option a for A2) — separate ES if pursued.
- **PostgreSQL advisory locking** for concurrent operator runs — future enhancement noted in the docs.
- **Prod-data backfill** (e.g. mass-correcting NULL rows) — pre-flight check warns + offers an UPDATE statement; actual data fixes are operator-judgment per-incident.
- **Multi-region migration coordination** — not applicable; current prod is single-region per existing deploy.
- **Schema-drift CI gate that blocks PR merge** — the existing `__tests__/schema-drift.test.ts` is run-on-demand; converting it to a required PR check is a separate ops TS.

---

## SHASTRI SURFACE summary

**A1 only — A2 is internal (no operator action needed).**

> **A1 prod DB reconcile** — `pre_analyze_done` column on prod is currently `nullable=YES`; matches lib/db/schema.ts intent of `NOT NULL DEFAULT 0`. Ready-to-run pre-flight + apply + rollback SQL in ES-wave-3-schema-migration.md §A1. Idempotent + transactional. Pre-flight: 2 SELECTs (column exists + zero NULL rows). Apply: BEGIN → ALTER COLUMN ... SET NOT NULL → verify → COMMIT. Rollback: DROP NOT NULL. Awaits operator window.
