# TS-015 — AI Citation Monitoring

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#104](https://github.com/flowblinqadmin/geo/issues/104)  
> **Delivery Commit:** `n/a — pending`  

---

## What

Add an **AI Citation Monitor** feature to Flowblinq GEO that lets users check
whether their brand/domain is being cited or recommended by major AI platforms
(ChatGPT/OpenAI, Claude/Anthropic, Perplexity, Gemini/Google) when users ask
relevant queries.

The feature surfaces as a new tab — **"AI Visibility"** — on the existing site
results page (`/sites/[id]`), available after a bulk audit completes. Users
trigger a one-click citation check; results are streamed in real-time via SSE
and persisted to Supabase.

---

## Why

**Strategic gap identified in comparative analysis of FireGEO (Firecrawl FOSS):**

FireGEO's core value proposition is exactly this: it tells you whether the major
AI platforms mention your brand when answering user queries. Flowblinq's current
GEO audit tells you *how to optimize your content for AI*, but does not verify
*whether that optimization is working* — i.e., are you actually being cited?

This is the feedback loop that closes the product:
```
Audit → Fix content → Citation Monitor → Verify citations improved
```

Without this loop, users optimize in the dark. FireGEO's existence means our
segment of power users will discover this gap. We must own it.

**Why Flowblinq's version is better than FireGEO:**
- FireGEO is generic: user inputs any URL, it scrapes company info, guesses
  industry, picks generic prompts.
- Flowblinq already has: the crawl data, the 16-pillar analysis, industry
  context, the list of pages, and the recommended schema/content. We can craft
  *domain-specific, industry-aware* citation queries instead of generic prompts.
- Flowblinq's queries can include competitors the user cares about (from their
  audit data).

---

## Scope

### In Scope
1. New API endpoint: `POST /api/sites/[id]/citation-check`
2. New DB table: `citation_checks` to persist results
3. New UI tab: "AI Visibility" on the site results page
4. SSE streaming for real-time progress
5. Credit system integration: 5 credits per citation check

### Out of Scope (future iterations)
- Scheduled/recurring citation checks (cron-based monitoring)
- Email alerts when citations change
- Historical trend charts (needs recurring checks first)
- Per-page citation tracking (aggregate domain only in v1)

---

## Dependencies

### Must Exist
- `geoSites` table (exists) — for site/domain context
- Team credit system (exists) — for credit deduction
- Site auth via `accessToken` (exists) — to gate the endpoint

### New Dependencies (API keys required)
- `OPENAI_API_KEY` — GPT-4o queries
- `ANTHROPIC_API_KEY` — Claude queries
- `PERPLEXITY_API_KEY` — Perplexity queries (has built-in web search; best for
  real-world citation detection)
- `GOOGLE_GENERATIVE_AI_API_KEY` — Gemini (optional, lower priority)

These keys are NOT currently in the Flowblinq geo `.env`. Must be provisioned.

---

## Data Model

### New Table: `citation_checks`

```sql
CREATE TABLE citation_checks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     UUID NOT NULL REFERENCES geo_sites(id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL,
  domain      TEXT NOT NULL,

  -- Queries sent to LLMs
  prompts     JSONB NOT NULL,   -- string[]

  -- Raw LLM responses
  responses   JSONB NOT NULL,   -- CitationResponse[]

  -- Aggregated scores
  scores      JSONB NOT NULL,   -- CitationScores

  -- Per-provider breakdown
  provider_results  JSONB NOT NULL,  -- ProviderResult[]

  credits_used  INTEGER NOT NULL DEFAULT 5,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON citation_checks (site_id);
CREATE INDEX ON citation_checks (team_id);
```

### Types

```typescript
interface CitationResponse {
  provider:        "openai" | "anthropic" | "perplexity" | "google";
  prompt:          string;
  rawText:         string;         // full LLM response text
  mentioned:       boolean;        // was the domain/brand mentioned?
  position:        number | null;  // 1-indexed position in response, null if not mentioned
  sentiment:       "positive" | "neutral" | "negative" | null;
  competitorsMentioned: string[];  // competitors mentioned in same response
  error?:          string;
}

interface ProviderResult {
  provider:        string;
  visibilityScore: number;   // 0-100: % of queries where brand was mentioned
  avgPosition:     number | null;
  sentiment:       "positive" | "neutral" | "negative";
  mentionCount:    number;
  totalQueries:    number;
}

interface CitationScores {
  overallVisibility:    number;    // 0-100: % of all queries (all providers) mentioning brand
  bestProvider:         string;    // provider with highest visibility
  worstProvider:        string;    // provider with lowest visibility
  avgPosition:          number | null;
  sentimentScore:       number;    // -1 to 1: aggregate sentiment
  competitorVisibility: Record<string, number>;  // competitor → % visibility
}
```

