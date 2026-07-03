# TS-059: Brand Detection + Category Extraction + Template Overhaul

**Author:** CoFounder (Agent 1)
**Date:** 2026-03-25
**Branch:** `dev-an-geo`
**Depends on:** TS-058 (V2 prompt generator), ES-057 (dimensional UI)
**Design reviews:** HolePoker adversarial analyses completed:
  - Brand detection (2026-03-25T08:00:00Z)
  - Category extraction (2026-03-25T09:30:00Z)

---

## Problem Statement

Three interconnected quality problems in the citation check system:

1. **Brand mention detection is broken.** `detectMention()` derives brand name from domain string (`manipalhospitals.com` → `manipalhospitals`). AI engines write "Manipal Hospitals" (spaced). Result: 0% visibility for sites that ARE being cited. Proven: fixing compound splitting alone jumped Manipal from 2% to 30%.

2. **Category extraction produces blog topics, not services.** With 100/7193 pages crawled, the categoryTree contains blog-derived subcategories ("HIV", "Zika Virus", "Cervical Cancer") instead of actual hospital departments ("Oncology", "Cardiology", "Orthopedics").

3. **Seed templates use generic entity nouns.** "firms", "companies", "providers" — for hospitals this produces nonsensical prompts like "Who are the most trusted Cervical Cancer firms?"

---

## Part A: Brand Mention Detection Rewrite

### A.1 Brand Keyword Extraction

Extract brand keywords from existing structured data. No new LLM call needed.

**Source priority:**
1. `generatedBusinessJson.vendor.name` — "Manipal Hospitals" (primary)
2. `generatedBusinessJson.geo_profile.business_name` — fallback if vendor.name missing
3. Domain stem — "manipalhospitals" (always available)

**Alias auto-generation algorithm:**
Given vendor.name = "Manipal Hospitals Ltd":
1. Full name: "Manipal Hospitals Ltd"
2. Strip legal suffixes (Inc, LLC, Ltd, Corp, Group, Pvt, Private, Limited): "Manipal Hospitals"
3. First N-1 words (if multi-word): "Manipal"
4. Domain stem: "manipalhospitals"
5. Domain stem with common splits: "manipal hospitals" (via existing COMMON_SUFFIXES)
6. Singular/plural: "Manipal Hospital" / "Manipal Hospitals"

DO NOT auto-generate acronyms ("MH" matches too many things).

**Matching order:** Longest first → most specific match wins.

### A.2 Ambiguity Detection

**Common-word dictionary** (not character count):
Maintain a curated Set of ~80 common English words that are also brand names:
```
"apple", "chase", "target", "amazon", "bolt", "gap", "shell", "virgin",
"oracle", "adobe", "nest", "spark", "stripe", "square", "snap", "zoom",
"slack", "notion", "linear", "arc", "ray", "nile", "delta", "summit", ...
```

If any brand keyword (lowercased) appears in this set → require proximity check.
If NOT in the set → match directly, no proximity needed.

### A.3 Proximity Check

When triggered (ambiguous brand name):
- Search for category keyword within **300 chars** of brand mention
- Category keywords from: `extractedCategories.categories` (primary) → `businessJson.geo_profile.topics` → `siteType` words → domain stem words
- If category keyword found within 300 chars → confirmed mention
- If not found → skip (likely false positive)

### A.4 Detection Algorithm

```
function detectMention(responseText, brandKeywords, categoryKeywords, isAmbiguous):
  for keyword in brandKeywords (longest first):
    match = case-insensitive search in responseText
    if match:
      if isAmbiguous:
        context = responseText[match.index - 300 : match.index + keyword.length + 300]
        if any categoryKeyword in context (case-insensitive):
          return { mentioned: true, position, sentiment }
        else:
          continue  // try next keyword
      else:
        return { mentioned: true, position, sentiment }

  // Also check domain URL (complementary — Perplexity uses URLs 20x more than names)
  domainMatch = search for domain in responseText
  if domainMatch:
    return { mentioned: true, position, sentiment }

  return { mentioned: false }
```

