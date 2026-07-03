-- ES-wave-2 §B3 AC-B3-3 — re-audit audit log.
-- One row per successful re-audit, indexed for per-team incident-response timelines.

CREATE TABLE IF NOT EXISTS re_audit_actions (
  id              uuid PRIMARY KEY,
  actor_user_id   uuid,
  actor_email     text,
  site_id         text,
  team_id         text,
  mechanism       text NOT NULL CHECK (mechanism IN ('pro_session','access_token','otp')),
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS re_audit_actions_team_created_idx
  ON re_audit_actions (team_id, created_at DESC);
