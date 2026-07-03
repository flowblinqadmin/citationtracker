# ES-008 — Local Docker Staging with Cloudflared Tunnel

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `n/a — infra`  

---

**Author:** SpecMaster (2-specmaster)
**Date:** 2026-03-01
**Status:** Ready for costing
**Source TS:** TS-008-local-docker-staging.md
**Lang:** bash

---

## a) Overview

### What this covers
A local development staging environment for the `geo` Next.js app using Docker Compose and a cloudflared quick tunnel. Enables full end-to-end pipeline testing (including `after()` self-trigger and QStash signature verification) without Vercel.

### Reference
- Source: `TS-008-local-docker-staging.md`
- CoFounder message: `2026-03-01T120000-ts008-docker-staging.yaml`

### Current implementation state

| Item | State |
|------|-------|
| `geo/docker-compose.yml` | Exists — runs on `localhost:3030`, no tunnel, no `NEXT_PUBLIC_APP_URL` |
| `geo/Dockerfile` | Exists — multi-stage standalone build, no changes needed |
| `geo/scripts/` | Exists — populated with utility scripts, `dev-start.sh` does not yet exist |
| `geo/.env.example` | Exists — missing local staging annotations |
| `geo/docker-compose.dev.yml` | **Does not exist — must be created** |
| `geo/scripts/dev-start.sh` | **Does not exist — must be created** |

### Why this is needed
Inside the container, `localhost:3030` is unreachable (container binds on `0.0.0.0:3000` internally; host port 3030 is not visible to the container process). The pipeline's `after()` self-trigger POSTs to `NEXT_PUBLIC_APP_URL/api/cron/process-queue` and QStash verifies signatures against that URL — both require a real HTTPS URL reachable from inside the container. A cloudflared quick tunnel provides this at zero cost and zero configuration.

### Architecture
```
Browser / QStash / Stripe
        │
        ▼
https://xxx.trycloudflare.com   ← cloudflared quick tunnel (host process)
        │
        ▼
http://localhost:3030            ← host port (mapped from container)
        │
        ▼
http://geo:3000                  ← Next.js container (internal Docker port)
```

---

## b) Implementation Requirements

### Files to create

| File | Action |
|------|--------|
| `geo/docker-compose.dev.yml` | Create |
| `geo/scripts/dev-start.sh` | Create + `chmod +x` |
| `geo/.env.example` | Append local staging section |

**No changes to `src/`, `tests/`, `geo/docker-compose.yml`, or `geo/Dockerfile`.**

---

### File 1: `geo/docker-compose.dev.yml`

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

**Key implementation notes:**
- `image: geo-dev` — distinct from `geo-app` (production compose) to prevent tag collisions
- `env_file: .env.local` — reuses existing secrets; no duplication
- `NEXT_PUBLIC_APP_URL: ${TUNNEL_URL:-http://localhost:3030}` — shell substitution; Docker Compose evaluates this from the host environment at `up` time
- `TUNNEL_URL` is NOT in `.env.local` — it is injected at runtime by `dev-start.sh` via `TUNNEL_URL="$TUNNEL_URL" docker compose ... up`
- Healthcheck uses `wget` (available in the standalone Next.js image) to poll `localhost:3000` (internal container port, not 3030)
- `start_period: 45s` — gives Next.js standalone adequate boot time before health retries count against the limit

---

### File 2: `geo/scripts/dev-start.sh`

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

**Key implementation notes:**
- `SCRIPT_DIR` / `GEO_DIR` resolution uses `BASH_SOURCE[0]` — works correctly when script is called from any working directory
- `cloudflared` is backgrounded before Docker starts; its PID is captured for cleanup
- `tee "$TUNNEL_LOG"` writes cloudflared output to both stdout and the temp log file simultaneously — user sees tunnel output in real time
- URL extraction uses `grep -oP` (Perl regex); pattern `https://[a-z0-9-]+\.trycloudflare\.com` matches the format cloudflared emits
- `|| true` on the grep prevents `set -e` from exiting when grep finds no match during the polling loop
- `trap cleanup EXIT INT TERM` — covers Ctrl+C (INT), `kill` (TERM), and normal exit
- `TUNNEL_URL="$TUNNEL_URL" docker compose ... up` — injects the env var for Docker Compose shell substitution without exporting it into the shell permanently
- Must be made executable: `chmod +x geo/scripts/dev-start.sh`

---

### File 3: `geo/.env.example` — append section

Append to the end of the existing file:

```bash
# ── Local staging (docker + cloudflared tunnel) ────────────────────────────────
# Use scripts/dev-start.sh to start — it sets NEXT_PUBLIC_APP_URL automatically.
# Do NOT set NEXT_PUBLIC_APP_URL here; dev-start.sh injects TUNNEL_URL at runtime.
#
# Required for pipeline self-trigger (after() → /api/cron/process-queue):
CRON_SECRET=any-local-secret-here
#
# Optional: Stripe webhook testing (run separately):
#   stripe listen --forward-to localhost:3030/api/webhooks/stripe
#
# ngrok alternative to cloudflared:
#   Replace `cloudflared tunnel --url http://localhost:3030` in dev-start.sh
#   with `ngrok http 3030` and update the URL grep pattern accordingly.
```

---

## c) Unit Test Plan

### Test file
`geo/scripts/dev-start.test.sh` (bash bats-style) — or manual verification steps since this is a shell script with external dependencies.

**Note:** Full unit testing of `dev-start.sh` requires mocking `cloudflared` and `docker`. ScriptDev should implement the following manual smoke tests at minimum; automated tests are optional given the infra nature of this work.

### Test cases

| # | Test | Input | Expected |
|---|------|-------|----------|
| 1 | Missing cloudflared | `cloudflared` not in PATH | Exits 1, prints install instructions |
| 2 | Missing docker | `docker` not in PATH | Exits 1, prints "docker not found" |
| 3 | Missing `.env.local` | `.env.local` absent | Exits 1, prints copy instructions |
| 4 | Tunnel URL timeout | cloudflared produces no URL in 30s | Exits 1, dumps `$TUNNEL_LOG` |
| 5 | Successful startup | All prereqs met, tunnel starts | Prints URL banner, starts compose |
| 6 | Ctrl+C cleanup | Send SIGINT after startup | cloudflared and compose both shut down cleanly |
| 7 | TUNNEL_URL fallback | `TUNNEL_URL` not set, compose started directly | `NEXT_PUBLIC_APP_URL=http://localhost:3030` inside container |

### Mock/stub requirements
- Mock `cloudflared`: a shell script at a temp PATH entry that writes a fake `https://test-abc.trycloudflare.com` line to stderr after 2s
- Mock `docker`: a shell script that exits 0 and prints expected output

### Coverage target
All 7 test cases manually verified before marking done.

---

## d) Integration Test Plan

### Test file
Manual integration checklist (no automated integration tests — this is pure infra).

### Scenarios

| # | Scenario | Steps | Pass condition |
|---|----------|-------|----------------|
| 1 | Full startup | Run `./scripts/dev-start.sh` from `geo/` | Tunnel URL printed, container healthy |
| 2 | App reachable locally | `curl -I http://localhost:3030/` | HTTP 200 or 3xx |
| 3 | App reachable via tunnel | `curl -I https://xxx.trycloudflare.com/` | HTTP 200 or 3xx |
| 4 | NEXT_PUBLIC_APP_URL injected | `docker exec geo-geo-1 env \| grep NEXT_PUBLIC_APP_URL` | Shows tunnel URL, not localhost |
| 5 | Pipeline self-trigger | Submit audit URL, wait for processing | Status progresses `discovery → crawling → processing → complete` |
| 6 | Clean shutdown | Ctrl+C | Both cloudflared PID and Docker container stop; no orphan processes |
| 7 | Existing compose unaffected | `docker compose up` (no `-f` flag) | Uses `geo-app` image, no TUNNEL_URL required, starts normally |

### End-to-end data flow
```
dev-start.sh starts cloudflared (host)
  → captures TUNNEL_URL from log
  → passes TUNNEL_URL to docker compose env
  → docker compose sets NEXT_PUBLIC_APP_URL in container
  → Next.js app uses NEXT_PUBLIC_APP_URL for after() self-trigger
  → after() POSTs to https://xxx.trycloudflare.com/api/cron/process-queue
  → cloudflared forwards to localhost:3030
  → container receives request at port 3000
  → pipeline continues
```

---

## e) Profiling Requirements

Not applicable for this spec — this is a dev tooling addition with no production performance impact.

**Acceptable overhead:** Tunnel round-trip adds ~50–200ms latency to `after()` callbacks. This is acceptable for local staging; production uses direct Vercel invocation.

---

## f) Load Test Plan

Not applicable. This is a single-developer local staging environment. No concurrent load testing required.

---

## g) Logging & Instrumentation

### dev-start.sh output (stdout)
| Event | Message |
|-------|---------|
| cloudflared starting | `Starting cloudflared quick tunnel → localhost:3030 ...` |
| Polling for URL | `Waiting for tunnel URL...` |
| URL captured | Banner block with Tunnel URL and Local URL |
| Docker build starting | `Building Docker image...` |
| Docker compose starting | `Starting geo container...` |
| Shutdown initiated | `Shutting down...` |
| Tunnel URL timeout | `ERROR: Tunnel URL not found after 30s` + log dump |

### Levels
- All output goes to stdout (no log levels needed for a shell script)
- cloudflared's own output is tee'd to stdout so the user sees it in real time
- The temp log file (`/tmp/cloudflared-dev.XXXXXX`) is cleaned up on exit

### No application-level instrumentation changes required.
This spec adds no new server-side logging, metrics, or tracing.

---

## h) Acceptance Criteria

- [ ] `geo/docker-compose.dev.yml` exists and is valid (`docker compose -f docker-compose.dev.yml config` passes)
- [ ] `geo/scripts/dev-start.sh` exists and is executable (`-x` bit set)
- [ ] Script checks for `cloudflared`, `docker`, and `.env.local` before proceeding
- [ ] `NEXT_PUBLIC_APP_URL` inside running container equals the cloudflared tunnel URL (not `localhost`)
- [ ] App responds HTTP 200 at both `http://localhost:3030/` and `https://xxx.trycloudflare.com/`
- [ ] Pipeline self-trigger completes full status progression in local staging
- [ ] Ctrl+C shuts down both cloudflared and Docker cleanly (no orphan processes)
- [ ] Existing `geo/docker-compose.yml` is unchanged and still works (`docker compose up` unaffected)
- [ ] `geo/.env.example` includes local staging section with `CRON_SECRET` annotation
- [ ] No changes to `src/`, `tests/`, `middleware.ts`, or any application code
