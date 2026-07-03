# GEO Improvement Sprint — Overview

**Branch:** `dev-an-geo`
**Date:** 2026-03-23
**Issues:** #136–#149 (14 issues, 60 recommendations)
**Sprints:** 30–33 (32 tasks, 157 tests, 17 new DB columns)

---

## Problem

A citation check on **manipalhospitals.com** returned **3% visibility** — meaningless for India's 4th largest hospital chain (30+ hospitals, 50+ specialties, 15+ cities).

**Root cause cascade:**
```
Blog-heavy crawl (93/99 pages were blog posts)
  → Weak generated files (llms.txt: "Infectious Disease" as primary service)
    → Misaligned prompts (40 telemedicine queries for a multi-specialty chain)
      → Meaningless citation score (3%)
```

**First-principles validation:** Not Manipal-specific. Of 60 recommendations derived, 38 are Universal (true for any website), 22 Scale with complexity (graceful degradation for simple sites), 0 are Manipal-specific.

---

## Architecture Change

**Two new data structures** stored on every site record:

1. **Geographic Tree** — Where the business operates
   ```
   Global → Country → State/Province → City (leaf)
   ```

2. **Category Tree** — What the business offers
   ```
   Industry → Business Line → Service/Product (leaf)
   ```

3. **Sparse Mapping** — Which categories are valid at which locations

These trees feed prompt generation, scoring, recommendations, and competitive intelligence.

**New pipeline stage:** `extract-trees` (after merge-crawl, before research)

---

## Sprint Structure

### Sprint 30 — Tier 1: Foundation (ES-053)
**Tasks:** T126–T134 (9 tasks) | **Tests:** 47

The core changes. Everything else builds on this.

| Task | Description | Size |
|------|-------------|------|
| T126 | Types, Schema, Pipeline Stage wiring | Small |
| T127 | Tree Extractor Service (Sonnet) | Large |
| T128 | Pipeline Integration (extract-trees stage) | Medium |
| T129 | Crawl Prioritizer + Discover Integration | Medium |
| T130 | Tree-Based Prompt Generator (Sonnet) | Large |
| T131 | Citation Check Route + Enrichment | Medium |
| T132 | Unit Tests (37) | Large |
| T133 | Integration Tests (10) | Medium |
| T134 | DDL Migration (4 columns) | Small |

**Key changes:**
- **C1:** Crawl priority — P0–P6 tier system, blog capped at 30%, industry-specific boosts
- **C2+C3:** Sonnet extracts geo + category trees from crawl data
- **C4:** Prompt generation reads trees, samples from geo×category cross-product with Buy/Solve/Learn tiers
- Schema: `geo_tree`, `category_tree`, `geo_category_mapping` on geo_sites; `prompt_metadata` on citation_check_scores

### Sprint 31 — Tier 2: Measurement Depth (ES-054)
**Tasks:** T135–T142 (8 tasks) | **Tests:** 39 | **Depends on:** Sprint 30

| Task | Description | Size |
|------|-------------|------|
| T135 | Types + Schema | Small |
| T136 | Per-city/category/tier visibility aggregation + impression share | Medium |
| T137 | Geographic Signals — 17th pillar (deterministic) | Medium |
| T138 | Crawl Coverage Validator | Small |
| T139 | Evidence-Based Recommendations + Visibility Gaps | Medium |
| T140 | Unit Tests (32) | Large |
| T141 | Integration Tests (7) | Medium |
| T142 | DDL Migration (7 columns) | Small |

**Key changes:**
- **C5:** Per-city and per-category visibility breakdown ("40% in Bangalore, 0% in Delhi")
- **C6:** Buy/Solve/Learn tier scoring with business-value interpretation
- **C7:** 17th pillar — geographic_signals (deterministic, no LLM)
- **Cross:** Impression share metric (continuous, not binary), enriched execution prompt
- **Cross:** Evidence-based recommendations citing Princeton research (+41% quotes, +33% stats, +28% citations), crawl coverage validation, visibility gap prioritization

### Sprint 32 — Tier 3: Content Intelligence (ES-055)
**Tasks:** T143–T150 (8 tasks) | **Tests:** 40 | **Depends on:** Sprint 31

| Task | Description | Size |
|------|-------------|------|
| T143 | Types + Schema | Small |
| T144 | Content Strategy Scorer (regex-based detection) | Medium |
| T145 | GEO Analyzer Integration (strategy signals in prompt) | Small |
| T146 | Content Zone Suggestions (6 zones extending PerPageFix) | Medium |
| T147 | Engine Preference Analyzer (Sonnet, 3rd+ check) | Medium |
| T148 | Unit Tests (33) | Large |
| T149 | Integration Tests (7) | Medium |
| T150 | DDL Migration (2 columns) | Small |

