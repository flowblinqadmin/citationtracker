# Internal Option: GEO Improvement — Tree-Based Citation Prompts

**Status:** Stashed (2026-03-23) — exploring external alternatives first
**Context:** Investigating manipalhospitals.com citation score of 3% from misaligned prompts

## Problem Statement

Citation prompt generation produces irrelevant prompts because:
1. Crawl is blog-heavy (93/99 pages for Manipal are blog posts, no structural pages)
2. Generated files (llms.txt, business.json) inherit the crawl's blind spots
3. Prompt generator uses only 400 chars of homepage + 300 chars of executive summary
4. Single Haiku call infers entire market from minimal context → tunnel vision

## Proposed Architecture

### Two-Tree Model

**Geographic Circle of Influence (GCI):**
```
Global → Country → State/Province → City (leaf)
```

**Category Circle of Influence (CCI):**
```
e.g. Healthcare → Hospital → Diagnostic Tests
                           → Specialties → Oncology, Cardiology, ...
```

### Cross-Product Mapping
- Sparse mapping: not every category exists at every location
- Determines which (geo, category) pairs are valid for the business

### Prompt Generation from Trees
- Sample intelligently from the cross-product
- Budget: ~10 category-only + ~8 geo-only + ~15 geo×category + ~7 discovery = 40 indirect
- Plus 8 direct (unchanged)

## Model Selection
- **Tree extraction + prompt generation:** Sonnet 4 (two calls)
- **Citation execution:** Haiku / GPT-4o-mini / Gemini Flash Lite / Sonar (unchanged)

## Cost Impact
- Prompt generation: $0.01 → $0.10 per check (+$0.09)
- Execution: ~$0.05 (unchanged)
- Total: $0.06 → $0.15 per check
- Revenue: $1.00 per check (5 credits × $0.20)
- Margin: 94% → 85% (acceptable)

## Input Sources Considered

| Source | Verdict |
|--------|---------|
| Generated files (llms.txt, business.json) | Best when crawl is good; weak when crawl is poor |
| Raw crawl data | Volume but no structure; blog-heavy for many sites |
| URL structure analysis | Works for some sites, too noisy to generalize |
| Discovery data | Just URLs + page type classification, no content |
| LLM world knowledge | Good for well-known businesses, hallucination risk for niche |
| Generated files + LLM world knowledge | Best hybrid — grounding + expansion |

## Blocking Insight

The generated files are only as good as the crawl. Fixing prompts without fixing the crawl means:
- Citation score improves (measuring the right thing)
- But recommendations and generated files remain weak
- Customer sees the problem but the tool can't help them fix it

**Root cause is crawl quality** — structural pages (departments, locations, services) must be prioritized over blog posts.

## Fix Order (if pursued)
1. Crawl quality — prioritize structural pages
2. Generated files improve automatically
3. Tree extraction from improved generated files (Sonnet)
4. Prompt generation from trees (Sonnet)
5. Citation execution (unchanged, Haiku-tier models)

## Open Question
Is the crawl problem Manipal-specific or systemic? Need to audit other sites.
