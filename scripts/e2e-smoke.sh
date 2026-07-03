#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# E2E smoke test: Docker build → Postgres + app → seed → curl assertions
#
# Usage: bash scripts/e2e-smoke.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

COMPOSE_FILE="docker-compose.e2e.yml"
PROJECT="geo-e2e"
APP_URL="http://localhost:3099"
DB_URL="postgres://e2e:e2e@localhost:5499/geo_e2e"
PASS=0
FAIL=0
TESTS=()

cleanup() {
  echo ""
  echo "═══ Tearing down ═══"
  docker compose -f "$COMPOSE_FILE" -p "$PROJECT" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    TESTS+=("  ✓ $label")
    PASS=$((PASS + 1))
  else
    TESTS+=("  ✗ $label (expected: $expected, got: $actual)")
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    TESTS+=("  ✓ $label")
    PASS=$((PASS + 1))
  else
    TESTS+=("  ✗ $label (missing: '$needle')")
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    TESTS+=("  ✗ $label (should NOT contain: '$needle')")
    FAIL=$((FAIL + 1))
  else
    TESTS+=("  ✓ $label")
    PASS=$((PASS + 1))
  fi
}

# ─── Step 1: Build & start ────────────────────────────────────────────────────
echo "═══ Building Docker images ═══"
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" build --quiet

echo "═══ Starting services ═══"
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up -d

echo "Waiting for Postgres..."
for i in $(seq 1 30); do
  if docker compose -f "$COMPOSE_FILE" -p "$PROJECT" exec -T db pg_isready -U e2e -d geo_e2e &>/dev/null; then
    echo "Postgres ready."
    break
  fi
  sleep 1
done

# ─── Step 2: Push schema & seed ──────────────────────────────────────────────
echo "═══ Pushing schema to test DB ═══"
DATABASE_URL_DIRECT="$DB_URL" DATABASE_URL="$DB_URL" SUPABASE_DATABASE_URL="$DB_URL" \
  npx drizzle-kit push --force 2>&1 | tail -5

