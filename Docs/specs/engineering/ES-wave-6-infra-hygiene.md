# ES-Wave-6 — Infra Hygiene (D1–D7 + E4 + E5)

**Branch:** `fix/wave-6-infra-hygiene` (from `145795a`).
**Source plan:** `docs/specs/orchestration/2026-04-26-bugfix-plan.md` §Wave 6.
**Source UAT:** `docs/uat/2026-04-26-issues.md` rows D1–D7 + E4 + E5.
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — Vitest GREEN + Docker CI GREEN gate. Most of Wave 6 is docs/scripts; CI checks they don't break anything.
**Scope:** spec / design only. ScriptDev implements next.

---

## Overview

Nine infra-hygiene defects from the 2026-04-26 walmart UAT session, ranging from a prod-blocking Vercel env corruption (D1, BLOCKER) to docs-only runbook gaps (D6/D7/E4/E5). Five are addressed by a single new runbook (`docs/specs/ops/docker-uat-runbook.md`); two need new scripts (D2 + D5); one is already-resolved (D3 — landed in Wave 1 commit `dc4d216`); one needs a Shastri-executed prod CLI script (D1 — SURFACE).

| Issue | Sev | Resolution path |
|-------|-----|----------------|
| **D1** | 🔴 BLOCKER | SURFACE — prepare `vercel env rm` + re-add script; Shastri executes against prod |
| **D2** | 🟠 HIGH | NEW `npm run env:refresh-docker` script + runbook entry |
| **D3** | 🟠 HIGH | RESOLVED — landed in Wave 1 commit `dc4d216` (.dockerignore symlink/artifact exclusions) |
| **D4** | 🟡 MED | Runbook entry — `docker compose restart` doesn't reload env_file; full down+up required |
| **D5** | 🟡 MED | Named cloudflared tunnel setup script + runbook entry |
| **D6** | 🟡 MED | Runbook entry — env_file path resolution gotcha |
| **D7** | 🟡 MED | Runbook entry — NEXT_PUBLIC_* + LAN-accessible UAT |
| **E4** | 🟡 MED | Runbook entry — `docker compose config` redaction |
| **E5** | 🟡 MED | Runbook entry — `od -c` / `cat -A` env-file leak avoidance |

---

## D1 — Vercel env `\n` corruption (SURFACE_TO_SHASTRI)

### Current state

Two prod env values have literal `\n` corruption inside their quoted values (per UAT trace `docs/uat/2026-04-26-issues.md:45`):

- `DATABASE_URL=postgres://...\n` — when the env parser interprets the quoted string, `\n` becomes a real newline → URL becomes invalid → `database "postgres\n" does not exist` at first connection attempt.
- `NEXT_PUBLIC_WEBSITE_URL=https://...\n` — same root cause; client-side fetches against the corrupted URL fail silently (browser interprets the newline as URL-segment terminator).

