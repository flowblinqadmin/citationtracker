# GEO Improvement Matrix

**Date:** 2026-03-23
**Context:** Comparison of Flowblinq GEO vs 6 open-source approaches. Manipal Hospitals (3% citation score) as reference case.
**Inputs:** Princeton GEO, CMU AutoGEO, gego, geo_toolkit, aeo-audit, gtm-engineer-skills

---

## Matrix: What We Have × What Changes

Rows = current Flowblinq components. Columns = proposed change areas derived from external approaches.

| What We Have | A. Crawl Intelligence | B. Geographic Awareness | C. Category Taxonomy | D. Prompt Quality | E. Visibility Metric | F. Content Optimization |
|---|---|---|---|---|---|---|
| **1. Crawl/Discovery** | Blog-heavy crawl (93/99 for Manipal). URL pattern matching for page types. No structural page prioritization. **→ Prioritize /locations/, /departments/, /services/, /team/ over /blog/. Weight nav-linked pages over deep blog. Detect site architecture from sitemap + nav before crawling.** | No location data extracted from pages. **→ Extract geo signals: addresses, LocalBusiness schema, areaServed, city/state mentions in page content.** | No vertical-specific crawl strategy. **→ Use industry classifier output to guide crawl priority (hospital → /departments/, e-commerce → /products/, SaaS → /pricing/).** | Crawl feeds prompt gen via 400 chars homepage. **→ Feed full structural page inventory to prompt gen, not just homepage snippet.** | — | — |
| **2. GEO Scoring (16 pillars)** | Scores based on what was crawled. If structural pages missing from crawl, pillars score low for wrong reasons. **→ Score crawl coverage separately; flag when key page types are missing before scoring content.** | No geo pillar. **→ Add geographic_signals pillar (like aeo-audit's 7% factor): LocalBusiness schema, GeoCoordinates, areaServed, address consistency.** | Site type detected but doesn't affect pillar weights. **→ Adjust pillar weights by vertical (hospital: contact_trust and author_authority weighted higher; e-commerce: structured_data and offering_clarity weighted higher).** | — | Princeton GEO uses position-weighted continuous impression (word count × position decay). We use binary mention + position 1-5. **→ Consider adding word-count contribution metric alongside binary mention.** | Princeton: quotations (+41%), statistics (+33%), cited sources (+28%) are top strategies. **→ Score these as sub-signals within content_structure and evidence_statistics pillars. Detect quotation blocks, inline stats, external citations.** |
| **3. File Generation (llms.txt, business.json, schema)** | Generated from crawl data — inherits crawl blind spots. Manipal's llms.txt lists "Infectious Disease" as primary service. **→ Post-crawl validation: flag when generated services list seems incomplete vs discovered page count.** | No location info in business.json. **→ Add areaServed, locations array, geo coordinates to business.json. Populate from crawl geo signals + LLM world knowledge.** | Services list is shallow (3 items for Manipal). **→ Extract category tree from crawl + LLM and populate services hierarchy in business.json.** | — | — | AutoGEO rewrites content for higher citation. gtm-engineer-skills generates content per page type. **→ Future: generate GEO-optimized content blocks per page (answer-first paragraphs, quotable blocks, FAQ sections) as part of fix suggestions.** |
| **4. Citation Prompt Generation** | Single Haiku call. 400 chars homepage + 300 chars summary. Pillar-based distribution (2-3 per pillar). **→ Ground on full generated files (llms.txt + business.json) + LLM world knowledge instead of 400 chars.** | No geographic dimension in prompts. Zero location-specific queries generated. **→ Build geo tree from crawl + LLM. Generate geo-specific prompts: "best oncology hospital in Bangalore", "top hospitals in Delhi".** | Category inferred from 400 chars homepage. Manipal → "telemedicine". **→ Build category tree from crawl + LLM. Generate category-specific prompts across full service taxonomy.** | Haiku generates all 48 prompts. No business-value tiering. **→ Sonnet for tree extraction + prompt gen. Adopt gtm-engineer-skills' Buy/Solve/Learn tiers: 20% Buy ("best X in Y"), 40% Solve ("how to find specialist for Z"), 40% Learn ("what is Y treatment").** | — | — |
| **5. Citation Execution (4 providers)** | 40 prompts × 4 providers = 160 calls. Haiku-tier models. Batch of 20, 100ms delay. **→ No change needed. Execution is sound.** | — | — | — | System prompt asks for "numbered list, 3-7 items". **→ Consider asking for "ranked list with brief reasoning" to enable richer position + sentiment extraction.** | — |
| **6. Citation Scoring** | Binary mention detection (regex). Position 1-5. Sentiment via keyword scan. Pillar visibility = % mention per pillar. **→ Reliable baseline.** | No per-location visibility breakdown. **→ If geo-specific prompts exist, compute per-city visibility scores. "You're cited 40% in Bangalore queries, 0% in Delhi."** | No per-category visibility breakdown beyond pillar. **→ If category-specific prompts exist, compute per-service visibility. "Oncology: 60% cited. Cardiology: 10%."** | — | Princeton: continuous score = word_count × exp(-position/total). We: binary + integer position. **→ Add "impression share" metric: what % of the response text references the brand. More nuanced than binary.** | — |
| **7. Recommendations** | Per-pillar recommendations from GEO scorecard. Generic across verticals. **→ Improve with crawl-intelligence: recommendations should reference missing structural pages, not just content gaps.** | No geo-specific recommendations. **→ "Your Bangalore presence is strong but Delhi pages lack structured data" — location-specific recs.** | No category-specific recommendations. **→ "Your oncology pages score well but cardiology lacks FAQ content" — service-specific recs.** | — | — | Princeton + AutoGEO show specific content strategies work. **→ Recommendations should reference proven strategies: "Add 2-3 expert quotes per department page (+41% visibility per Princeton GEO research)".** |
| **8. Per-Page Fixes** | Vulnerability detection + fix suggestions per page. gpt-4o-mini generates exact copy. **→ Sound baseline.** | — | — | — | — | AutoGEO rewrites entire documents. gtm-engineer-skills defines 5 content zones per page (Direct Answer, Comparison Table, Data & Evidence, Scenarios, FAQ). **→ Per-page fixes should suggest content zone additions, not just meta/heading fixes. "Add a Direct Answer Block in first 100 words" (+44.2% citation rate for first 30% of content).** |
| **9. Competitor Analysis** | LLM-based discovery. Citation SOV tracking. GEO status check on competitors. **→ Good baseline.** | No per-location competitor analysis. **→ geo_toolkit's approach: competitors vary by city. Apollo Hospitals dominates Chennai, Manipal dominates Bangalore. Surface this.** | No per-category competitor analysis. **→ "For organ transplant: your competitor is AIIMS. For cardiology: Narayana Health." Different competitors per service line.** | gtm-engineer-skills discovers prompts from PAA, Reddit, Quora — real user questions. **→ Competitor prompts should include real user questions, not just LLM-generated ones.** | geo_toolkit: "dominance graph" = who appears most across keyword × location. **→ Build dominance map: brand × keyword × location → mention count.** | — |
| **10. Geographic Handling** | **NONE.** | **This is the primary gap.** aeo-audit: 7% geo factor (LocalBusiness, GeoCoordinates, areaServed). geo_toolkit: city-appended keyword search + dominance per location. **→ Implement: (a) Geo tree extraction from crawl, (b) geo signals in scoring, (c) geo-specific citation prompts, (d) per-city visibility scores.** | — | — | — | — |
| **11. Category/Vertical Handling** | Industry classifier (schema.org → label). Vertical-specific field labels in commerce module. Minimal effect on scoring/prompts. | — | **Underutilized.** gtm-engineer-skills: 8 query types (definition, recommendation, comparison, evaluation, how-to, cost, landscape, use-case). **→ Map industry to service taxonomy tree. Use tree to generate category-specific prompts across all 8 query types.** | — | — | — |
| **12. Content Optimization** | **NONE. We audit and score. We don't rewrite or optimize content.** | — | — | — | — | Princeton GEO: 9 strategies, quotations best (+41%). AutoGEO: rule extraction → rewrite → RL-trained mini model. gtm-engineer-skills: 5 content zones per page. **→ Phase 2 opportunity: offer "GEO-optimized content suggestions" per page — not just "add FAQ" but actual draft FAQ content, quotable blocks, data-rich paragraphs. AutoGEO's approach of learning per-engine preferences could inform this.** |

---

## Change Priority (synthesized from matrix)

### Tier 1 — Fix the foundation (directly causes the Manipal problem)

| # | Change | Why | Source |
|---|--------|-----|--------|
| **C1** | Crawl structural page prioritization | 93/99 blog posts = root cause. No amount of downstream intelligence fixes bad input. | Our analysis |
| **C2** | Geographic tree extraction | Zero geo awareness. Hospital with 30+ locations gets zero location-specific prompts. | geo_toolkit, aeo-audit, internal option |
| **C3** | Category tree extraction | 400 chars homepage → "telemedicine" for a 50-specialty hospital chain. | gtm-engineer-skills, internal option |
| **C4** | Prompt generation from trees (Sonnet) | Two trees + sparse mapping → prompts that match real search behavior. | Internal option |

### Tier 2 — Deepen the measurement

| # | Change | Why | Source |
|---|--------|-----|--------|
| **C5** | Per-city + per-category visibility breakdown | "You're invisible in Delhi for cardiology" is 10× more actionable than "3% overall visibility". | geo_toolkit |
| **C6** | Business-value prompt tiers (Buy/Solve/Learn) | Current prompts are pillar-distributed. Real buyers search by intent, not by GEO pillar. | gtm-engineer-skills |
| **C7** | Geographic signals pillar | Scoring should reward location-specific structured data. | aeo-audit |

### Tier 3 — Content intelligence (future)

| # | Change | Why | Source |
|---|--------|-----|--------|
| **C8** | Content strategy scoring (quotations, statistics, citations) | Top 3 Princeton strategies aren't measured in our scoring. | Princeton GEO |
| **C9** | Content zone suggestions per page | "Add Direct Answer Block" > "improve content_structure pillar". | gtm-engineer-skills, AutoGEO |
| **C10** | Rule extraction per GE | Different engines prefer different content patterns. Engine-specific optimization. | AutoGEO |

### Tier 4 — Competitive intelligence

| # | Change | Why | Source |
|---|--------|-----|--------|
| **C11** | Per-location competitor mapping | Competitors vary by city. Apollo dominates Chennai ≠ Bangalore. | geo_toolkit |
| **C12** | Real prompt discovery (PAA, Reddit) | LLM-generated prompts miss real user phrasing. Supplement with actual search data. | gtm-engineer-skills |

---

## What We DON'T Need to Change

| Component | Why it's fine |
|-----------|--------------|
| Citation execution (4 providers, batch of 20) | Mechanically sound. Haiku-tier models appropriate for execution. |
| GEO pillar framework (16 pillars) | Comprehensive. External repos have fewer dimensions. |
| Per-page fix generation pipeline | Good architecture. Needs richer inputs, not different mechanics. |
| File generation pipeline | Architecture sound. Quality improves automatically with better crawl. |
| Competitor discovery | LLM-based discovery + SOV tracking is comparable to best open-source. |

---

## External Approach Summary (for reference)

| Repo | Key Insight for Us | License |
|------|-------------------|---------|
| **Princeton GEO** | Continuous position-weighted visibility metric. Quotations (+41%), statistics (+33%), cited sources (+28%) are top strategies. Keyword stuffing HURTS (-8%). | Apache 2.0 |
| **CMU AutoGEO** | Auto-extract what GEs prefer via pairwise preference → rules. Different engines prefer different things. RL-trained 1.7B model can do rewriting cheaply. | MIT |
| **gego** | Cron-scheduled prompt monitoring with keyword extraction. Unbounded goroutine fan-out (anti-pattern to avoid). Keyword extraction via regex on capitalized words (too simple). | GPL-3.0 (avoid code) |
| **geo_toolkit** | Location-aware analysis: city appended to keywords → per-location dominance graph. Human-in-the-loop keyword editing. 3-tier LLM strategy (nano/mini/full). | No license (avoid code) |
| **aeo-audit** | 13 weighted deterministic factors. Geographic Signals as optional 7% factor (LocalBusiness, GeoCoordinates, areaServed). Content Extractability: "citation-ready paragraphs" (40-200 words). | MIT |
| **gtm-engineer-skills** | Buy/Solve/Learn business-value tiers for prompts. 8 query types. 5 content zones per page. Prompt research from PAA/Reddit/Quora. Most complete content pipeline. | MIT |
