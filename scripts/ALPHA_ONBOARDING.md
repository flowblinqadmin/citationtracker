# Alpha Tester Onboarding Checklist

## For Each New Alpha Tester

### 1. Account Setup
- User creates account via the login page
- Team is created automatically with 20 bonus credits (`SIGNUP_BONUS_CREDITS`)

### 2. First Audit
- User navigates to the dashboard and enters their domain
- Pipeline runs: discovery → crawling → analysis → generation → assembly
- On completion, user sees their GEO Scorecard with score and recommendations

### 3. Deploy Generated Files
The user deploys the generated files to their website:
- `llms.txt` at `/.well-known/llms.txt` (or site root)
- `llms-full.txt` alongside `llms.txt`
- `business.json` structured data
- `schema.json` / `schema.js` JSON-LD blocks

**For SSR platforms (Next.js, Nuxt, Rails, Django, Laravel):** fetch `schema.json` server-side and inline as `<script type="application/ld+json">` tags in the `<head>`. Do NOT use Next.js `<Script strategy="afterInteractive">` — crawlers won't see it.

### 4. Verify Domain
- User adds a DNS TXT record: `geo-verify=<verifyToken>`
- OR places the verification token in their `llms.txt` file
- User clicks "Verify" in the dashboard to confirm ownership

### 5. Verify Connection
- Confirm `llms.txt` is accessible: `curl https://<domain>/.well-known/llms.txt`
- Confirm serve routes work: `curl https://geo.flowblinq.com/api/serve/<slug>/llms.txt`

### 6. Admin Registration
- Admin adds domain to `ALPHA_TESTER_DOMAINS` in `lib/config.ts`
- Verify the site appears in: `node scripts/alpha-status.mjs`

### 7. Weekly Recrawl
- Automatic: `nextCrawlAt` is set to 7 days after each successful pipeline run
- The `/api/cron/recrawl` cron job picks up sites where `nextCrawlAt < now`
- Requires `paymentStatus = 'active'` (set by Stripe webhook on payment)

### 8. Monitoring
- Check health: `node scripts/alpha-status.mjs`
- Check all sites: `node scripts/alpha-status.mjs --all`
- Stress test serve endpoints: `node scripts/stress-test-serve.mjs`
- Flags to watch: `STALE` (>7 days since last crawl), `ERROR` (pipeline failed), `NEVER_RUN`

## Troubleshooting

| Issue | Check |
|-------|-------|
| Pipeline stuck | `node scripts/check-site.mjs <domain>` — check `pipeline_status` and `pipeline_error` |
| Score not improving | Compare `baselineScorecard.overallScore` vs `geoScorecard.overallScore` via API |
| Recrawl not happening | Verify `paymentStatus = 'active'` and `nextCrawlAt` is in the past |
| Serve routes 404 | Verify `generatedLlmsTxt` is not null: `node scripts/check-site.mjs <domain>` |
| Rate limited | AI crawlers (GPTBot, ClaudeBot, etc.) are allowlisted; unknown UAs have 10 req/min/IP limit |
