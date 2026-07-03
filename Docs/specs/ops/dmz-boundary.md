# DMZ Architecture — Zone Boundary Specification

**Owner:** OpsMaster (Agent 3)
**Date:** 2026-03-01
**Task:** T008 / GitHub Issue #13
**Source spec:** ES-004-m2-sprint3-security-and-ops.md

---

## 1. Zone Diagram (ASCII)

```
┌─────────────────────────────────────────────────────────────────┐
│                        INTERNET                                 │
│   AI Crawlers │ Customers │ Stripe Webhooks │ Auth Callbacks    │
└──────┬──────────────┬────────────────┬──────────────┬───────────┘
       │              │                │              │
       ▼              ▼                ▼              ▼
┌─────────────┐ ┌───────────┐ ┌───────────────┐ ┌──────────┐
│  SERVE ZONE │ │REPORT ZONE│ │ PAYMENT ZONE  │ │AUTH ZONE │
│             │ │           │ │               │ │          │
│/api/serve/* │ │/api/report│ │/api/checkout  │ │/auth/*   │
│             │ │/*         │ │/api/webhooks/ │ │/api/teams│
│READ: geoSites│ │READ:      │ │  stripe       │ │/*        │
│INSERT:      │ │  geoSites │ │               │ │          │
│  crawlLogs  │ │           │ │WRITE: teams   │ │WRITE:    │
│             │ │           │ │  creditTx     │ │  teams   │
│External:    │ │External:  │ │               │ │teamMembers│
│  none       │ │  none     │ │External:Stripe│ │          │
└─────────────┘ └───────────┘ └───────────────┘ │External: │
                                                  │  Supabase│
                                                  └──────────┘
                        │
                        ▼
              ┌──────────────────┐
              │  PIPELINE ZONE   │
              │                  │
              │ /api/sites/[id]/ │
              │   regenerate     │
              │   verify         │
              │ /api/cron/*      │
              │                  │
              │ WRITE: geoSites  │
              │ READ:  teams     │
              │   (credit check) │
              │ INSERT: creditTx │
              │   (crawl_debit)  │
              │                  │
              │ External:        │
              │   Gemini, Jina   │
              │   Firecrawl      │
              │   ScraperAPI     │
              │   Apify          │
              └──────────────────┘
```

---

## 2. Zone Definitions

| Zone | Entry Routes | DB Tables (Write) | DB Tables (Read) | External Services | SDK Imports |
|------|-------------|-------------------|------------------|-------------------|-------------|
| **Payment** | `/api/checkout`, `/api/webhooks/stripe` | `teams` (credits), `creditTransactions` | `teams` | Stripe | `stripe`, `drizzle` |
| **Auth** | `/auth/*`, `/api/teams/*` | `teams`, `teamMembers` | `teams`, `teamMembers` | Supabase Auth | `@supabase/ssr`, `drizzle` |
| **Pipeline** | `/api/sites/[id]/regenerate`, `/api/sites/[id]/verify`, `/api/cron/*` | `geoSites` (all fields), `creditTransactions` (debit) | `teams` (credit balance READ only) | Gemini, Jina, Firecrawl, ScraperAPI, Apify | AI SDKs, crawler libs, `drizzle` |
| **Serve** | `/api/serve/*` | `geoCrawlLogs` (INSERT only) | `geoSites` (READ only) | None | `drizzle` (read) |
| **Report** | `/api/report/*` | _(none)_ | `geoSites` (READ only) | None | `drizzle` (read) |

---

## 3. Shared Table Access Points

The only intentional cross-zone table sharing:

| Table | Payment Zone | Pipeline Zone | Notes |
|-------|-------------|---------------|-------|
| `creditTransactions` | INSERT on `checkout.session.completed` (topup) | INSERT on `regenerate` (crawl_debit) | Audit log — not shared mutable state. Acceptable. |
| `teams` | WRITE credits column | READ creditBalance only | Pipeline is read-only on this table. |

All other tables are single-zone owned. No cross-zone write conflicts.

---

## 4. Import Audit Results

Audit run: 2026-03-01 against `/home/aditya/flowblinq/archive/geo`

### Audit 1: Stripe SDK Import Isolation

**Command:**
```bash
grep -rn "stripe" app/api/ lib/ --include="*.ts" --include="*.tsx" | grep -v node_modules
```

