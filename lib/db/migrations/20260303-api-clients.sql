-- ES-019: Add apiClients table and free-tier columns on geoSites

CREATE TABLE IF NOT EXISTS "api_clients" (
  "id"                  TEXT PRIMARY KEY,
  "team_id"             TEXT NOT NULL REFERENCES "teams"("id"),
  "client_id"           TEXT UNIQUE NOT NULL,
  "client_secret_hash"  TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "scopes"              TEXT[] NOT NULL DEFAULT '{}',
  "last_used_at"        TIMESTAMP,
  "revoked_at"          TIMESTAMP,
  "created_at"          TIMESTAMP DEFAULT NOW()
);

ALTER TABLE "geo_sites"
  ADD COLUMN IF NOT EXISTS "free_optimization_used" BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "free_run_number"        INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "api_client_id"          TEXT;
