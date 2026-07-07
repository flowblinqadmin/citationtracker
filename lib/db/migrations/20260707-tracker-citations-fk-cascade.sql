-- CE-OWNED tracker migration (tracker.* DDL ownership moved to this repo with
-- the engine migration; geo keeps only its historical migrations).
-- Source: geo PR #194 finding R27. APPLY AT GO-LIVE, before deploying the
-- in-repo engine — never during local development against prod.
--
-- tracker.citations.run_id and client_id were bare text columns with no FK.
-- Deleting a client left citation rows alive with dangling run_id/client_id
-- (response_id was SET NULL but the citation row survived). Citations must be
-- removed when their owning run/client is deleted.
--
-- The bare-text design was intentional for the 12-month response purge (which
-- deletes only tracker.responses — citations correctly survive because their
-- FK to responses is SET NULL, not CASCADE). The CASCADE FKs added here only
-- fire on explicit run/client deletes.
--
-- R27a (data cleanup): prod already contains orphaned citations (rows whose
-- parent was deleted before this FK existed — the very bug this fixes). The FK
-- creation would fail against them, so purge orphans FIRST.
--
-- Idempotent: DELETE is naturally idempotent; DO $$ guards the FK constraints.

-- R27a: purge pre-existing orphaned citations (dangling run_id or client_id).
DELETE FROM tracker.citations c
WHERE (c.run_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tracker.runs r WHERE r.id = c.run_id))
   OR (c.client_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tracker.clients cl WHERE cl.id = c.client_id));

-- R27b: FK from citations.run_id → runs(id) ON DELETE CASCADE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tracker_citations_run_id_fk'
      AND conrelid = 'tracker.citations'::regclass
  ) THEN
    ALTER TABLE tracker.citations
      ADD CONSTRAINT tracker_citations_run_id_fk
      FOREIGN KEY (run_id) REFERENCES tracker.runs(id) ON DELETE CASCADE;
  END IF;
END$$;

-- R27c: FK from citations.client_id → clients(id) ON DELETE CASCADE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tracker_citations_client_id_fk'
      AND conrelid = 'tracker.citations'::regclass
  ) THEN
    ALTER TABLE tracker.citations
      ADD CONSTRAINT tracker_citations_client_id_fk
      FOREIGN KEY (client_id) REFERENCES tracker.clients(id) ON DELETE CASCADE;
  END IF;
END$$;