echo "═══ Seeding test data ═══"
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" exec -T db psql -U e2e -d geo_e2e -c "
INSERT INTO geo_sites (
  id, domain, slug, owner_email, pipeline_status,
  generated_schema_blocks, generated_llms_txt
) VALUES (
  'e2e-site-001',
  'e2etest.com',
  'e2etest-com',
  'test@e2etest.com',
  'complete',
  '[
    {\"type\": \"Organization\", \"jsonLd\": {\"@type\": \"Organization\", \"name\": \"E2E Corp\", \"url\": \"https://e2etest.com\"}},
    {\"type\": \"FAQPage\", \"pageTarget\": \"https://e2etest.com/faq\", \"jsonLd\": {\"@type\": \"FAQPage\", \"name\": \"FAQ\"}},
    {\"type\": \"RobotsTxt\", \"jsonLd\": {\"content\": \"User-agent: *\"}}
  ]'::jsonb,
  'E2E test llms.txt content'
);
"
echo "Seed complete."

# Restart app so it connects to DB with schema in place
echo "═══ Restarting app ═══"
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" restart geo
sleep 3

# ─── Step 3: Wait for app ────────────────────────────────────────────────────
echo "═══ Waiting for app to start ═══"
for i in $(seq 1 60); do
  if curl -sf "$APP_URL" -o /dev/null 2>/dev/null; then
    echo "App ready on $APP_URL"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: App failed to start after 60s"
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT" logs geo | tail -30
    exit 1
  fi
  sleep 1
done

# ─── Step 4: Run curl tests ──────────────────────────────────────────────────
# Disable errexit for test assertions (grep returns 1 on no match)
set +e

echo ""
echo "═══ Running E2E smoke tests ═══"
SLUG="e2etest-com"

# ── T1: Human UA → beacon JS ──
echo "T1: Human UA → beacon JS"
RESP=$(curl -s -D /tmp/e2e_h "$APP_URL/api/t/$SLUG" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36")
HEADERS=$(cat /tmp/e2e_h)

assert_contains "T1a: body contains sendBeacon" "sendBeacon" "$RESP"
assert_contains "T1b: body contains absolute collect URL" "https://geo.flowblinq.com/api/t/collect" "$RESP"
assert_not_contains "T1c: body does NOT contain _fbInject" "_fbInject" "$RESP"
assert_contains "T1d: body contains slug" "$SLUG" "$RESP"
assert_contains "T1e: Cache-Control 24hr" "max-age=86400" "$HEADERS"
assert_contains "T1f: Vary User-Agent" "User-Agent" "$HEADERS"
BODY_LEN=${#RESP}
if [ "$BODY_LEN" -lt 500 ]; then
  TESTS+=("  ✓ T1g: beacon JS < 500 bytes ($BODY_LEN bytes)")
  PASS=$((PASS + 1))
else
  TESTS+=("  ✗ T1g: beacon JS >= 500 bytes ($BODY_LEN bytes)")
  FAIL=$((FAIL + 1))
fi

# ── T2: Bot UA (GPTBot) → schema injection JS ──
echo "T2: Bot UA (GPTBot) → schema injection JS"
RESP=$(curl -s -D /tmp/e2e_h "$APP_URL/api/t/$SLUG" \
  -H "User-Agent: Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)")
HEADERS=$(cat /tmp/e2e_h)

assert_contains "T2a: body contains _fbInject" "_fbInject" "$RESP"
assert_contains "T2b: body contains Organization" "Organization" "$RESP"
assert_contains "T2c: body contains E2E Corp" "E2E Corp" "$RESP"
assert_contains "T2d: body contains application/ld+json" "application/ld+json" "$RESP"
assert_contains "T2e: Cache-Control 1hr" "max-age=3600" "$HEADERS"
assert_contains "T2f: Vary User-Agent" "User-Agent" "$HEADERS"

# ── T3: RobotsTxt blocks excluded ──
echo "T3: Bot path excludes RobotsTxt blocks"
assert_not_contains "T3a: RobotsTxt content excluded" "User-agent: *" "$RESP"

# ── T4: Page-specific conditionals ──
echo "T4: Bot path has page-specific pathname conditionals"
assert_contains "T4a: FAQPage in output" "FAQPage" "$RESP"
assert_contains "T4b: pathname conditional for /faq" "/faq" "$RESP"

# ── T5: Other bots get schema ──
echo "T5: ClaudeBot → schema injection"
RESP=$(curl -s "$APP_URL/api/t/$SLUG" -H "User-Agent: ClaudeBot/1.0 (claude@anthropic.com)")
assert_contains "T5a: ClaudeBot gets _fbInject" "_fbInject" "$RESP"
assert_contains "T5b: ClaudeBot gets E2E Corp" "E2E Corp" "$RESP"

echo "T6: Twitterbot → schema injection"
RESP=$(curl -s "$APP_URL/api/t/$SLUG" -H "User-Agent: Twitterbot/1.0")
assert_contains "T6a: Twitterbot gets _fbInject" "_fbInject" "$RESP"

# ── T7: Bot for nonexistent slug → fallback ──
echo "T7: Bot for nonexistent slug → fallback to beacon"
RESP=$(curl -s "$APP_URL/api/t/nonexistent-slug" \
  -H "User-Agent: Mozilla/5.0 (compatible; GPTBot/1.0)")
assert_contains "T7a: fallback contains sendBeacon" "sendBeacon" "$RESP"
assert_not_contains "T7b: fallback has no _fbInject" "_fbInject" "$RESP"

# ── T8: Backward compat — /api/serve/schema.js ──
echo "T8: Backward compat — /api/serve/$SLUG/schema.js"
RESP=$(curl -s -D /tmp/e2e_h "$APP_URL/api/serve/$SLUG/schema.js" \
  -H "User-Agent: Mozilla/5.0 (compatible; GPTBot/1.0)")
HEADERS=$(cat /tmp/e2e_h)
assert_contains "T8a: serve schema.js contains _fbInject" "_fbInject" "$RESP"
assert_contains "T8b: serve schema.js contains E2E Corp" "E2E Corp" "$RESP"
assert_contains "T8c: serve schema.js Content-Type JS" "application/javascript" "$HEADERS"

# ── T9: Beacon collect ──
echo "T9: Beacon collect endpoint"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$APP_URL/api/t/collect" \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 Chrome/120" \
  -d '{"s":"e2etest-com","u":"https://e2etest.com/page","r":"https://google.com","w":1920}')
assert_eq "T9a: collect returns 204" "204" "$HTTP_CODE"

# ── T10: Collect rejects missing slug ──
echo "T10: Collect rejects bad payload"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$APP_URL/api/t/collect" \
  -H "Content-Type: application/json" \
  -d '{"u":"https://e2etest.com/page"}')
assert_eq "T10a: collect returns 400 for missing slug" "400" "$HTTP_CODE"

# ── T10b: Simulate bot visiting website → bot fetches <img> pixel from GEO ──
echo "T10b: Bot visits website — img pixel detected by GEO"
# When GPTBot visits a website with <img src="geo.flowblinq.com/api/t/SLUG">,
# it fetches the image (bots load images but don't execute JS).
# The Accept header for img requests includes "image/".
RESP=$(curl -s -D /tmp/e2e_h "$APP_URL/api/t/$SLUG" \
  -H "User-Agent: Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)" \
  -H "Accept: image/avif,image/webp,image/apng,image/*,*/*;q=0.8" \
  -H "Referer: https://e2etest.com/" -o /tmp/e2e_bot_gif)
HEADERS=$(cat /tmp/e2e_h)
assert_contains "T10b-1: bot img request → image/gif" "image/gif" "$HEADERS"
# Verify the bot's visit was logged as a pageview
sleep 1
BOT_PV=$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" exec -T db \
  psql -U e2e -d geo_e2e -t -c "SELECT COUNT(*) FROM geo_page_views WHERE slug='$SLUG' AND bot_name='GPTBot';" 2>/dev/null | tr -d ' ')
if [ "$BOT_PV" -gt 0 ] 2>/dev/null; then
  TESTS+=("  ✓ T10b-2: GPTBot pageview logged via img pixel ($BOT_PV rows)")
  PASS=$((PASS + 1))
else
  TESTS+=("  ✗ T10b-2: GPTBot pageview NOT logged (count: $BOT_PV)")
  FAIL=$((FAIL + 1))
fi

# ── T11: Img pixel ──
echo "T11: Img pixel — Accept: image/gif"
RESP=$(curl -s -D /tmp/e2e_h "$APP_URL/api/t/$SLUG" \
  -H "Accept: image/gif, image/*;q=0.8" \
  -H "User-Agent: Mozilla/5.0 Chrome/120" \
  -H "Referer: https://e2etest.com/pricing" -o /tmp/e2e_gif)
HEADERS=$(cat /tmp/e2e_h)
assert_contains "T11a: Content-Type image/gif" "image/gif" "$HEADERS"
assert_contains "T11b: Cache-Control no-store" "no-store" "$HEADERS"
# Check GIF starts with GIF89a
GIF_HEADER=$(xxd -l 6 -p /tmp/e2e_gif 2>/dev/null)
if [ "$GIF_HEADER" = "474946383961" ]; then
  TESTS+=("  ✓ T11c: valid GIF89a header")
  PASS=$((PASS + 1))
else
  TESTS+=("  ✗ T11c: invalid GIF header ($GIF_HEADER)")
  FAIL=$((FAIL + 1))
fi

# Img pixel with bot UA → still returns GIF
echo "T11d: Bot UA + Accept: image/* → GIF"
RESP=$(curl -s -D /tmp/e2e_h "$APP_URL/api/t/$SLUG" \
  -H "Accept: image/gif" \
  -H "User-Agent: GPTBot/1.0" -o /dev/null)
HEADERS=$(cat /tmp/e2e_h)
assert_contains "T11d: bot + img → still image/gif" "image/gif" "$HEADERS"

# Check DB for pageview from img pixel
echo "T12: DB verification — img pixel logged pageview"
sleep 1
PV_COUNT=$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" exec -T db \
  psql -U e2e -d geo_e2e -t -c "SELECT COUNT(*) FROM geo_page_views WHERE slug='$SLUG' AND page_url LIKE '%pricing%';" 2>/dev/null | tr -d ' ')
if [ "$PV_COUNT" -gt 0 ] 2>/dev/null; then
  TESTS+=("  ✓ T12a: pageview logged with referrer ($PV_COUNT rows)")
  PASS=$((PASS + 1))
else
  TESTS+=("  ✗ T12a: no pageview found (count: $PV_COUNT)")
  FAIL=$((FAIL + 1))
fi

# Check DB for crawl log from bot schema hit
echo "T13: DB verification — bot crawl logged"
CL_COUNT=$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" exec -T db \
  psql -U e2e -d geo_e2e -t -c "SELECT COUNT(*) FROM geo_crawl_logs WHERE slug='$SLUG' AND bot_name='GPTBot';" 2>/dev/null | tr -d ' ')
if [ "$CL_COUNT" -gt 0 ] 2>/dev/null; then
  TESTS+=("  ✓ T13a: crawl log exists for GPTBot ($CL_COUNT rows)")
  PASS=$((PASS + 1))
else
  TESTS+=("  ✗ T13a: no crawl log for GPTBot (count: $CL_COUNT)")
  FAIL=$((FAIL + 1))
fi

# ── T14: Static assets ──
echo "T14: Favicon and logo"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$APP_URL/icon.svg")
assert_eq "T14a: icon.svg returns 200" "200" "$HTTP_CODE"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$APP_URL/logo.png")
assert_eq "T14b: logo.png returns 200" "200" "$HTTP_CODE"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$APP_URL/apple-icon.png")
assert_eq "T14c: apple-icon.png returns 200" "200" "$HTTP_CODE"

# ─── Results ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo " E2E SMOKE TEST RESULTS"
echo "═══════════════════════════════════════════"
for t in "${TESTS[@]}"; do echo "$t"; done
echo ""
TOTAL=$((PASS + FAIL))
echo " $PASS passed, $FAIL failed ($TOTAL total)"
echo "═══════════════════════════════════════════"

rm -f /tmp/e2e_h

if [ "$FAIL" -gt 0 ]; then exit 1; fi