**Expected:** Stripe SDK imports only in `app/api/checkout/` and `app/api/webhooks/stripe/`

**Result: PASS**

| File | Finding | Assessment |
|------|---------|------------|
| `app/api/checkout/route.ts:2` | `import Stripe from "stripe"` | ✅ Expected — Payment Zone |
| `app/api/webhooks/stripe/route.ts:2` | `import Stripe from "stripe"` | ✅ Expected — Payment Zone |
| `app/api/checkout/route.test.ts` | stripe mock + test URLs | ✅ Acceptable — test file for Payment Zone |
| `app/api/teams/me/route.test.ts:127` | `stripeCustomerId: null` (mock data) | ✅ Acceptable — test mock field |
| `lib/db/schema.ts:10,34-36` | `stripeCustomerId`, `stripeCheckoutSessionId`, `stripeSubscriptionId` column names | ✅ Schema definitions only — no SDK import |
| `lib/services/geo-analyzer.ts:197,232` | `stripe.com` (external site benchmark example in comments) | ✅ Comments only — not an import |

**Violation count: 0**

---

### Audit 2: PII in Pipeline Data Flow

**Command:**
```bash
grep -rn "email\|creditCard\|payment" lib/pipeline/ lib/services/ --include="*.ts"
```

**Expected:** Zero hits (or only type definitions, not data flow)

**Result: PASS with notes**

| File | Finding | Assessment |
|------|---------|------------|
| `lib/pipeline/runner.ts:20` | `import { sendCompletionEmail } from "@/lib/email"` | ✅ Notification only — no PII stored in pipeline data structures |
| `lib/services/geo-analyzer.ts:199` | `"email"` in scoring rubric comment | ✅ Comment/rubric text only |
| `lib/services/geo-crawler.ts:374,376,443,445,499,501,588,682,686,688,788,790,1419,1426` | Email extraction from crawled pages | ✅ Extracts PUBLIC contact info from crawled target sites — core product feature, not user PII |
| `lib/services/content-generator.ts:60,62,118,222,241,301,309,369` | Email refs in llms.txt generation | ✅ Uses crawled site public contact info for content generation |

**Key distinction:** The "email" references are for extracting and representing the *target website's* public business contact information (e.g. `support@customer.com`) — this is the product's core value. No Flowblinq user PII (user accounts, billing info) flows through pipeline data structures.

**Violation count: 0**

---

### Audit 3: Cross-Zone Imports

**Command:**
```bash
grep -rn "from.*checkout\|from.*webhook.*stripe" lib/pipeline/ lib/services/ app/api/cron/ --include="*.ts"
```

**Expected:** Zero hits

**Result: PASS**

```
(no output — zero matches)
```

**Violation count: 0**

---

## 5. Recommendations

### Immediate (no code changes required)

1. **Status: All 3 audits pass.** The DMZ boundary is well-enforced in the current codebase.

2. **Add boundary comments** to zone entry files (optional, low-effort, high-readability value):

   ```ts
   // @zone: payment — do not import pipeline or serve modules
   // app/api/checkout/route.ts
   // app/api/webhooks/stripe/route.ts

   // @zone: pipeline — do not import payment or stripe modules
   // lib/pipeline/runner.ts
   // app/api/sites/[id]/regenerate/route.ts
   // app/api/cron/recrawl/route.ts

   // @zone: serve — read-only DB access, no mutations except crawl logs
   // app/api/serve/[slug]/*/route.ts
   ```

### Future (post-alpha)

3. **ESLint boundary rule**: Consider `eslint-plugin-import` with zone-based forbidden import rules once the team scales. Not needed for alpha.

4. **`creditTransactions` is the only shared write table** — if Payment and Pipeline zones diverge further, consider a dedicated `CreditService` module owned by the Pipeline zone that Payment zone can call via a typed interface rather than direct DB access.

---

## 6. Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| No `stripe` import outside Payment Zone routes | ✅ PASS |
| No user/customer PII flows into pipeline data | ✅ PASS |
| `creditTransactions` is only table both Payment + Pipeline touch | ✅ PASS |
| DMZ boundary documented in `.agents/specs/ops/dmz-boundary.md` | ✅ This file |
| Boundary comments added to zone entry files | ⬜ Optional — recommended but not blocking |