Almost certainly introduced by `echo "..." | vercel env add ...` with a trailing newline (echo's default newline gets captured into the value). Prior session's Aditya-deferred fix is "Option B: rm + re-add via stdin or `printf` (no trailing newline)".

### Verification before applying (operator pre-flight)

```bash
# Pre-flight — confirm corrupt values still present:
vercel env pull .env.vercel-prod --environment=production
awk -F= '/\\\\n"$/ {print $1}' .env.vercel-prod
# Expected output: DATABASE_URL, NEXT_PUBLIC_WEBSITE_URL (the two corrupt keys)
# If output is empty: corruption already cleared upstream — D1 is no-op; mark resolved.
```

### Apply (Shastri executes against prod)

```bash
# DATABASE_URL clean:
# Pull the current corrupt value, strip trailing \n + closing quote, re-add via printf (no echo, no trailing newline):
CURRENT_DB_URL=$(grep '^DATABASE_URL=' .env.vercel-prod | cut -d= -f2- | sed 's/^"//;s/"$//;s/\\n$//')
echo "Current DATABASE_URL length: ${#CURRENT_DB_URL}"
# Visual confirm: length should be ~80-120 chars depending on the connection string.
# DO NOT print the value itself.

vercel env rm DATABASE_URL production --yes
printf '%s' "$CURRENT_DB_URL" | vercel env add DATABASE_URL production

# Same for NEXT_PUBLIC_WEBSITE_URL:
CURRENT_WEB_URL=$(grep '^NEXT_PUBLIC_WEBSITE_URL=' .env.vercel-prod | cut -d= -f2- | sed 's/^"//;s/"$//;s/\\n$//')
echo "Current NEXT_PUBLIC_WEBSITE_URL length: ${#CURRENT_WEB_URL}"

vercel env rm NEXT_PUBLIC_WEBSITE_URL production --yes
printf '%s' "$CURRENT_WEB_URL" | vercel env add NEXT_PUBLIC_WEBSITE_URL production

# Verify post-state:
vercel env pull .env.vercel-prod-fresh --environment=production
awk -F= '/\\\\n"$/ {print $1}' .env.vercel-prod-fresh
# Expected: empty output (no more corrupt keys)

# Trigger a redeploy so Vercel picks up the corrected env on prod:
vercel --prod
```

**Rollback:** if the new value turns out to be wrong (typo / broken connection string), `vercel env rm` + `vercel env add` again with the corrected value. There is no "rollback to corrupted version" — the goal is a CLEAN value, not a restore-prior.

**Risk:** during the `vercel env rm` window, prod redeploys would have NO `DATABASE_URL` (a few seconds). Mitigation: run `rm` + `add` in tight succession (single shell session, copy-paste both commands), or hold off on triggering deploys during the operation.

### D1 ACs

| AC | Target | Contract | Verify |
|----|--------|----------|--------|
| **AC-D1-1** | NEW `scripts/ops/clean-vercel-env.sh` | Wraps the pre-flight + apply script above. Operator runs `bash scripts/ops/clean-vercel-env.sh` interactively (NOT in CI). Script prompts before each `vercel env rm`. Exits non-zero if pre-flight pull fails. | Operator review |
| **AC-D1-2** | Runbook entry under `docs/specs/ops/docker-uat-runbook.md` §1 / cross-link from new ops/vercel-env-hygiene.md | Documents the failure mode (echo trailing newline → quoted `\n` corruption) + the prevention (use `printf`, NOT `echo`, when piping to `vercel env add`) + the detection (`awk -F= '/\\\\n"$/ {print $1}' .env.vercel-prod`). | Doc review |
| **AC-D1-3** | NEW invariant: any future `vercel env add` invocation in this codebase MUST use `printf '%s'` (no trailing newline) instead of `echo "..."`. Add a grep guard to a Vitest UT scanning `scripts/**/*.{sh,ts}` for `echo "..." | vercel env add` patterns → flag if found. | Vitest UT (grep guard) |

**D1 SURFACE payload to Shastri:**
> D1 prod Vercel env reconcile: ready-to-run script in ES-wave-6-infra-hygiene §D1 (and as `scripts/ops/clean-vercel-env.sh` once SD lands it). Pre-flight: `vercel env pull` + `awk` to confirm corruption still present. Apply: `vercel env rm DATABASE_URL production` + `printf '%s' "$VAL" | vercel env add DATABASE_URL production` (× 2 for DATABASE_URL + NEXT_PUBLIC_WEBSITE_URL). Verify: re-pull + awk should be empty. Followed by `vercel --prod` to redeploy with the clean values. Brief prod-deploy gap during rm window — run rm+add in tight succession. Awaits Shastri's authorization + execution window.

---

## D2 — env refresh script

### D2 ACs

| AC | Target | Contract | Verify |
|----|--------|----------|--------|
| **AC-D2-1** | NEW `package.json` script entry: `"env:refresh-docker": "bash scripts/ops/refresh-docker-env.sh"` | Operator runs `npm run env:refresh-docker` to refresh `.env.docker` from prod. | manual review |
| **AC-D2-2** | NEW `scripts/ops/refresh-docker-env.sh` | Body: (1) `vercel env pull .env.vercel-prod --environment=production`; (2) `python3 scripts/ops/patch-env-docker.py .env.vercel-prod .env.docker`; (3) print summary of changed keys (NEVER values) — e.g. `Updated 17 keys: DATABASE_URL, ANTHROPIC_API_KEY, ...`; (4) reminder echo: "Restart the container with `docker compose down && up` (D4 — restart doesn't reload env_file)". Refuses to run if not in repo root. | Vitest UT (mock vercel + python3) |
| **AC-D2-3** | NEW `scripts/ops/patch-env-docker.py` | Reads source `.env.vercel-prod` + target `.env.docker` (preserving comments + key order). For each key in the source, if also in target, REPLACE the target value. Preserve target-only keys (the `*_LOCAL` overrides + the cloudflared tunnel URL). NEVER print key values; print only key names. Exits non-zero if either input file missing. | Vitest UT (Python script tested via `child_process.spawn` from a Node UT, OR converted to TS for native testing — SD picks) |
| **AC-D2-4** | Runbook entry at `docs/specs/ops/docker-uat-runbook.md` §4 | Documents the workflow: when to refresh (after a teammate rotates a prod key, before a UAT session against prod-cred docker, etc.); the down+up requirement post-refresh; the cloudflared tunnel URL preservation note. | Already authored as part of this Wave's runbook. |

---

## D3 — RESOLVED in Wave 1

`.dockerignore` symlink/artifact exclusions for `playwright-report`, `test-results`, `e2e-results`, `e2e/.playwright-storage-state.json`, `.docker-test`, `.parked-tests`, `coverage`, `.vercel`, `supabase/.branches`, `supabase/.temp`, `.env.local.bak.*`, `.env.docker.bak.*`, `.env.vercel-prod` — landed in Wave 1 commit `dc4d216`. Verify on `e2e-comprehensive-suite` tip via `git log --oneline -- .dockerignore | head -1`.

**AC-D3-1:** NO action — verify the commit landed; no edit to .dockerignore in Wave 6.

---

## D4 — runbook entry

`docker compose restart` does NOT reload env_file (env vars are baked at container CREATE). After patching `.env.docker`, you need `docker compose down && up`, NOT `restart`. Even `--force-recreate` was unreliable in this session. Documented in `docker-uat-runbook.md` §4 + §7.

**AC-D4-1:** runbook entry present + reminder echo in `refresh-docker-env.sh` (per AC-D2-2) explicitly tells the operator. NO scripted enforcement (the operator has to act).

---

## D5 — named cloudflared tunnel

### D5 ACs

| AC | Target | Contract | Verify |
|----|--------|----------|--------|
| **AC-D5-1** | NEW `scripts/ops/setup-named-tunnel.sh` | One-time setup script: prompts for the desired hostname (e.g. `uat.flowblinq.dev`), runs `cloudflared tunnel login` + `cloudflared tunnel create flowblinq-uat-laptop` + `cloudflared tunnel route dns flowblinq-uat-laptop <hostname>` + writes `~/.cloudflared/flowblinq-uat-laptop.yml` config. Idempotent: if tunnel + DNS already exist, prints status + exits 0. | Operator review |
| **AC-D5-2** | Runbook entry at `docker-uat-runbook.md` §5 | Documents the per-session run command: `cloudflared tunnel --config ~/.cloudflared/flowblinq-uat-laptop.yml run flowblinq-uat-laptop`. Includes the `.env.docker` setting `QSTASH_CALLBACK_BASE=https://uat.flowblinq.dev` (or whatever hostname the operator chose). | Already authored. |
| **AC-D5-3** | Migration note in runbook: existing random `*.trycloudflare.com` URLs in `.env.docker` should be REPLACED once with the named-tunnel hostname. Subsequent UAT sessions use the stable URL — no per-session tunnel-URL drift. | Doc note. |

---

## D6 / D7 / E4 / E5 — runbook entries

All four are documentation gaps surfaced during the UAT session. Aggregated into `docs/specs/ops/docker-uat-runbook.md` (created by this commit):

- **D6:** §2 — env_file path resolution (relative to project dir, not override-file parent)
- **D7:** §3 — NEXT_PUBLIC_* values exposed to client JS; LAN-accessible UAT requires LAN IP, not localhost
- **E4:** §6 — `docker compose config` prints unredacted env; safer alternatives (`--no-resolve`, pre-grep, sed-redact)
- **E5:** §6 — `od -c` / `cat -A` env-file leak avoidance; `awk` patterns to flag bad keys without exposing values

**ACs (D6/D7/E4/E5):** each section in the runbook covers the symptom + cause + fix + prevention. Operator review at HP gate; no Vitest assertion (docs only).

---

## File inventory

| File | Action | Notes |
|------|--------|-------|
| `docs/specs/ops/docker-uat-runbook.md` | CREATE | Authored as part of this commit. |
| `scripts/ops/clean-vercel-env.sh` | CREATE (ScriptDev) | AC-D1-1. |
| `scripts/ops/refresh-docker-env.sh` | CREATE (ScriptDev) | AC-D2-2. |
| `scripts/ops/patch-env-docker.py` | CREATE (ScriptDev) | AC-D2-3. |
| `scripts/ops/setup-named-tunnel.sh` | CREATE (ScriptDev) | AC-D5-1. |
| `package.json` | EDIT (ScriptDev) | AC-D2-1 — add `env:refresh-docker` script entry. |
| `.dockerignore` | NO EDIT | AC-D3-1 — already updated in Wave 1 commit `dc4d216`. |

---

## Test strategy

**Vitest UTs:**
- AC-D1-3 grep guard scanning `scripts/**/*.{sh,ts}` for `echo "..." | vercel env add` patterns.
- AC-D2-2 / AC-D2-3 mocked-`vercel` + mocked-`python3` invocations; assert key-name-only output (no values).
- D3 verification: `git log --oneline -- .dockerignore | head -1` returns the Wave 1 commit SHA.

**Vitest ITs (Docker CI):**
- Full docker stack spin-up using the runbook's quick-start (§1) → assert containers reach healthy state. Verifies the runbook works end-to-end.

**Operator review (no Vitest):**
- D1 SURFACE script (`scripts/ops/clean-vercel-env.sh`) — Shastri reviews + executes against prod.
- D5 setup script — operator runs once + verifies named tunnel resolves.
- Runbook content — HP review at ratify gate.

**No Playwright per pivot.**

---

## Verification gate (pivot-aligned)

Wave 6 lands when:
1. Vitest GREEN — UTs pass.
2. Docker CI GREEN — IT spin-up succeeds with the runbook's quick-start.
3. **No Playwright globalSetup** per pivot.
4. **D1 prod-cred execution is OPERATOR-GATED** — Shastri schedules window separately. Wave 6 spec lands independently of when the prod execution happens; the SCRIPT shipping is enough; the prod CLI mutation is a follow-up operator action.
5. Runbook reviewable by a fresh operator — i.e. someone who didn't sit through this UAT can spin up the docker UAT stack from `docker-uat-runbook.md` without help.

---

## Out of scope

- **Automated env-sync on a cron / git hook** — manual `npm run env:refresh-docker` is the MVP; cron is a follow-up if the team wants it.
- **Vault / secrets-manager integration** — current Vercel + .env.docker workflow stays; vault adoption is a separate ES.
- **Per-developer named tunnels** — D5 setup is per-operator, not per-developer; team-wide tunnel pool is out of scope.
- **CI-side D1 detection** (preventing `\n` corruption from being added by a teammate) — could be a follow-up Vercel-env-shape lint; not in this ES.
- **D1 root-cause investigation** in Vercel itself (why does Vercel preserve the `\n`?) — vendor-side, not actionable from our codebase.

---

## SHASTRI SURFACE summary

**D1 only — D2/D3/D5/D6/D7/E4/E5 are internal (no operator authorization needed).**

> **D1 prod Vercel env reconcile** — `DATABASE_URL` + `NEXT_PUBLIC_WEBSITE_URL` on prod have literal `\n` corruption inside their quoted values. Ready-to-run pre-flight + apply + verify script in ES-wave-6-infra-hygiene §D1 (also lands as `scripts/ops/clean-vercel-env.sh` post-SD). Pre-flight: pull + `awk` to confirm corruption present. Apply: `vercel env rm` + `printf '%s' "$VAL" | vercel env add` (× 2 keys). Verify: re-pull + awk should be empty. Followed by `vercel --prod` to redeploy. Brief prod gap during rm window — run rm+add in tight succession. Awaits Shastri's authorization + execution window.
