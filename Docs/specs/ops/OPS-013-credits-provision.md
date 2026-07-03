# OPS-013 — Provision 10,000 Credits for an@flowblinq.com

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `n/a — ops task`  

---

## Overview
Update the production Supabase database to set `creditBalance = 10000` for the
team associated with `an@flowblinq.com`. This unblocks bulk audit access for
Aditya Nittur during live testing.

**Source:** CoFounder directive (2026-03-02). No TS required for a pure data op.

## Steps

### 1. Find the team
```sql
SELECT tm.email, tm.team_id, t.id, t.credit_balance
FROM team_members tm
JOIN teams t ON t.id = tm.team_id
WHERE tm.email = 'an@flowblinq.com';
```

If the row does not exist in `team_members`, the user is not Pro and cannot
submit bulk audits. Report this back to CoFounder immediately — a different fix
is needed.

### 2. Set creditBalance = 10,000
```sql
UPDATE teams
SET credit_balance = 10000
WHERE id = '<team_id_from_step_1>';
```

### 3. Verify
```sql
SELECT id, credit_balance FROM teams WHERE id = '<team_id>';
-- Expected: credit_balance = 10000
```

### 4. Insert ledger entry (optional but recommended for auditability)
```sql
INSERT INTO credit_transactions (
  id, team_id, site_id, type, pages_consumed,
  credits_changed, balance_before, balance_after, created_at
) VALUES (
  gen_random_uuid(), '<team_id>', NULL, 'manual_provision', 0,
  10000, 0, 10000, NOW()
);
```

## Access Options (try in order)

**Option A — Supabase SQL editor (preferred)**
1. Log in at https://supabase.com with flowblinq credentials
2. Navigate to project → SQL Editor
3. Run the SQL from steps 1–4 above

**Option B — psql via connection string**
```bash
psql "postgresql://postgres:<password>@db.mkwjqntnlmogwjqxezqw.supabase.co:5432/postgres"
```
Connection string from `DATABASE_URL` env var (check Vercel env vars if not local)

**Option C — supabase CLI**
```bash
supabase db execute --db-url "$DATABASE_URL" -f /tmp/provision-credits.sql
```

## If Blocked on Credentials
Report back to CoFounder inbox immediately. This task requires either:
- Supabase project password, OR
- Service role key, OR
- Adithya Rao (flowblinqadmin) to run the SQL directly

## Acceptance Criteria
- [ ] `teams.credit_balance = 10000` for `an@flowblinq.com`'s team
- [ ] Report SQL output confirming the update
- [ ] Report team_id for reference

## Commit
No code changes — pure DB operation. No git commit needed.
