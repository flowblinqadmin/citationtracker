# AI Shopping Surface Ranking Factor Experiment

## Goal

Reverse-engineer what signals determine merchant/product visibility across 5 AI shopping surfaces:

1. **ChatGPT Shopping** — OpenAI Responses API + web_search
2. **Perplexity Shopping** — Sonar model with live retrieval
3. **Google AI Overviews** — Gemini + Google Search grounding
4. **Meta AI** — Llama 4 via Together AI (or Anthropic proxy)
5. **Amazon Rufus** — Simulated via Brave Search + LLM

## Method

### Phase 1: Signal Extraction
For each merchant in the cohort, crawl their site and extract:
- **Schema.org types** — Product, Offer, Review, FAQ, Organization, etc.
- **Review platform presence** — Trustpilot, Yotpo, Google Reviews, etc.
- **Content freshness** — Current year mentions, date recency
- **Crawlability** — robots.txt AI bot rules, llms.txt, sitemap
- **Content quality** — FAQ, comparison, pricing, shipping, return info
- **Social proof** — Social channel links, review counts

### Phase 2: Surface Probing
For each merchant × surface, run 5 shopping-intent queries per vertical and measure:
- **Mention rate** — Was the merchant named/linked?
- **Position** — Where in the numbered list?
- **Sentiment** — Positive/neutral/negative context
- **Citation URLs** — Which URLs did the surface ground against?

### Phase 3: Correlation Analysis
Compute Pearson/point-biserial correlations between each signal and visibility score per surface. Identify:
- Top positive correlators (signal → higher visibility)
- Top negative correlators (signal → lower visibility)
- Cross-surface consistency (signals that matter everywhere)

### Phase 4: FlowBlinq Instrumentability
Map correlated signals to FlowBlinq's optimization capabilities:
- **Low effort**: Schema injection, llms.txt generation, robots.txt fixes
- **Medium effort**: FAQ generation, content freshness updates, comparison pages
- **High effort**: Review platform integration, social proof building

## Running

```bash
# Full run (~10-15 min, ~$10 in API costs)
node --env-file=.env.local scripts/experiments/ai-surface-audit/run-experiment.mjs

# Quick test (3 merchants only)
node --env-file=.env.local scripts/experiments/ai-surface-audit/run-experiment.mjs --merchants 3

# Skip expensive crawl phase (use cached signals)
node --env-file=.env.local scripts/experiments/ai-surface-audit/run-experiment.mjs --skip-crawl

# Single surface only
node --env-file=.env.local scripts/experiments/ai-surface-audit/run-experiment.mjs --surfaces chatgpt_shopping

# Weekly automated run
bash scripts/experiments/ai-surface-audit/run-weekly.sh
```

## Output

Results go to `scripts/experiments/ai-surface-audit/results/`:

| File | Format | Purpose |
|------|--------|---------|
| `ranking-factors-YYYY-MM-DD.txt` | Text | Human-readable report with correlation tables |
| `ranking-factors-YYYY-MM-DD.json` | JSON | Machine-readable full results |
| `signals.json` | JSON | Cached signal extraction (skip re-crawl) |
| `probes.json` | JSON | Cached surface probe results |

## Cost Model

| Phase | API | Estimated Cost |
|-------|-----|---------------|
| Signal extraction | Firecrawl (100 pages) | ~$2 |
| ChatGPT probes | OpenAI (100 calls) | ~$1.50 |
| Perplexity probes | Sonar (100 calls) | ~$1 |
| Google probes | Gemini (100 calls) | ~$0.50 |
| Meta AI probes | Together/Anthropic (100 calls) | ~$1 |
| Rufus sim | OpenAI + Brave (100 calls) | ~$2 |
| **Total** | | **~$8-10** |

## Cohort Selection Criteria

20 merchants selected to vary across:
- **Vertical**: powersports, auto parts, tactical, fitness, beauty, jewelry, health, supplements, outdoor
- **Platform**: Shopify, Miva, BigCommerce, Magento, NetSuite, WooCommerce, custom
- **Revenue tier**: $10M to $1B+
- **Signal richness**: Category leaders (rich schema) vs FlowBlinq prospects (likely weak)

This ensures the correlation analysis captures the real signal range, not just best-in-class.

## Making It a Recurring Job

### Option 1: Local cron
```bash
# Every Monday 6am EST
0 10 * * 1 cd /path/to/geo && bash scripts/experiments/ai-surface-audit/run-weekly.sh
```

### Option 2: GitHub Actions
Create `.github/workflows/ai-surface-audit.yml` — runs weekly, commits results.

### Option 3: QStash scheduled job
Use the existing GEO QStash infrastructure to trigger via API route.

## What This Proves for FlowBlinq

If Product Schema correlates r=+0.6 with ChatGPT Shopping visibility, that's a **direct, measurable proof point** for the sales pitch: "We inject the structured data that makes AI shopping agents find you."

The instrumentability matrix becomes the product roadmap for FlowBlinq's optimization service.
