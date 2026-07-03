# TS-008 — Local Docker Staging with Tunnel

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `n/a — infra`  

---

**Author:** CoFounder
**Date:** 2026-03-01
**Status:** Ready for engineering spec

---

## What

Add a development-mode Docker Compose file (`docker-compose.dev.yml`) and startup script (`scripts/dev-start.sh`) that enable full end-to-end local staging of the geo Next.js app — including the async pipeline — via a cloudflared quick tunnel.

---

## Why

The existing `docker-compose.yml` runs the app on `http://localhost:3030`, but the pipeline's self-trigger (`after()` → `/api/cron/process-queue`) and QStash signature verification both require `NEXT_PUBLIC_APP_URL` to be a reachable URL. Inside the container, `localhost:3030` is invalid (the container binds on port 3000 internally, and the host-mapped port 3030 is unreachable from within the container). A cloudflared quick tunnel creates a public HTTPS URL that is reachable from both the browser and from inside the container.

---

## Dependencies

- Existing `Dockerfile` (multi-stage, standalone output) — no changes needed
- Existing `docker-compose.yml` — kept as-is for simple offline usage
- `cloudflared` binary must be installed on the host (`brew install cloudflared` / `apt install cloudflared`)

---

## Architecture

```
Browser / QStash / Stripe
        │
        ▼
https://xxx.trycloudflare.com  ← cloudflared quick tunnel (host process)
        │
        ▼
http://localhost:3030           ← host port (mapped from container)
        │
        ▼
http://geo:3000                 ← Next.js container (internal Docker port)
```

`NEXT_PUBLIC_APP_URL` is set to the tunnel URL, so:
- Auth callback redirects work for browser
- `after()` self-trigger resolves correctly (goes out via tunnel, back in on port 3030)
- QStash signature verification matches the correct URL

---

## Interfaces

### 1. `docker-compose.dev.yml`

New file at `/home/aditya/flowblinq/geo/docker-compose.dev.yml`.

```yaml
# Development compose — use via scripts/dev-start.sh (not directly)
# Requires TUNNEL_URL env var to be set by the startup script.
services:
  geo:
    build:
      context: .
      dockerfile: Dockerfile
    image: geo-dev
    ports:
      - "3030:3000"
    env_file:
      - .env.local
    environment:
      NODE_ENV: production
      NEXT_PUBLIC_APP_URL: ${TUNNEL_URL:-http://localhost:3030}
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/ -S 2>&1 | grep -q 'HTTP/' || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 8
      start_period: 45s
```

Notes:
- `env_file: .env.local` — reuses existing secrets from `.env.local` (same as production `docker-compose.yml`)
- `NEXT_PUBLIC_APP_URL` is overridden by the `TUNNEL_URL` environment variable injected by the startup script
- Falls back to `http://localhost:3030` if `TUNNEL_URL` is not set (allows basic offline testing, pipeline self-trigger will fail gracefully)
- No cloudflared service in the compose file — tunnel runs on host so it can tunnel `localhost:3030` directly (simpler than Docker networking)

### 2. `scripts/dev-start.sh`

New file at `/home/aditya/flowblinq/geo/scripts/dev-start.sh`.

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEO_DIR="$(dirname "$SCRIPT_DIR")"

# ── Prereq checks ──────────────────────────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
  echo "ERROR: cloudflared not found. Install: brew install cloudflared (macOS) or apt install cloudflared (Linux)"
  exit 1
fi
if ! command -v docker &>/dev/null; then
  echo "ERROR: docker not found"
  exit 1
fi
if [ ! -f "$GEO_DIR/.env.local" ]; then
  echo "ERROR: .env.local not found in $GEO_DIR — copy .env.example and fill in values"
  exit 1
fi

# ── Start tunnel ───────────────────────────────────────────────────────────────
TUNNEL_LOG=$(mktemp /tmp/cloudflared-dev.XXXXXX)
echo "Starting cloudflared quick tunnel → localhost:3030 ..."
cloudflared tunnel --url http://localhost:3030 --no-autoupdate 2>&1 | tee "$TUNNEL_LOG" &
CLOUDFLARED_PID=$!

# Cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$CLOUDFLARED_PID" 2>/dev/null || true
  docker compose -f "$GEO_DIR/docker-compose.dev.yml" down 2>/dev/null || true
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT INT TERM

# Wait for tunnel URL (timeout 30s)
TUNNEL_URL=""
echo "Waiting for tunnel URL..."
for i in $(seq 30); do
  TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
  if [ -n "$TUNNEL_URL" ]; then break; fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: Tunnel URL not found after 30s. Check cloudflared output:"
  cat "$TUNNEL_LOG"
  exit 1
fi

echo ""
echo "=========================================="
echo "  Tunnel:  $TUNNEL_URL"
echo "  Local:   http://localhost:3030"
echo "=========================================="
echo ""

# ── Build + start geo container ────────────────────────────────────────────────
echo "Building Docker image..."
docker compose -f "$GEO_DIR/docker-compose.dev.yml" build

echo "Starting geo container..."
TUNNEL_URL="$TUNNEL_URL" docker compose -f "$GEO_DIR/docker-compose.dev.yml" up
```

Make executable: `chmod +x scripts/dev-start.sh`

### 3. `.env.local` additions for local staging

The following env vars may need adjustment in `.env.local` for local staging (document in `.env.example` comments):

```bash
# --- Local staging overrides ---
# NEXT_PUBLIC_APP_URL is set dynamically by scripts/dev-start.sh — do NOT set here
# CRON_SECRET must be set for pipeline self-trigger to work
CRON_SECRET=any-local-secret-here
```

No new env vars are introduced — `TUNNEL_URL` is injected at runtime by the script.

---

## Acceptance Criteria

1. `./scripts/dev-start.sh` starts successfully:
   - Cloudflared outputs a `trycloudflare.com` URL
   - Docker builds the geo image (or uses cached)
   - Container starts and the health check passes

2. `NEXT_PUBLIC_APP_URL` is correctly set to the tunnel URL inside the container:
   - `docker exec geo-geo-1 env | grep NEXT_PUBLIC_APP_URL` shows the tunnel URL

3. App is reachable via both:
   - `http://localhost:3030/` (local)
   - `https://xxx.trycloudflare.com/` (tunnel)

4. Pipeline self-trigger works:
   - Submit a URL for audit
   - After crawl phase, the `after()` callback fires to `/api/cron/process-queue`
   - Status progresses through `discovery → crawling → processing → complete`

5. Ctrl+C cleanly shuts down both cloudflared and the Docker container

6. Existing `docker-compose.yml` is unchanged and still works as before

---

## Risks

| Risk | Mitigation |
|------|-----------|
| `trycloudflare.com` URL changes on restart | URL is re-captured on every `dev-start.sh` run — no stale config |
| Tunnel latency adds overhead to `after()` self-trigger | Acceptable for staging; pipeline still completes correctly |
| cloudflared not installed on dev machine | Script checks prereqs and prints install instructions |
| `.env.local` missing `CRON_SECRET` | If missing, `after()` self-trigger is silently skipped (runner.ts already guards with `if process.env.CRON_SECRET`) — pipeline can still be triggered manually |
| Next.js `after()` behaviour in standalone Docker | `after()` in Next.js standalone runs via `setImmediate`-equivalent — no Vercel infra required, works in Node.js |

---

## Out of Scope

- Stripe webhook testing (use `stripe listen --forward-to localhost:3030/api/webhooks/stripe` separately)
- Supabase local emulation (app connects to the real Supabase project)
- Named cloudflared tunnels (requires Cloudflare account — this uses the free anonymous `trycloudflare.com` tunnels)
- ngrok is a drop-in alternative: replace `cloudflared tunnel --url http://localhost:3030` with `ngrok http 3030` and parse `https://[a-z0-9]+\.ngrok[-a-z]*.io` from the output

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `geo/docker-compose.dev.yml` | **Create** |
| `geo/scripts/dev-start.sh` | **Create** (chmod +x) |
| `geo/.env.example` | **Append** local staging notes |