---

## API Contract

### POST /api/sites/[id]/citation-check

**Auth:** Bearer token in `Authorization` header OR `token` query param
(same as download-report endpoint — uses `site.accessToken`)

**Request body:** (optional overrides)
```json
{
  "providers": ["openai", "anthropic", "perplexity"],   // optional; defaults to all configured
  "customPrompts": ["best GEO audit tools?"]            // optional; merged with auto-generated
}
```

**Response:** SSE stream (`text/event-stream`)

SSE event types (mirroring FireGEO pattern):
```
start           → { message: "Starting citation check for domain.com" }
stage           → { stage, progress, message }
prompt-generated → { prompt, index, total }
analysis-start  → { provider, prompt, promptIndex, totalPrompts }
partial-result  → { provider, prompt, mentioned, position, sentiment }
analysis-complete → { provider, prompt, status: "completed"|"failed" }
progress        → { stage, progress, message }
complete        → { scores, providerResults, responses, creditsUsed }
error           → { message }
```

**Credit deduction:**
- 5 credits deducted upfront before any queries are sent
- If balance < 5: return 402 with error JSON (not SSE)
- Credits NOT refunded on partial failure (at least some queries completed)

**Errors (non-SSE JSON):**
- 401 — missing/invalid token
- 402 — insufficient credits (need 5, have N)
- 404 — site not found
- 422 — no API keys configured for any provider
- 500 — unexpected

---

## Prompt Generation

Unlike FireGEO (which generates generic prompts), Flowblinq generates
domain-aware, industry-context prompts using data already in the GEO audit.

**Algorithm:**
1. Read `site.crawlData.domain` → the brand domain
2. Read `site.analysisData` (from the existing GEO analysis stage) to infer:
   - Industry / category
   - Top topics/keywords from the 16-pillar analysis
   - Company name (if extractable from crawled pages)
3. Generate N=4 prompts using a template set:

```typescript
const PROMPT_TEMPLATES = [
  "Best {serviceType} tools in {year}?",
  "What is {domain} and is it worth using?",
  "Top alternatives to {domain}?",
  "{domain} vs competitors — which is better?",
  "Recommended {serviceType} for enterprise?",
  "What tools do experts recommend for {serviceType}?",
];
```

Select 4 prompts. For unknown service type, fall back to domain name only.

**Why prompts matter:**
- Generic prompts ("best SEO tools?") test if you're famous
- Domain-specific prompts ("what is flowblinq.com?") test if LLMs have any
  knowledge of the brand
- Together they reveal: awareness vs familiarity vs total darkness

---

## Providers & Query Execution

### Provider Priority
1. **Perplexity** (`sonar`) — highest priority; real-time web search built in;
   most likely to reflect current citations. Use `sonar` not `sonar-pro` (cost).
2. **OpenAI** (`gpt-4o-mini`) — largest user base; most impactful to rank here.
   Mini is 10× cheaper than gpt-4o and adequate for recall/mention queries.
3. **Anthropic** (`claude-haiku-4-5-20251001`) — fastest/cheapest Claude; good for brand awareness.
4. **Google Gemini** (`gemini-2.5-flash-lite`) — native search grounding; optional if API key available.

### Execution
- Queries run in parallel batches of 3 (prompt × provider pairs)
- Each provider receives the same N=4 prompts
- Total requests: up to 4 providers × 4 prompts = 16 LLM calls
- Timeout per call: 30s
- On timeout/error: mark as failed, continue; report in final errors array

### Response Parsing
For each LLM response:
1. Check if domain name appears (case-insensitive substring match)
2. If mentioned: find first occurrence position in response → rank = ordinal
   position of brand mention relative to other entities mentioned