**Key changes:**
- **C8:** Detect quotation blocks, inline statistics, cited external sources per page (Princeton's top 3 strategies)
- **C9:** Content zone suggestions — Direct Answer Block, Comparison Table, Data & Evidence, Expert Quote, FAQ Section, Quotable Block
- **C10:** Per-engine preference rules (what ChatGPT prefers vs Perplexity vs Gemini), extracted via pairwise analysis on 3rd+ citation check

### Sprint 33 — Tier 4: Competitive Intelligence (ES-056)
**Tasks:** T151–T157 (7 tasks) | **Tests:** 31 | **Depends on:** Sprint 32

| Task | Description | Size |
|------|-------------|------|
| T151 | Types + Schema | Small |
| T152 | Per-Location Competitor Mapping + Dominance Map | Medium |
| T153 | Real Prompt Discovery via Perplexity | Medium |
| T154 | Prompt Generator Integration | Small |
| T155 | Unit Tests (24) | Large |
| T156 | Integration Tests (7) | Medium |
| T157 | DDL Migration (4 columns) | Small |

**Key changes:**
- **C11:** Competitors mapped per city and per service line. Dominance map: who leads each geo×category combination. Built from existing citation data — no new API calls.
- **C12:** Supplement LLM-generated prompts with real user questions from Google PAA, Reddit, Quora via Perplexity.

---

## Cost Impact

| Component | Per-check cost | Source |
|-----------|---------------|--------|
| Tree extraction (Sonnet) | $0.05 | ES-053 |
| Prompt generation (Sonnet) | $0.05 | ES-053 |
| Engine preference analysis | ~$0.03 (3rd+ check only) | ES-055 |
| Real prompt discovery | $0.001 | ES-056 |
| Citation execution | $0.05 (unchanged) | Existing |
| **Total** | **~$0.15** | |
| **Revenue** | **$1.00** (5 credits × $0.20) | |
| **Margin** | **~85%** (down from 94%) | |

---

## New DB Columns (17 total)

```sql
-- geo_sites (Sprint 30)
geo_tree jsonb
category_tree jsonb
geo_category_mapping jsonb

-- citation_check_scores (Sprint 30)
prompt_metadata jsonb

-- citation_check_scores (Sprint 31)
geo_visibility jsonb DEFAULT '[]'
category_visibility jsonb DEFAULT '[]'
tier_visibility jsonb DEFAULT '[]'
avg_impression_share integer
visibility_gap_analysis jsonb DEFAULT '[]'

-- citation_check_responses (Sprint 31)
impression_share integer

-- geo_sites (Sprint 31)
crawl_coverage_report jsonb

-- geo_sites (Sprint 32)
content_strategy_scores jsonb
engine_preferences jsonb

-- citation_check_scores (Sprint 33)
location_competitors jsonb DEFAULT '[]'
category_competitors jsonb DEFAULT '[]'
dominance_map jsonb
real_prompt_discovery jsonb
```

All nullable or defaulted. No breaking migrations.

---

## New Files

| File | Sprint | Purpose |
|------|--------|---------|
| `lib/services/crawl-prioritizer.ts` | 30 | P0–P6 page priority scoring |
| `lib/services/tree-extractor.ts` | 30 | Geo + category tree extraction (Sonnet) |
| `lib/services/crawl-coverage-validator.ts` | 31 | Crawl quality validation + warnings |
| `lib/services/content-strategy-scorer.ts` | 32 | Quotation/statistics/citation detection |
| `lib/services/engine-preference-analyzer.ts` | 32 | Per-engine rule extraction (Sonnet) |
| `lib/services/real-prompt-discoverer.ts` | 33 | PAA/Reddit/Quora via Perplexity |

**Modified files:** citation-prompt-generator.ts (rewrite), citation-checker.ts, geo-analyzer.ts, page-fix-generator.ts, pipeline stage route, citation-check route, schema.ts, types/citation.ts

---

## Spec Index

| Spec | File |
|------|------|
| TS-053 (Tier 1) | `docs/specs/technical/TS-053-geo-improvement-tier1.md` |
| TS-054 (Tier 2) | `docs/specs/technical/TS-054-geo-improvement-tier2.md` |
| TS-055 (Tier 3) | `docs/specs/technical/TS-055-geo-improvement-tier3.md` |
| TS-056 (Tier 4) | `docs/specs/technical/TS-056-geo-improvement-tier4.md` |
| ES-053 | `docs/specs/engineering/ES-053-geo-improvement-tier1.md` |
| ES-054 | `docs/specs/engineering/ES-054-geo-improvement-tier2.md` |
| ES-055 | `docs/specs/engineering/ES-055-geo-improvement-tier3.md` |
| ES-056 | `docs/specs/engineering/ES-056-geo-improvement-tier4.md` |
| Improvement Matrix | `docs/specs/technical/geo-improvement-matrix.md` |
| Internal Option (stashed) | `docs/specs/technical/internal_option_geo_improvement.md` |

---

## External Research

Six open-source repos analyzed for methodology:

| Repo | License | Key insight adopted |
|------|---------|---------------------|
| Princeton GEO (GEO-optim/GEO) | Apache 2.0 | Position-weighted visibility. Quotations +41%, statistics +33%, citations +28%. |
| CMU AutoGEO (cxcscmu/AutoGEO) | MIT | Per-engine rule extraction. Pairwise preference → reusable optimization rules. |
| gego (AI2HU/gego) | GPL-3.0 | Cron-based prompt scheduling model (studied, no code used). |
| geo_toolkit (max-d3v/geo_toolkit) | None | Location-aware analysis: city × keyword dominance (studied, no code used). |
| aeo-audit (AINYC/aeo-audit) | MIT | Geographic signals scoring factor (7%). Citation-ready paragraphs (40-200 words). |
| gtm-engineer-skills (onvoyage-ai) | MIT | Buy/Solve/Learn prompt tiers. 8 query types. 5 content zones per page. |

---

## Success Criteria

After all 4 sprints, re-running manipalhospitals.com should produce:
- Prompts covering oncology, cardiology, organ transplant, neurology (not just telemedicine)
- Prompts targeting Bangalore, Delhi, Kolkata, Gurugram (not location-blind)
- Citation score reflecting actual AI visibility across specialties and cities
- Per-city and per-service visibility breakdown
- Evidence-based recommendations with research citations
- Content zone suggestions per page (Direct Answer, FAQ, Expert Quote)
