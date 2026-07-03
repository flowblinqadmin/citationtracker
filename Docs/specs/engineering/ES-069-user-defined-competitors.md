# ES-069 — User-Defined Competitors

**Source:** TS-069-user-defined-competitors.md
**Status:** Ready for review
**Agent:** DaVinci (Agent 10) — API + frontend + migration

---

## a) Overview

**What:** Let customers add/remove their own competitors. User-added competitors take priority over LLM-discovered ones. Deleted competitors are blocklisted to prevent re-discovery. Citation check SOV uses the merged list.

**Current state:**
- `geo_sites.discoveredCompetitors` (`jsonb`, line 192, `schema.ts`) stores `DiscoveredCompetitor[]` — LLM-discovered via `discoverCompetitors()` in `competitor-discovery.ts`.
- `POST /api/sites/[id]/competitor-discovery/route.ts` runs discovery, persists to `discoveredCompetitors`, costs 2 credits.
- `citation-checker.ts` line 185: `runCitationCheck()` accepts optional `discoveredCompetitors` param. Lines 474–526: builds `competitorData: CompetitorCitationData[]` SOV from this list.
- `citation-check/route.ts` line 230: reads `site.discoveredCompetitors` and passes to `runCitationCheck()`.
- `SitePageClient.tsx` line 121: `discoveredCompetitors` state. Line 285: `handleMapCompetitors()`. Lines 949–965: competitor pills bar (read-only, no delete). Lines 742–759: "Map Competitors" action rail button.
- `geo_site_view` table (`schema.ts:248`) has `discoveredCompetitors` column. Trigger `sync_geo_site_view()` (`002-geo-site-view-trigger.sql`) copies `NEW.discovered_competitors` on every `geo_sites` write.
- `DiscoveredCompetitor` type (`citation.ts:14`): `{ name, domain?, rank, mentions, category: "direct"|"adjacent" }`.
- No `userCompetitors`, `competitorBlocklist` columns exist yet.

---

## b) Implementation Requirements

### Deliverable 1 — DDL Migration

**Create:** `geo/lib/db/migrations/20260328-user-competitors.sql`

```sql
-- Add user-defined competitor columns to geo_sites
ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS user_competitors jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS competitor_blocklist jsonb DEFAULT '[]';

-- Add to geo_site_view
ALTER TABLE geo_site_view
  ADD COLUMN IF NOT EXISTS user_competitors jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS competitor_blocklist jsonb DEFAULT '[]';
```

**Modify:** `geo/migrations/002-geo-site-view-trigger.sql` — re-run `CREATE OR REPLACE FUNCTION sync_geo_site_view()` to include the two new columns in the INSERT column list, VALUES list, and ON CONFLICT UPDATE SET clause.

Since the trigger is `CREATE OR REPLACE`, the migration just needs to re-execute the full function definition with the new columns added. Create a companion migration:

**Create:** `geo/lib/db/migrations/20260328-user-competitors-trigger.sql`