3. Sentiment: use keyword heuristics (positive: "recommended", "best",
   "excellent"; negative: "avoid", "poor", "expensive"); fallback: neutral
4. Extract other entities mentioned alongside the brand → competitor list

---

## UI: "AI Visibility" Tab

### Location
New tab in site results page (`geo/app/sites/[id]/page.tsx`), alongside
existing result sections. Only visible for `pipelineStatus === "complete"`.

### Tab Content (3 sections)

**1. Run Citation Check CTA** (shown before first check)
```
┌────────────────────────────────────────────────────┐
│  AI Visibility Check                              │
│  See if ChatGPT, Claude & Perplexity cite you    │
│                                                    │
│  Costs 5 credits  [Run Check]                    │
└────────────────────────────────────────────────────┘
```

**2. Live Progress** (shown during streaming)
- Progress bar per provider
- Checkmarks per prompt as they complete (matching FireGEO's UI pattern)

**3. Results** (shown after completion)

**3a. Overall Visibility Score** — large number (0-100%), similar to GEO score
```
AI Visibility: 42%
(Mentioned in 42% of all queries across all AI platforms)
```

**3b. Provider Comparison Matrix** — table:
```
              Mentioned  Avg Position  Sentiment
ChatGPT       3/4        #2            Positive
Claude        2/4        #3            Neutral
Perplexity    1/4        #5            Neutral
Gemini        0/4        —             —
```

**3c. Prompts & Responses** — expandable accordion
- Each prompt row shows: query text, which providers mentioned brand, raw response snippets

**3d. Competitor Cross-Reference** — which competitors were mentioned alongside you

### Persistence
- Most recent citation_check for the site is loaded on page load
- "Run New Check" button to re-run (costs 5 credits each time)
- Show timestamp of last check

---

## Acceptance Criteria

1. **Credit gate**: Users with < 5 credits cannot trigger a check; clear error shown
2. **SSE streaming**: Provider results appear in real-time as they complete
3. **All 3+ providers queried**: At minimum Perplexity + OpenAI (Claude optional
   pending API key provision)
4. **Results persisted**: `citation_checks` row created; survives page refresh
5. **Competitor mentions extracted**: At least 3 well-known competitors detected
   in responses when the brand is mentioned alongside them
6. **Score accuracy**: `overallVisibility` correctly reflects % of (prompt, provider)
   pairs where brand was mentioned
7. **Error resilience**: If 1 provider fails, others continue; partial results shown
8. **Zero pipeline interference**: Citation check is fully independent — does not
   touch `geoSites.pipelineStatus` or trigger any QStash messages

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| LLM API keys not provisioned | P0 | Add to .env before implementation; failover to "no providers configured" error |
| Rate limits on 16 parallel LLM calls | P1 | Batch size 3; add 500ms delay between batches if needed |
| Hallucinated responses: LLM claims to mention brand but doesn't | P2 | String-match validation for `mentioned=true` |
| Cold domain: LLM has no knowledge of brand → all 0% | P3 | Not a bug; the accurate result is 0%; document in UI as "No AI coverage yet" |
| Vercel function timeout (16 LLM calls) | P1 | `maxDuration = 120` on the endpoint; Perplexity has 30s timeout per call |
| DB migration needed | P0 | Needs `citation_checks` table; add to migration #101 |

---

## Open Questions

1. **Which API keys does Flowblinq have?** Need to check with Adithya Rao.
   Priority order: Perplexity > OpenAI > Anthropic > Google.
2. **Credit cost**: 5 credits = 1 page-equivalent. Reasonable? Could be 10 if
   4 providers × 4 prompts = 16 calls feels expensive.
3. **Prompt customization**: Should users be able to edit the auto-generated
   prompts before running? (Like FireGEO). Defer to v2 unless trivial.
4. **Single-audit support**: Should this work for single-page audits too, not
   just bulk? Defer to v2; start with bulk (where team/credits are more likely).

---

## Implementation Notes for SpecMaster

> **Updated 2026-03-02 after cross-repo audit (#32).** Primary references are now
> `apiaudit` and `flowblinq_fullrepo` — on our stack. FireGEO remains a secondary
> reference for the SSE streaming pattern only.

### Primary References (use these)

**1. Multi-LLM query executor:**
`/home/aditya/flowblinq_stage/apiaudit/lib/services/sov-checker.ts`
- `checkSingleQuery(query, brand, providers)` → per-(prompt, provider) execution
- `computeSovSummary(results)` → `CitationScores.overallVisibility` calculation
- Regex-based mention detection with context window extraction
- 500ms delay between batches (built-in rate limit respect)

**2. Domain-aware prompt generation (replaces static PROMPT_TEMPLATES):**
`/home/aditya/flowblinq_stage/apiaudit/lib/services/intelligence-gatherer.ts`
- Phase 1: Perplexity crawls the domain → returns brandName, vertical, competitors, targetCustomer
- Phase 2: GPT-4o-mini generates 8 grounded queries from crawl data
- Much better than static templates — queries are specific to the actual site content
- `detectRegionFromUrl()` adds geographic context (32 TLD → region mappings)

**3. Full orchestration pattern:**
`/home/aditya/flowblinq_stage/flowblinq_fullrepo/brands-api/src/services/ai-visibility-engine.ts`
- `onProgress?: (progress: number) => Promise<void>` callback → maps to SSE events
- Shows how to wire query generation → LLM dispatch → scoring → DB storage end-to-end

**4. LLM client abstraction:**
`/home/aditya/flowblinq_stage/flowblinq_fullrepo/brands-api/src/services/llm-clients/index.ts`
- `queryAllClients(prompt)` → parallel dispatch, per-provider fault isolation
- Individual provider files: openai.ts, anthropic.ts, perplexity.ts, gemini.ts

**5. Category query templates:**
`/home/aditya/flowblinq_stage/flowblinq_fullrepo/brands-api/src/services/query-generator.ts`
- Category-specific templates (automotive, beauty, electronics, food, fashion, health, etc.)
- Extend with GEO/SEO service category for flowblinq's domain

### Model Selection (updated)

Use **cheaper models** — 16 LLM calls per check makes cost material:
| Provider | Model | Reason |
|----------|-------|--------|
| Perplexity | `sonar` (not sonar-pro) | Built-in web search; sonar is sufficient |
| OpenAI | `gpt-4o-mini` | 10× cheaper than gpt-4o; adequate for mention detection |
| Anthropic | `claude-haiku-4-5-20251001` | Fastest/cheapest Claude; adequate for recall queries |
| Google | `gemini-2.5-flash-lite` | Native search grounding; cheapest Gemini |

### DB Schema Revision

Consider splitting `citation_checks` into two tables (matching flowblinq_fullrepo pattern):
```sql
-- Instead of one wide JSONB table:
citation_check_responses (
  id UUID PK, check_id UUID FK,
  provider TEXT, model TEXT, query TEXT,
  response TEXT, response_time_ms INT, citations JSONB,
  mentioned BOOLEAN, position INT, sentiment TEXT,
  competitors_mentioned JSONB
)
citation_check_scores (
  check_id UUID PK, site_id UUID FK,
  mention_rate NUMERIC, avg_position NUMERIC,
  sentiment_score NUMERIC, overall_visibility NUMERIC,
  best_provider TEXT, worst_provider TEXT,
  competitor_visibility JSONB
)
```
This matches `auditLlmResponses` + `auditScores` in flowblinq_fullrepo and is easier
to query for per-provider breakdowns.

### Secondary Reference (SSE streaming pattern only)

FireGEO at `/home/aditya/flowblinq/.agents/references/firegeo/`:
- `app/api/brand-monitor/analyze/route.ts` → SSE `text/event-stream` response pattern
- `components/brand-monitor/brand-monitor.tsx` → UI `useReducer` state machine for live results
- Do NOT use FireGEO's credit system (Autumn) or auth (better-auth)
- Do NOT use FireGEO's premium model choices (too expensive at 16 calls/check)

### What NOT to copy

- FireGEO's credit system → use Flowblinq's existing `deductCredits()`
- FireGEO's auth → use Flowblinq's existing `site.accessToken` pattern
- apiaudit's in-memory rate limiter → same bug as #101; use DB-backed counter
- flowblinq_fullrepo's full checkout/payment system → not relevant for TS-015

---

_TS-015 | Author: CoFounder | Date: 2026-03-02 (updated after #32 audit) | Priority: P1_