### A.5 Vendor.name Validation

Before using vendor.name, validate against domain stem:
- Check if any word in vendor.name shares 3+ chars with domain stem
- "Manipal Hospitals" vs "manipalhospitals" → "manipal" overlap ✓
- If zero overlap → log warning, fall back to domain stem detection (possible hallucination)

### A.6 Schema

New column on `geoSites`:
```sql
ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS brand_keywords jsonb;
```

Type: `{ keywords: string[], isAmbiguous: boolean, source: "vendor" | "domain" | "manual", extractedAt: string }`

Computed once during content generation pipeline. Refreshed on re-audit. User-overridable (future: UI field for manual brand name entry).

### A.7 Backward Compatibility

Brand detection version tracked by existing `promptArchitectureVersion` flag. V2 checks use brand keywords. V1 checks used domain stem. No retroactive re-scoring.

---

## Part B: LLM Category Extraction

### B.1 Haiku Call

**System prompt:**
```
Extract 5-7 primary service or product categories for this business.
Think DEPARTMENTS or PRODUCT LINES — what would appear on the company's
main navigation menu. Not blog post topics or subcategories.

Also return the entity noun that describes what this type of business is
called (e.g., "hospitals", "agencies", "platforms", "stores").

Return only valid JSON:
{ "categories": ["Category1", "Category2", ...], "entityNoun": "hospitals" }
```

**User prompt:**
```
Domain: {domain}
Industry: {siteType or businessJson.geo_profile.industry}

Business description:
{llms.txt first 800 chars}

Homepage:
{homepage content first 300 chars}

Service/department pages found on the site:
{filtered URLs — /departments/, /services/, /specialties/, /solutions/, /products/ patterns, max 30}

Content topics found during crawl (these may be blog topics, use as hints only):
{categoryTree leaf names, comma-separated}

Examples:
- Hospital: {"categories": ["Oncology", "Cardiology", "Orthopedics"], "entityNoun": "hospitals"}
- Consultancy: {"categories": ["Digital Transformation", "Regulatory Compliance"], "entityNoun": "consultancies"}
- SaaS: {"categories": ["Project Management", "Team Collaboration"], "entityNoun": "platforms"}
- Any business: the main services or product lines the business offers
```

**Model:** claude-haiku-4-5-20251001
**Temperature:** 0
**Max tokens:** 500
**Timeout:** 10s
**Cost:** ~$0.001

### B.2 Validation

After parsing Haiku response:
1. Length check: each category 2-50 chars
2. Dedup: remove categories that are substrings of each other ("Oncology" + "Oncology Department" → keep "Oncology")
3. Cross-reference: check if at least 2 categories appear in page URLs or categoryTree node names (partial match OK)
4. If <3 categories survive: fall back to businessJson.geo_profile.topics
5. If topics also empty: fall back to categoryTree leaf names (what we have today)
6. If entityNoun missing or >30 chars: fall back to hardcoded industry-to-noun mapping

**Minimum input guard:** Require ≥200 chars of combined input (llms.txt + homepage). If less, skip Haiku entirely — insufficient context for meaningful extraction.

### B.3 Page URL Filtering

From crawlData.pages, extract URLs matching service/department patterns:
```
INCLUDE: /departments/, /services/, /specialties/, /solutions/, /products/,
         /practice-areas/, /treatments/, /procedures/, /offerings/
EXCLUDE: /blog/, /news/, /press/, /careers/, /events/, /category/, /tag/
```

Send as plain list (URL path only, not full URL). Max 30 entries.

### B.4 Schema

New column on `geoSites`:
```sql
ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS extracted_categories jsonb;
```

Type: `{ categories: string[], entityNoun: string, extractedAt: string, source: "haiku" | "topics" | "tree" | "fallback" }`