```sql
-- Update sync trigger to propagate user_competitors and competitor_blocklist
CREATE OR REPLACE FUNCTION sync_geo_site_view() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO geo_site_view (
    site_id, domain, slug, team_id, access_token,
    pipeline_status, pipeline_error,
    overall_score, previous_score, projected_score, projected_boost, baseline_score,
    pillars, page_count, crawl_count, manual_runs_month,
    executive_summary, ranked_recommendations, change_log,
    per_page_results, per_page_fixes, implementation_status,
    generated_llms_txt, generated_llms_full_txt, generated_business_json, generated_schema_blocks,
    discovery_data, platform_detected, share_token, domain_verified, verify_token,
    citation_narrative, discovered_competitors, brand_keywords, extracted_categories,
    baseline_scorecard, last_crawl_at, next_crawl_at, created_at, updated_at,
    user_competitors, competitor_blocklist
  ) VALUES (
    NEW.id, NEW.domain, NEW.slug, NEW.team_id, NEW.access_token,
    NEW.pipeline_status, NEW.pipeline_error,
    (NEW.geo_scorecard->>'overallScore')::numeric::int,
    (NEW.previous_run_snapshot->'geoScorecard'->>'overallScore')::numeric::int,
    (NEW.recommendations->>'projectedScore')::numeric::int,
    (NEW.recommendations->>'projectedBoost')::numeric::int,
    (NEW.baseline_scorecard->>'overallScore')::numeric::int,
    NEW.geo_scorecard->'pillars',
    coalesce(jsonb_array_length(NEW.crawl_data->'pages'), 0),
    NEW.crawl_count, NEW.manual_runs_this_month,
    NEW.executive_summary,
    NEW.recommendations->'rankedRecommendations',
    NEW.change_log,
    NEW.per_page_results, NEW.per_page_fixes, NEW.implementation_status,
    NEW.generated_llms_txt, NEW.generated_llms_full_txt, NEW.generated_business_json, NEW.generated_schema_blocks,
    NEW.discovery_data, NEW.platform_detected, NEW.share_token,
    coalesce(NEW.domain_verified, false), NEW.verify_token,
    NEW.citation_narrative, NEW.discovered_competitors, NEW.brand_keywords, NEW.extracted_categories,
    NEW.baseline_scorecard, NEW.last_crawl_at, NEW.next_crawl_at, NEW.created_at, NOW(),
    NEW.user_competitors, NEW.competitor_blocklist
  )
  ON CONFLICT (site_id) DO UPDATE SET
    domain = EXCLUDED.domain,
    slug = EXCLUDED.slug,
    team_id = EXCLUDED.team_id,
    access_token = EXCLUDED.access_token,
    pipeline_status = EXCLUDED.pipeline_status,
    pipeline_error = EXCLUDED.pipeline_error,
    overall_score = EXCLUDED.overall_score,
    previous_score = EXCLUDED.previous_score,
    projected_score = EXCLUDED.projected_score,
    projected_boost = EXCLUDED.projected_boost,
    baseline_score = EXCLUDED.baseline_score,
    pillars = EXCLUDED.pillars,
    page_count = EXCLUDED.page_count,
    crawl_count = EXCLUDED.crawl_count,
    manual_runs_month = EXCLUDED.manual_runs_month,
    executive_summary = EXCLUDED.executive_summary,
    ranked_recommendations = EXCLUDED.ranked_recommendations,
    change_log = EXCLUDED.change_log,
    per_page_results = EXCLUDED.per_page_results,
    per_page_fixes = EXCLUDED.per_page_fixes,
    implementation_status = EXCLUDED.implementation_status,
    generated_llms_txt = EXCLUDED.generated_llms_txt,
    generated_llms_full_txt = EXCLUDED.generated_llms_full_txt,
    generated_business_json = EXCLUDED.generated_business_json,
    generated_schema_blocks = EXCLUDED.generated_schema_blocks,
    discovery_data = EXCLUDED.discovery_data,
    platform_detected = EXCLUDED.platform_detected,
    share_token = EXCLUDED.share_token,
    domain_verified = EXCLUDED.domain_verified,
    verify_token = EXCLUDED.verify_token,
    citation_narrative = EXCLUDED.citation_narrative,
    discovered_competitors = EXCLUDED.discovered_competitors,
    brand_keywords = EXCLUDED.brand_keywords,
    extracted_categories = EXCLUDED.extracted_categories,
    baseline_scorecard = EXCLUDED.baseline_scorecard,
    last_crawl_at = EXCLUDED.last_crawl_at,
    next_crawl_at = EXCLUDED.next_crawl_at,
    user_competitors = EXCLUDED.user_competitors,
    competitor_blocklist = EXCLUDED.competitor_blocklist,
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

---

### Deliverable 2 — Drizzle Schema Update

**Modify:** `geo/lib/db/schema.ts`

Add to `geoSites` table (after `discoveredCompetitors` at line 192):
```typescript
userCompetitors: jsonb("user_competitors").$type<UserCompetitor[]>().default([]),
competitorBlocklist: jsonb("competitor_blocklist").$type<string[]>().default([]),
```

Add to `geoSiteView` table (after `discoveredCompetitors` at line 248):
```typescript
userCompetitors: jsonb("user_competitors"),
competitorBlocklist: jsonb("competitor_blocklist"),
```

**Add type to:** `geo/lib/types/citation.ts`

```typescript
export interface UserCompetitor {
  name: string;
  domain?: string;
  addedAt: string; // ISO 8601
}
```

---

### Deliverable 3 — New API: `POST /api/sites/[id]/competitors`

**Create:** `geo/app/api/sites/[id]/competitors/route.ts`

**Auth:** Same pattern as `competitor-discovery/route.ts` — Bearer token or `?token=` query param, matched against `site.accessToken`.

**No credit cost** — adding/removing user competitors is free.

**Request body:**
```typescript
type CompetitorAction =
  | { action: "add"; name: string; domain?: string }
  | { action: "remove"; name: string };
