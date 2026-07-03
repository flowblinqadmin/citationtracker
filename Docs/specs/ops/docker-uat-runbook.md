# Docker UAT Runbook

**Owner:** ops / SpecMaster (current).
**Status:** active. Updated 2026-04-26 per Wave 6 ES (D2 / D5 / D6 / D7 / E4 / E5).

This runbook covers running a UAT-grade local docker stack against prod-cred-shaped env, including the gotchas hit during the 2026-04-26 walmart UAT.

---

## 1. Quick start (operator who knows what they're doing)

```bash
# From geo/ project root:
npm run env:refresh-docker            # refresh .env.docker from prod (D2)
docker compose -f docker-compose.yml -f .docker-test/compose.override.yml down
docker compose -f docker-compose.yml -f .docker-test/compose.override.yml up -d
# Optional cloudflared tunnel for QStash callback (D5):
cloudflared tunnel run flowblinq-uat-laptop
```

If anything breaks, follow §4 below.

---

## 2. env_file path resolution (D6)

`docker-compose` resolves `env_file:` paths **relative to the project dir** — defined as the parent of the first `-f` file. NOT relative to the override file's parent.

**Wrong** (this is what we hit):
```yaml
# In .docker-test/compose.override.yml:
env_file: ../.env.docker   # resolves to /home/aditya/flowblinq/.env.docker (parent of geo/), not repo root
```

**Right:**
```yaml
# In .docker-test/compose.override.yml, when invoked from geo/ as:
# docker compose -f docker-compose.yml -f .docker-test/compose.override.yml ...
env_file: .env.docker      # relative to project dir = geo/
```

Always use bare relative paths (`.env.docker`, NOT `../.env.docker`) in overrides. Project dir is whatever directory the **first** `-f` file lives in.

---

## 3. NEXT_PUBLIC_* + LAN-accessible UAT (D7)

`NEXT_PUBLIC_*` env values are baked into the client JS bundle by Next.js at build time. When the app is accessed from a different machine on the LAN (e.g. `192.168.1.10:3030` from a phone), the **browser** receives whatever literal value was baked in — usually `localhost`. The browser then tries to fetch from its own loopback and silently 404s.

**For LAN-accessible UAT:**
- Set `NEXT_PUBLIC_APP_URL=http://192.168.1.10:3030` (the LAN IP, NOT `localhost`).
- Set `NEXT_PUBLIC_WEBSITE_URL` to the same LAN-IP base if relevant.
- Rebuild the container after the env change (these are baked at build time).

**For localhost-only UAT:** `localhost:3030` is fine.

---

## 4. .env.docker refresh from prod (D2)

`vercel env pull` writes a `.env.local`-shaped file. To produce `.env.docker` (which has slightly different shape — local-Supabase overrides + a few `*_LOCAL` keys), use the wrapper script:

```bash
npm run env:refresh-docker
# = bash scripts/ops/refresh-docker-env.sh
# = vercel env pull .env.vercel-prod
#   python3 scripts/ops/patch-env-docker.py .env.vercel-prod .env.docker
```

The patch script merges the prod values from `.env.vercel-prod` into the existing `.env.docker`, preserving any local-only overrides (e.g. local Supabase URL/key, cloudflared tunnel URL) and replacing the prod-sourced credentials.

**After refresh, you MUST restart the container** (D4 — env_file is baked at container CREATE):
```bash
docker compose -f docker-compose.yml -f .docker-test/compose.override.yml down
docker compose -f docker-compose.yml -f .docker-test/compose.override.yml up -d
```

`docker compose restart` does NOT reload env_file. `--force-recreate` is unreliable. Full down + up is the safe path.

---

## 5. Cloudflared named tunnel (D5)

Random `*.trycloudflare.com` URLs from `cloudflared tunnel --url localhost:PORT` drift on every restart. For a stable URL:

```bash
# One-time setup:
cloudflared tunnel login
cloudflared tunnel create flowblinq-uat-laptop
# Note the tunnel ID printed.
cloudflared tunnel route dns flowblinq-uat-laptop uat.flowblinq.dev
# Or any subdomain you control.

# Per-session:
cloudflared tunnel --config ~/.cloudflared/flowblinq-uat-laptop.yml run flowblinq-uat-laptop
# config.yml content:
#   tunnel: <tunnel-id>
#   credentials-file: /home/aditya/.cloudflared/<tunnel-id>.json
#   ingress:
#     - hostname: uat.flowblinq.dev
#       service: http://localhost:3030
#     - service: http_status:404
```

