/**
 * Static product knowledge injected into every chatbot system prompt.
 * This is about OUR product — deploys with code changes automatically.
 */

export const PRODUCT_KNOWLEDGE = `
## FlowBlinq GEO Product Knowledge

### What is GEO?
FlowBlinq GEO is an AI visibility audit platform at geo.flowblinq.com. It analyzes websites to determine how visible they are to AI agents (ChatGPT, Perplexity, Gemini, Claude) and provides actionable recommendations and ready-to-deploy files.

### Pricing

| Plan | Price | Pages/month | Crawl Frequency | Key Features |
|------|-------|-------------|-----------------|--------------|
| Free | $0 | 20 pages | One-time only | 1 full audit with all assets, max 2 free audits per email |
| Starter | $10/month | 500 pages | Manual or Monthly | Unlimited audits, page selection, bulk upload, citation monitoring |
| Growth | $20/month | 1,500 pages | Manual/Weekly/Monthly | Everything in Starter + competitive intelligence |
| Pro | $30/month | 3,000 pages | Manual/Daily/Weekly/Monthly | Everything in Growth + daily crawl frequency |

Annual billing: 20% discount on all plans.

### Credit System
- 1 credit = 5 pages of crawling
- Credit packs: 100 credits for $10
- Credits never expire
- Free tier: 0 credits, limited to 20 pages per audit
- Paid users (credits > 0): credits determine max pages

### Action Costs (in credits)
| Action | Cost | Notes |
|--------|------|-------|
| Run audit (crawl) | 1 credit per 5 pages | Free tier gets 20 pages free, no credits needed |
| Citation check (AI visibility scan) | 5 credits | Queries ChatGPT, Claude, Perplexity, Gemini with industry prompts |
| Competitor discovery | 5 credits | Discovers up to 6 competitors via AI analysis |
| Download ZIP report | 5 credits | Requires Pro account |
| Download PDF report | 5 credits | Requires Pro account |
| View results / scorecard | Free | No credit cost |
| Rerun audit | Same as initial audit | Credits based on page count |
| Bulk CSV audit | 1 credit per 5 URLs | Calculated from CSV row count |

### How to Buy Credits / Upgrade
1. Click "Buy Credits" in the dashboard header
2. Choose Plans tab (monthly subscription) or Credit Packs tab (one-time purchase)
3. Select quantity and click Pay
4. Secure payment via Stripe

### Portal Navigation

**Dashboard (/dashboard):**
- Shows all audited sites with scores, tiers, citations, and issues
- KPI cards: Total Sites, Avg Score, Critical Issues, Credits
- Actions: New Audit, Rerun, Download ZIP/PDF, Citation Check
- API Access section at bottom for generating API keys

**Results Page (/sites/[id]) — 6 tabs:**
1. Overview — High-level metrics, competitive intel, citation scan status
2. Scorecard — All audit pillars with scores, findings, and recommendations
3. Recommendations — Prioritized list sorted by impact (HIGH/MED/LOW)
4. Pages — Per-page analysis (Pro feature) with URL-level scores
5. History — Timeline of all audit runs with score changes
6. Setup — Generated files (llms.txt, business.json, schema blocks), domain verification

### Common Workflows
- **Run audit**: Homepage → enter domain → verify email → wait 2-3 min
- **Bulk audit**: Homepage → CSV upload → requires credits
- **Download report**: Dashboard row actions → ZIP or PDF button
- **Check citations**: Citation check button on dashboard or results page
- **Deploy files**: Setup tab → download → add to website
- **Add competitors**: Overview tab → competitor section

### Customer Support
For billing, account issues, or technical problems: hello@flowblinq.ai
`.trim();