```

**Logic:**

**Add flow:**
1. Validate `name` — non-empty, trimmed, max 100 chars.
2. Read `site.userCompetitors`, `site.discoveredCompetitors`, `site.competitorBlocklist`.
3. Compute effective list: `[...userCompetitors, ...discoveredCompetitors]`.
4. If effective list length >= 6 → return 400 `{ error: "Maximum 6 competitors" }`.
5. If name already exists in effective list (case-insensitive match on `.name`) → return 409 `{ error: "Competitor already exists" }`.
6. Remove name from `competitorBlocklist` if present (re-adding an unblocked competitor).
7. Append `{ name: name.trim(), domain: domain?.trim(), addedAt: new Date().toISOString() }` to `userCompetitors`.
8. Persist: `db.update(geoSites).set({ userCompetitors, competitorBlocklist }).where(eq(geoSites.id, siteId))`.

**Remove flow:**
1. Find in `userCompetitors` by case-insensitive name match → remove from array.
2. If not in `userCompetitors`, find in `discoveredCompetitors` by case-insensitive name match → remove from array.
3. Add `name.toLowerCase()` to `competitorBlocklist` (deduped). Cap blocklist at 20 entries (FIFO — shift oldest if at cap).
4. Persist: `db.update(geoSites).set({ userCompetitors, discoveredCompetitors, competitorBlocklist }).where(eq(geoSites.id, siteId))`.

**Response (both actions):**
```json
{
  "userCompetitors": [...],
  "discoveredCompetitors": [...],
  "blocklist": [...],
  "totalCount": 5,
  "slotsRemaining": 1
}
```

---

### Deliverable 4 — Modified: Competitor Discovery

**Modify:** `geo/app/api/sites/[id]/competitor-discovery/route.ts`

After reading `site` (line 24), add:

```typescript
const userCompetitors = (site.userCompetitors ?? []) as UserCompetitor[];
const existingDiscovered = (site.discoveredCompetitors ?? []) as DiscoveredCompetitor[];
const blocklist = (site.competitorBlocklist ?? []) as string[];
const effectiveCount = userCompetitors.length + existingDiscovered.length;
const slotsAvailable = Math.max(0, 6 - effectiveCount);

if (slotsAvailable <= 0) {
  return NextResponse.json({
    error: "No discovery slots available",
    totalCount: effectiveCount,
    slotsRemaining: 0,
  }, { status: 400 });
}
```

**Modify:** `discoverCompetitors()` in `competitor-discovery.ts`

Add new parameter to function signature:
```typescript
export async function discoverCompetitors(
  site: Pick<GeoSite, "domain" | "siteType" | "executiveSummary" | "crawlData">,
  callbacks: DiscoveryCallbacks,
  options?: { excludeNames?: string[]; maxResults?: number },
): Promise<DiscoveredCompetitor[]>
```

- Pass `excludeNames = [...blocklist, ...userCompetitors.map(c => c.name.toLowerCase()), ...existingDiscovered.map(c => c.name.toLowerCase())]` and `maxResults = slotsAvailable` from the route.
- In `buildDiscoveryPrompts()`: append to system prompt: `"Do NOT include these companies: ${excludeNames.join(', ')}"`.
- In `extractCompetitorsFromJson()`: filter results — remove any whose name matches `excludeNames` (case-insensitive). Slice to `maxResults`.

**Modify persistence** (route.ts line 88–91): **Append** to existing `discoveredCompetitors` instead of overwriting:

```typescript
const updated = [...existingDiscovered, ...competitors].slice(0, 6 - userCompetitors.length);
await db.update(geoSites).set({ discoveredCompetitors: updated }).where(eq(geoSites.id, siteId));
```

Send updated effective count in SSE complete event:
```typescript
send({ type: "complete", competitors: updated, creditsUsed: DISCOVERY_COST, slotsRemaining: 6 - userCompetitors.length - updated.length });
```

---

### Deliverable 5 — Modified: Citation Check SOV

**Modify:** `geo/app/api/sites/[id]/citation-check/route.ts`

Line 230 — read both competitor lists:
```typescript
const discoveredCompetitors = (site.discoveredCompetitors ?? []) as DiscoveredCompetitor[];
const userCompetitors = (site.userCompetitors ?? []) as UserCompetitor[];