### B.5 Execution

**Pipeline (primary):** Run after content generation (assemble stage) when businessJson and llms.txt are available. Store result on geoSites.

**Lazy fallback (citation check):** If `extractedCategories` is null at citation check time, run Haiku extraction inline. Same atomic guard pattern as lazy tree extraction (`WHERE extracted_categories IS NULL`). Persist result.

### B.6 Integration with V2 Prompt Generator

Replace `extractCategories()` in citation-prompt-generator.ts:
```typescript
function extractCategories(site): string[] {
  // 1. Use persisted extracted categories (Haiku or fallback)
  if (site.extractedCategories?.categories?.length >= 3) {
    return site.extractedCategories.categories;
  }
  // 2. businessJson.topics
  // 3. categoryTree leaves
  // 4. siteType as single category
  // existing fallback chain
}
```

Replace entity noun in seed templates:
```typescript
function getEntityNoun(site): string {
  return site.extractedCategories?.entityNoun
    ?? INDUSTRY_NOUN_MAP[site.siteType?.toLowerCase()]
    ?? "companies";
}
```

---

## Part C: Seed Template Fixes

### C.1 Industry-Aware Templates

Replace current templates:
```
discovery:  "What are the best {category} {noun}{geoSuffix}?"
evaluation: "Which {category} {noun}{geoSuffix} have published case studies with measurable results?"
trust:      "Who are the most trusted {noun} for {category}{geoSuffix}?"
clarity:    "Which {noun} should I consider for {category}{geoSuffix}?"
readiness:  "Which {noun} for {category}{geoSuffix} offer free trials or consultations?"
```

Where `{noun}` comes from `getEntityNoun()`.

Examples for Manipal Hospitals (entityNoun = "hospitals"):
- "What are the best Oncology hospitals in Bangalore?"
- "Which hospitals for Cardiology in India have published case studies?"
- "Who are the most trusted hospitals for Orthopedics in Karnataka?"
- "Which hospitals should I consider for Neurology in Bangalore?"

Examples for NileHQ (entityNoun = "consultancies"):
- "What are the best Regulatory Compliance consultancies?"
- "Who are the most trusted consultancies for Digital Transformation in the UK?"

### C.2 Fallback Industry-Noun Map

Keep as fallback when LLM entityNoun is missing:
```typescript
const INDUSTRY_NOUN_MAP: Record<string, string> = {
  healthcare: "hospitals",
  hospital: "hospitals",
  dental: "dental clinics",
  consulting: "consultancies",
  software: "platforms",
  saas: "platforms",
  finance: "financial institutions",
  insurance: "insurers",
  legal: "law firms",
  education: "schools",
  retail: "stores",
  restaurant: "restaurants",
  manufacturing: "manufacturers",
  construction: "contractors",
  marketing: "agencies",
  real estate: "agencies",
  travel: "tour operators",
  fitness: "studios",
};
```

Match by substring: if siteType contains any key, use the corresponding noun.

---

## Acceptance Criteria

### Detection
- [ ] AC1: Brand keywords extracted from vendor.name with auto-generated aliases
- [ ] AC2: Common-word dictionary triggers proximity check for ambiguous brands
- [ ] AC3: Proximity window 300 chars with category keyword validation
- [ ] AC4: Domain URL matching kept alongside brand keyword matching
- [ ] AC5: Vendor.name validated against domain stem (zero-overlap warning)
- [ ] AC6: brandKeywords persisted as jsonb column on geoSites
- [ ] AC7: Matching order: longest keyword first

### Category Extraction
- [ ] AC8: Haiku call extracts 5-7 categories + entityNoun from llms.txt + homepage + page URLs + tree hints
- [ ] AC9: Validation: length check, dedup, cross-reference (≥2 match page URLs/tree)
- [ ] AC10: Minimum input guard: ≥200 chars combined or skip Haiku
- [ ] AC11: extractedCategories persisted as jsonb column on geoSites
- [ ] AC12: Page URL filtering for service/department patterns (max 30)
- [ ] AC13: Lazy fallback with atomic guard at citation check time
- [ ] AC14: Fallback chain: Haiku → topics → tree → siteType

