# TS-069 — User-Defined Competitors

## What

Let customers define their own competitors via a text input on the report page. User-added competitors take priority — Map Competitors only fills remaining slots and skips blocked names.

## Why

Currently competitors are 100% LLM-discovered. The LLM often picks wrong competitors (e.g., Deloitte for a 10-person consultancy). Customers know their actual competitors. Giving them control improves citation check accuracy and SOV relevance.

## Data Model

Add two new JSONB columns to `geo_sites`:

```sql
ALTER TABLE geo_sites ADD COLUMN user_competitors jsonb DEFAULT '[]';
ALTER TABLE geo_sites ADD COLUMN competitor_blocklist jsonb DEFAULT '[]';
```

- `userCompetitors`: `Array<{ name: string; domain?: string; addedAt: string }>` — user-entered competitors
- `competitorBlocklist`: `Array<string>` — lowercase names of deleted competitors (prevents re-discovery)

The existing `discoveredCompetitors` column stays unchanged — it stores LLM-discovered competitors.

The **effective competitor list** at any point is: `userCompetitors + discoveredCompetitors` (merged, deduped by name).

## Constraints

- **Max 6 total competitors** (user + discovered combined)
- User-added competitors count first. If user has 4, Map Competitors discovers max 2.
- If user has 6, Map Competitors button is disabled with "Competitor slots full" tooltip.
- User can always add up to 6 — adding a 7th shows "Maximum 6 competitors" error.
- Deleting a competitor (user or discovered) adds its lowercase name to the blocklist.
- Map Competitors skips any name in the blocklist or already in the effective list.

## UI Changes (Report Page — SitePageClient.tsx)

### Competitor Section (Overview Tab)

Currently: SOV chart shows `competitorData` from last citation check.

New: Add above the SOV chart:

1. **Competitor pills row** — horizontal scrollable row of pills
   - Each pill shows: competitor name + colored dot (user=copper, discovered=gray) + X delete button
   - Clicking X removes from `discoveredCompetitors` or `userCompetitors` and adds name to blocklist
   - Max 6 pills visible

2. **Add competitor input** — text input + "Add" button (inline, below pills)
   - Placeholder: "Enter competitor name"
   - On submit: validate (non-empty, not duplicate, not > 6 total), POST to API, append pill
   - Disabled if 6 competitors already exist

3. **Map Competitors button** — existing button in action rail
   - Behavior change: discovers only `6 - existingCount` competitors
   - Skips names in blocklist and existing list
   - Disabled with tooltip if slots full

### Action Rail

- **Map Competitors**: show remaining slot count badge (e.g., "3/6" or "Full")
- If all 6 slots are user-defined, button shows "Full" and is disabled

## API Changes

### New: `POST /api/sites/[id]/competitors`

Add/remove user competitors.

**Request (add):**
```json
{ "action": "add", "name": "Apollo Hospitals", "domain": "apollohospitals.com" }
```

**Request (remove):**
```json
{ "action": "remove", "name": "Apollo Hospitals" }
```

**Response:**
```json
{
  "userCompetitors": [...],
  "discoveredCompetitors": [...],
  "blocklist": [...],
  "totalCount": 5,
  "slotsRemaining": 1
}
```

Auth: requires `accessToken` (same as other site endpoints).

### Modified: `POST /api/sites/[id]/competitor-discovery`

Current: discovers up to 6 competitors, overwrites `discoveredCompetitors`.

New:
1. Read `userCompetitors` and `competitorBlocklist` from site
2. Calculate `slotsAvailable = 6 - userCompetitors.length - discoveredCompetitors.length`
3. If `slotsAvailable <= 0`, return immediately with "No discovery slots available"
4. Pass blocklist + existing names to discovery function
5. Discovery prompt includes: "Do NOT include these companies: [blocklist + existing names]"
6. Filter results: remove any that match blocklist or existing names (case-insensitive)
7. Append to `discoveredCompetitors` (don't overwrite), capped at `slotsAvailable`

### Modified: Citation Check

No changes needed — citation check already reads from `discoveredCompetitors` for SOV. Need to also read `userCompetitors` and merge:

In `citation-checker.ts`:
```typescript
const allCompetitors = [
  ...(userCompetitors ?? []).map(c => ({ ...c, category: "user" as const })),
  ...(discoveredCompetitors ?? []),
];
```

Use `allCompetitors` instead of `discoveredCompetitors` for SOV computation and quality scoring.

## Drizzle Schema

```typescript
// In geo_sites table definition
userCompetitors: jsonb("user_competitors").$type<Array<{ name: string; domain?: string; addedAt: string }>>().default([]),
competitorBlocklist: jsonb("competitor_blocklist").$type<string[]>().default([]),
```

## geo_site_view Trigger

The Postgres trigger on `geo_sites` already propagates all columns. But `userCompetitors` and `competitorBlocklist` are new columns — they need to be added to:
1. `geo_site_view` table (DDL)
2. The trigger function `sync_geo_site_view()`
3. The Drizzle schema for `geoSiteView`

## Acceptance Criteria

1. User can add a competitor by name via text input — persists across page reloads
2. User can optionally provide a domain alongside the name
3. Competitor pills show source indicator (user=copper, discovered=gray)
4. Clicking X on a pill removes it and adds name to blocklist
5. Blocklisted names never reappear from Map Competitors
6. Max 6 total competitors enforced (add button disabled at 6)
7. Map Competitors discovers only remaining slots, skips blocklist + existing
8. Citation check SOV uses merged list (user + discovered)
9. Adding a competitor that already exists (case-insensitive) shows error
10. Deleting all competitors and running Map Competitors re-discovers up to 6 (minus blocklist)

## Risks

- **Domain ambiguity**: user enters "Apollo" — is that Apollo Hospitals, Apollo.io, or Apollo GraphQL? Without a domain, SOV matching relies on name only. Could add a domain lookup step (optional).
- **Blocklist growth**: if user deletes many competitors over time, blocklist grows. Cap at 20 entries, FIFO.
- **Migration**: existing sites have `discoveredCompetitors` but no `userCompetitors`. Default `[]` handles this — no backfill needed.