// Merge: user competitors first, then discovered
const allCompetitors: DiscoveredCompetitor[] = [
  ...userCompetitors.map(c => ({
    name: c.name,
    domain: c.domain,
    rank: 0,
    mentions: 0,
    category: "direct" as const,
  })),
  ...discoveredCompetitors,
];
```

Pass `allCompetitors` to `runCitationCheck()` at line 241 instead of `discoveredCompetitors`.

**No changes to `citation-checker.ts` internals** — it already treats `discoveredCompetitors` param as a generic competitor list for SOV computation (lines 474–526). The merge happens at the call site.

---

### Deliverable 6 — UI: Competitor Pills + Add Input + Action Rail

**Modify:** `geo/app/sites/[id]/SitePageClient.tsx`

#### 6a. State additions

```typescript
const [userCompetitors, setUserCompetitors] = useState<UserCompetitor[]>(
  (initialSite.userCompetitors as UserCompetitor[] | null) ?? []
);
const [competitorBlocklist, setCompetitorBlocklist] = useState<string[]>(
  (initialSite.competitorBlocklist as string[] | null) ?? []
);
const [addCompetitorName, setAddCompetitorName] = useState("");
const [addCompetitorDomain, setAddCompetitorDomain] = useState("");
const [addCompetitorLoading, setAddCompetitorLoading] = useState(false);
const [addCompetitorError, setAddCompetitorError] = useState<string | null>(null);
```

Derive effective list:
```typescript
const effectiveCompetitors = [
  ...userCompetitors.map(c => ({ ...c, source: "user" as const })),
  ...discoveredCompetitors.map(c => ({ ...c, source: "discovered" as const })),
];
const slotsRemaining = Math.max(0, 6 - effectiveCompetitors.length);
```

#### 6b. Add competitor handler

```typescript
async function handleAddCompetitor() {
  const name = addCompetitorName.trim();
  if (!name || addCompetitorLoading) return;
  setAddCompetitorLoading(true);
  setAddCompetitorError(null);
  try {
    const res = await fetch(`/api/sites/${siteId}/competitors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "add", name, domain: addCompetitorDomain.trim() || undefined }),
    });
    const data = await res.json();
    if (!res.ok) { setAddCompetitorError(data.error); return; }
    setUserCompetitors(data.userCompetitors);
    setDiscoveredCompetitors(data.discoveredCompetitors);
    setCompetitorBlocklist(data.blocklist);
    setAddCompetitorName("");
    setAddCompetitorDomain("");
  } catch { setAddCompetitorError("Network error"); }
  finally { setAddCompetitorLoading(false); }
}
```

#### 6c. Remove competitor handler

```typescript
async function handleRemoveCompetitor(name: string) {
  try {
    const res = await fetch(`/api/sites/${siteId}/competitors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "remove", name }),
    });
    const data = await res.json();
    if (res.ok) {
      setUserCompetitors(data.userCompetitors);
      setDiscoveredCompetitors(data.discoveredCompetitors);
      setCompetitorBlocklist(data.blocklist);
    }
  } catch { /* ignore */ }
}
```

#### 6d. Competitor pills row (replace lines 949–965)

Replace the existing read-only competitor bar with:

1. **Pills row** — horizontal scroll, each pill shows:
   - Colored dot: copper (`#c2652a`) for user, gray (`#a3a3a3`) for discovered
   - Competitor name
   - `×` delete button (calls `handleRemoveCompetitor`)
