-- Migration: add created_by_user_id to api_clients
-- ES-019 hotfix — credential traceability for multi-member teams

ALTER TABLE api_clients
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT;

-- Backfill existing rows from teams.owner_user_id
UPDATE api_clients ac
SET created_by_user_id = t.owner_user_id
FROM teams t
WHERE ac.team_id = t.id
  AND ac.created_by_user_id IS NULL;