### Templates
- [ ] AC15: Entity noun from extractedCategories.entityNoun (primary) or INDUSTRY_NOUN_MAP (fallback)
- [ ] AC16: All 5 seed templates use {noun} instead of hardcoded "firms"/"companies"
- [ ] AC17: Template phrasing asks for entities/companies, not advice/criteria

### Integration
- [ ] AC18: V2 prompt generator uses extractedCategories for category source
- [ ] AC19: detectMention uses brandKeywords for mention detection
- [ ] AC20: Zero interface changes to downstream (CitationPrompt[] shape unchanged)

---

## DDL

```sql
ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS brand_keywords jsonb,
  ADD COLUMN IF NOT EXISTS extracted_categories jsonb;
```

Both nullable, no defaults. Populated lazily or via pipeline.

---

## Cost

| Component | Cost | When |
|-----------|------|------|
| Haiku category extraction | ~$0.001 | Once per site |
| Brand keyword extraction | $0 | Computed from existing data |
| Total per site | ~$0.001 | One-time |

---

## Test Plan (for SpecMaster + ReviewMaster)

### Brand Detection
| # | Test |
|---|------|
| U1 | extractBrandKeywords from vendor.name "Manipal Hospitals Ltd" → ["manipal hospitals ltd", "manipal hospitals", "manipal", "manipalhospitals"] |
| U2 | Ambiguity check: "Nile" is in common-word dict → isAmbiguous=true |
| U3 | Ambiguity check: "Manipal" NOT in dict → isAmbiguous=false |
| U4 | Proximity match: "Nile" within 300 chars of "transformation" → mention confirmed |
| U5 | Proximity miss: "Nile" near "river" without category keyword → mention rejected |
| U6 | Longest-first matching: "Manipal Hospitals" matches before "Manipal" |
| U7 | Domain URL match: "manipalhospitals.com" found in response → mentioned |
| U8 | Vendor.name validation: "Manipal Hospitals" vs "manipalhospitals" → overlap OK |
| U9 | Vendor.name validation: "Best Healthcare" vs "xyzmedical.com" → zero overlap warning |
| U10 | detectMention with both brand keywords AND domain URL → brand keyword wins (longer match) |

### Category Extraction
| # | Test |
|---|------|
| U11 | Haiku returns valid categories + entityNoun → stored correctly |
| U12 | Haiku returns <3 valid categories after validation → falls back to topics |
| U13 | Haiku timeout → falls back to topics |
| U14 | Page URL filtering: /departments/oncology included, /blog/cancer excluded |
| U15 | Category dedup: "Oncology" + "Oncology Department" → "Oncology" |
| U16 | Minimum input guard: <200 chars → Haiku skipped |
| U17 | Cross-reference: "Oncology" found in tree → validated |
| U18 | entityNoun fallback: missing from Haiku → INDUSTRY_NOUN_MAP used |

### Templates
| # | Test |
|---|------|
| U19 | Seed templates use entityNoun "hospitals" for healthcare site |
| U20 | Seed templates use "companies" as default when no noun available |
| U21 | Trust template: "Who are the most trusted hospitals for Oncology in Bangalore?" |
| U22 | Clarity template: "Which hospitals should I consider for Cardiology in India?" |

### Integration
| # | Test |
|---|------|
| IT1 | Full citation check with brand keywords → visibility > 0% for cited brand |
| IT2 | Full citation check with extracted categories → prompts use real service names |
| IT3 | Lazy extraction: first check extracts + persists, second check reuses |
| IT4 | Fallback chain: no Haiku → topics → tree → siteType |