2. **Add input** — inline below pills, shown when `slotsRemaining > 0`:
   - Text input (name), optional domain input (collapsed, expand via "+" icon)
   - "Add" button
   - Error message display
3. **Disabled state** — if `slotsRemaining === 0`, input hidden, show "6/6 — slots full"

#### 6e. Action rail — Map Competitors button (lines 742–759)

- Add slot count badge: `{slotsRemaining}/6` next to the "2cr" badge
- If `slotsRemaining === 0`: disabled with tooltip "Competitor slots full"
- Update `handleMapCompetitors` SSE handler to read `slotsRemaining` from complete event and update state

#### 6f. SiteData type extension

**Modify:** `geo/app/sites/[id]/types.ts` — add to `SiteDataExtended`:
```typescript
userCompetitors?: UserCompetitor[];
competitorBlocklist?: string[];
```

**Modify:** `geo/app/sites/[id]/page.tsx` — include `userCompetitors` and `competitorBlocklist` in the site data query.

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/unit/competitors-api.test.ts`

| # | Test case | Input | Expected |
|---|-----------|-------|----------|
| U1 | Add competitor — success | `{ action: "add", name: "Apollo" }` with 3 existing | 200, userCompetitors has 4th entry |
| U2 | Add with domain | `{ action: "add", name: "Apollo", domain: "apollo.io" }` | 200, entry has domain field |
| U3 | Add duplicate (case-insensitive) | "apollo" exists, add "Apollo" | 409, "Competitor already exists" |
| U4 | Add when 6 already exist | 6 effective competitors | 400, "Maximum 6 competitors" |
| U5 | Add empty name | `{ action: "add", name: "  " }` | 400, validation error |
| U6 | Add name > 100 chars | 101-char string | 400, validation error |
| U7 | Add re-enables blocked name | "apollo" in blocklist, add "Apollo" | blocklist no longer contains "apollo" |
| U8 | Remove user competitor | "Apollo" in userCompetitors | Removed from list, added to blocklist |
| U9 | Remove discovered competitor | "TikTok" in discoveredCompetitors | Removed from list, added to blocklist |
| U10 | Remove nonexistent | "Nonexistent" | 200, no-op (idempotent) |
| U11 | Blocklist FIFO cap at 20 | 20 entries in blocklist, remove another | Oldest entry dropped, new one added |
| U12 | Blocklist dedup | "apollo" already in blocklist, remove "Apollo" again | Blocklist still has one "apollo" |
| U13 | Unauthorized — no token | Missing auth header | 401 |
| U14 | Unauthorized — wrong token | Mismatched token | 401 |
| U15 | Site not found | Invalid siteId | 404 |

**Test file:** `geo/__tests__/unit/competitor-discovery-slots.test.ts`

| # | Test case | Input | Expected |
|---|-----------|-------|----------|
| U16 | Discovery with 4 user competitors | 4 user + 0 discovered | Discovers max 2, appends |
| U17 | Discovery with 6 total | 3 user + 3 discovered | Returns 400, "No discovery slots" |
| U18 | Discovery respects blocklist | blocklist = ["apollo"] | "Apollo" not in results |
| U19 | Discovery respects existing names | user = ["TikTok"] | "TikTok" not in results |
| U20 | Discovery appends, not overwrites | 2 existing discovered | Result = existing + new (up to cap) |
| U21 | excludeNames passed to prompt | blocklist + existing names | System prompt includes exclusion |

**Test file:** `geo/__tests__/unit/citation-check-merge.test.ts`

| # | Test case | Input | Expected |
|---|-----------|-------|----------|
| U22 | Merged competitors passed to runCitationCheck | 2 user + 3 discovered | `allCompetitors` has 5 entries, user first |
| U23 | User competitors have category "direct" | user competitor mapped | `category: "direct"` |
| U24 | SOV includes user competitors | user competitor mentioned in responses | SOV > 0 in competitorData |
| U25 | Empty user competitors — no regression | 0 user + 4 discovered | Same behavior as before |

**Test file:** `geo/__tests__/unit/competitor-ui.test.tsx`

| # | Test case | Expected |
|---|-----------|----------|
| U26 | Renders user competitor pill with copper dot | Copper dot visible |
| U27 | Renders discovered competitor pill with gray dot | Gray dot visible |
| U28 | Delete button on pill calls handleRemoveCompetitor | API called with remove action |
| U29 | Add input submits new competitor | API called with add action |
| U30 | Add input disabled at 6 competitors | Input hidden, "slots full" shown |
| U31 | Map Competitors disabled at 6 | Button disabled, tooltip "Competitor slots full" |
| U32 | Slot count badge shows remaining | "3/6" displayed next to button |
| U33 | Error message displayed on add failure | "Maximum 6 competitors" shown |
| U34 | Add input clears after success | Name and domain inputs empty |

**Total unit tests: 34**

---

## d) Integration Test Plan

**Test file:** `geo/__tests__/integration/user-competitors.test.ts`

| # | Test case | Scenario |
|---|-----------|----------|
| IT1 | Full lifecycle: add 3, remove 1, re-discover | Add → remove → blocklist verified → discovery skips blocked |
| IT2 | Add competitor persists across page reload | Add via API → re-read site → userCompetitors present |
| IT3 | Citation check uses merged list | Add user competitor → run citation check → SOV includes user competitor |
| IT4 | Discovery respects slots and blocklist | Add 4 users → discovery finds max 2, skips blocked names |
| IT5 | Blocklist prevents re-discovery | Remove "Apollo" → run discovery → "Apollo" never appears |
| IT6 | geo_site_view sync includes new columns | Add user competitor → trigger fires → view has updated data |
| IT7 | Concurrent add/remove doesn't corrupt | Two simultaneous adds → both succeed, no duplicates |
| IT8 | Migration idempotent | Run DDL twice → no errors (IF NOT EXISTS) |
| IT9 | Existing sites work without migration | Site with null userCompetitors → default [] |
| IT10 | Remove discovered + re-add as user | Remove discovered → add same name → appears as user competitor |

**Total integration tests: 10**

---

## e) Profiling Requirements

| Metric | Measurement | Baseline |
|--------|-------------|----------|
| Add/remove competitor API latency | Time from request to response | < 200ms (single DB update) |
| Discovery with slot filtering | Additional overhead vs current | < 50ms (in-memory filter) |
| Citation check merge overhead | allCompetitors construction | < 1ms (array concat) |
| Competitor pills render (6 pills) | Time to interactive | < 50ms |

---

## f) Load Test Plan

| Scenario | Concurrency | Duration | Success criteria |
|----------|-------------|----------|------------------|
| Rapid add/remove | 10 concurrent per site | 30s | No data corruption, no duplicate entries |
| Discovery with slot filter | 5 concurrent | 60s | Correct slot enforcement, no over-discovery |
| Citation check with merged competitors | 10 concurrent | 60s | No regression on citation check latency |

---

## g) Logging & Instrumentation

| Event | Log level | Fields |
|-------|-----------|--------|
| `competitor_added` | INFO | `siteId`, `name`, `domain`, `totalCount`, `slotsRemaining` |
| `competitor_removed` | INFO | `siteId`, `name`, `addedToBlocklist: true` |
| `competitor_add_rejected` | WARN | `siteId`, `name`, `reason` (duplicate/max/invalid) |
| `discovery_slots_full` | INFO | `siteId`, `userCount`, `discoveredCount` |
| `discovery_filtered` | INFO | `siteId`, `rawCount`, `filteredCount`, `excludedNames` |

**Metrics:**
- `competitor_actions_total` — counter, labels: `action` (add/remove), `source` (user/discovered)
- `effective_competitor_count` — gauge per site (for monitoring slot usage)

---

## h) Acceptance Criteria

| # | Criterion | Deliverable |
|---|-----------|-------------|
| AC1 | `user_competitors` and `competitor_blocklist` JSONB columns added to `geo_sites` with default `[]` | D1 |
| AC2 | `geo_site_view` has both new columns, trigger syncs them | D1 |
| AC3 | Migration is idempotent (`IF NOT EXISTS`) | D1 |
| AC4 | Drizzle schema has `userCompetitors` and `competitorBlocklist` with correct types | D2 |
| AC5 | `UserCompetitor` interface exported from `citation.ts` | D2 |
| AC6 | `POST /api/sites/[id]/competitors` — add action persists competitor | D3 |
| AC7 | `POST /api/sites/[id]/competitors` — remove action removes and blocklists | D3 |
| AC8 | Max 6 total competitors enforced (add returns 400 at cap) | D3 |
| AC9 | Duplicate detection is case-insensitive | D3 |
| AC10 | Blocklist capped at 20 entries (FIFO) | D3 |
| AC11 | Re-adding a blocked name removes it from blocklist | D3 |
| AC12 | Remove from `discoveredCompetitors` works (not just user) | D3 |
| AC13 | Discovery calculates `slotsAvailable = 6 - effective` | D4 |
| AC14 | Discovery returns 400 if no slots available | D4 |
| AC15 | Discovery prompt includes exclusion list (blocklist + existing names) | D4 |
| AC16 | Discovery appends to `discoveredCompetitors` (not overwrite) | D4 |
| AC17 | Discovery results filtered against blocklist and existing names | D4 |
| AC18 | Citation check merges `userCompetitors + discoveredCompetitors` for SOV | D5 |
| AC19 | User competitors mapped with `category: "direct"` | D5 |
| AC20 | Competitor pills show source indicator (copper=user, gray=discovered) | D6 |
| AC21 | `×` button on pill removes competitor and adds to blocklist | D6 |
| AC22 | Add input with name field (domain optional) | D6 |
| AC23 | Add input disabled/hidden when 6 competitors exist | D6 |
| AC24 | Map Competitors button shows slot count badge and disables at 0 | D6 |
| AC25 | Error message shown for duplicate/max/validation failures | D6 |
| AC26 | Deleting all competitors + Map Competitors re-discovers up to 6 minus blocklist | D3+D4 |
| AC27 | 34 unit tests pass | UT |
| AC28 | 10 integration tests pass | IT |

**Files to create:**
1. `geo/lib/db/migrations/20260328-user-competitors.sql`
2. `geo/lib/db/migrations/20260328-user-competitors-trigger.sql`
3. `geo/app/api/sites/[id]/competitors/route.ts`

**Files to modify:**
4. `geo/lib/db/schema.ts` (2 columns on geoSites, 2 on geoSiteView)
5. `geo/lib/types/citation.ts` (add `UserCompetitor` interface)
6. `geo/app/api/sites/[id]/competitor-discovery/route.ts` (slot calc, append logic)
7. `geo/lib/services/competitor-discovery.ts` (excludeNames param, prompt exclusion, filter results)
8. `geo/app/api/sites/[id]/citation-check/route.ts` (merge user + discovered before passing to runCitationCheck)
9. `geo/app/sites/[id]/SitePageClient.tsx` (pills, add input, delete, action rail slot badge)
10. `geo/app/sites/[id]/types.ts` (add userCompetitors, competitorBlocklist to SiteDataExtended)
11. `geo/app/sites/[id]/page.tsx` (include new columns in site query)

---

## ScriptDev Notes

1. **No credit cost for add/remove.** Only Map Competitors (discovery) costs 2 credits.
2. The `competitors/route.ts` API does a single `db.update` call. No need for transactions — JSONB column updates are atomic in Postgres.
3. When removing a discovered competitor, also update `discoveredCompetitors` in the same `db.update` call (not just blocklist).
4. The `handleMapCompetitors` SSE handler in SitePageClient needs to also update `userCompetitors` state if the complete event changes the effective list. Read `slotsRemaining` from the SSE event.
5. `buildDiscoveryPrompts()` already takes `domain`, `siteType`, `executiveSummary`, `crawledDescription`. Add `excludeNames` as a 5th param and append to the system prompt. Keep it simple — `"Exclude these competitors: ${excludeNames.join(', ')}"`.
6. The `page.tsx` data query selects from `geoSiteView`. Since the trigger propagates the new columns, just add them to the select and they'll be available without changing the main pipeline.
7. For the competitor pills UI: use `flexWrap: "wrap"` not `overflow-x: scroll` — 6 pills fit on one line on desktop, wrap gracefully on mobile.