Then set `QSTASH_CALLBACK_BASE=https://uat.flowblinq.dev` in `.env.docker` ONCE — no more per-session tunnel-URL drift.

---

## 6. Secrets-leak-avoidance (E4 + E5)

### E4 — `docker compose config` prints unredacted env

`docker compose -f ... config` resolves env_file values and prints them inline. If your terminal scrollback is shared / recorded / sent over screenshare, the secrets leak.

**Safer alternatives:**
- `docker compose -f ... config --no-resolve` — keeps env references unresolved.
- Pre-grep: `docker compose -f ... config | grep -v 'API_KEY\|PASSWORD\|TOKEN\|SECRET'` (best-effort).
- `docker compose -f ... config | sed -E 's/(_KEY|_PASSWORD|_SECRET|_TOKEN)=[^[:space:]]*/\1=<REDACTED>/g'`.

When secrets are in scope, prefer `docker compose -f ... ps` / `docker compose -f ... top` for state inspection; reserve `config` for env-shape debugging in a clean room.

### E5 — `od -c` / `cat -A` on env files leak

For finding hidden whitespace (the D1 `\n` corruption hunt this session) WITHOUT exposing values:
```bash
# Wrong — exposes values:
od -c .env.docker
cat -A .env.docker

# Right — flags KEYS that have problematic suffixes without printing values:
awk -F= '/\\\\n"$/ {print $1}' .env.docker          # keys ending with literal \n"
awk -F= '/[[:space:]]+"$/ {print $1}' .env.docker   # keys with trailing whitespace before quote
awk -F= 'length($2) > 0 && $2 !~ /^"/ {print $1": unquoted"}' .env.docker
```

If you absolutely need to see the value of one key for debugging:
```bash
grep '^DATABASE_URL=' .env.docker | sed 's/=.*/=<REDACTED-LEN-'$(grep '^DATABASE_URL=' .env.docker | cut -d= -f2- | wc -c)'>/'
# Prints the key name + the byte length, NEVER the value.
```

---

## 7. Troubleshooting checklist

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `database "postgres\n" does not exist` | Vercel env value has literal `\n` corruption (D1) | `vercel env rm` + re-add via stdin not echo |
| Browser fetch fails from LAN | NEXT_PUBLIC_*=localhost (D7) | Set to LAN IP + rebuild |
| env_file not found at expected path | env_file: relative-to-override (D6) | Use bare `.env.docker` relative to project dir |
| New env not visible in container | `docker compose restart` doesn't reload env_file (D4) | Full down + up |
| Tunnel URL changed since last session | Random *.trycloudflare.com per run (D5) | Set up named tunnel |
| 401 from Supabase / Anthropic / Stripe | Stale .env.docker creds (D2) | `npm run env:refresh-docker` + container restart |

---

## 8. References

- Plan: `docs/specs/orchestration/2026-04-26-bugfix-plan.md` §Wave 6
- Issues: `docs/uat/2026-04-26-issues.md` D1-D7 + E4 + E5
- Spec: `docs/specs/engineering/ES-wave-6-infra-hygiene.md`
- Migration runbook (sibling): `docs/specs/ops/migration-runner.md` (Wave 3)

## 9. Scripts (authored under scripts/ops/)

| Script | Purpose | Wave |
|--------|---------|------|
| `scripts/ops/clean-vercel-env.sh` | D1 — REQUIRES OPERATOR APPROVAL. Pre-flight pulls + greps for `\\n"$` corruption; apply does `vercel env rm` + `printf '%s' "$VAL" \| vercel env add`; verify re-pulls. NOT auto-run. | D1 |
| `scripts/ops/refresh-docker-env.sh` | D2 — wraps `vercel env pull` + patch helper + restart reminder. | D2 |
| `scripts/ops/patch-env-docker.py` | D2 — preserves local-only keys + cloudflared tunnel URL; never prints values. | D2 |
| `scripts/ops/setup-named-tunnel.sh` | D5 — one-time setup (login + create tunnel + DNS route + per-tunnel config write). Idempotent. | D5 |
