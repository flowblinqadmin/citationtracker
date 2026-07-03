# FlowBlinq GEO Portal Guide

## What is FlowBlinq GEO?
FlowBlinq GEO is an AI visibility audit platform. It analyzes websites to determine how visible they are to AI agents like ChatGPT, Perplexity, Gemini, and Claude. It generates actionable recommendations and ready-to-deploy files (llms.txt, structured data, schema.org blocks) to improve AI discoverability.

## Getting Started

### Running Your First Audit
1. Go to geo.flowblinq.com
2. Enter your website domain (e.g., example.com)
3. Enter your email address
4. Click "Get My AI Profile"
5. Check your email for a 6-digit verification code
6. Enter the code on the verification page
7. Wait 2-3 minutes for the audit to complete

### Bulk Audits (Pro Feature)
1. Prepare a CSV file with one URL per row (max 500 URLs)
2. On the homepage, click "Bulk CSV" and upload the file
3. The system calculates credits needed (1 credit = 5 pages)
4. Requires a Pro account with sufficient credits

## Dashboard (/dashboard)

After signing in, the dashboard shows all your audited sites.

### KPI Cards (top row)
- **Total Sites** — Number of domains you've audited, plus any scans in progress
- **Avg GEO Score** — Average score across all your completed audits
- **Total Critical Issues** — Number of critical issues found across all sites
- **Credits Remaining** — Your current credit balance with a "Buy more" link

### Audit History Table
Each row shows a domain with:
- **GEO Score** — 0-100 overall score with color bar
- **Tier** — GOOD (75+), FAIR (50-74), WEAK (25-49), or POOR (0-24)
- **Citations** — Percentage of AI engines that mention your site
- **Critical Issues** — Number of critical problems found
- **Delta** — Score change since last scan (green = improved, red = declined)
- **Last Scan** — When the audit was last run

### Dashboard Actions
- **New Audit** — Enter a domain or upload CSV to start a new audit
- **Rerun Audit** — Re-scan a domain (requires credits for paid plans)
- **Rerun Citations** — Check if AI engines are citing your site
- **Download ZIP** — Download all audit files as a ZIP archive
- **Download PDF** — Get a formatted PDF report

### API Access (bottom of dashboard)
- Generate API keys for programmatic access
- Each key has a Client ID and Client Secret
- Keys can be revoked at any time

## Site Results Page (/sites/[id])

The results page has 6 tabs:

### Overview Tab
Shows high-level metrics:
- **AI Visibility Score** — Your overall GEO score (0-100)
- **Citation Rate** — What percentage of AI engines mention your site
- **Critical Issues** — Number of critical problems
- **Pages Crawled** — How many pages were analyzed
- **Last Refreshed** — When the audit ran

Also shows competitive intelligence if competitors have been discovered.

### Scorecard Tab
Detailed breakdown across all audit pillars. Each pillar card shows:
- Pillar name and score (0-100)
- Priority level (Critical, High, Medium, Low)
- Key finding
- Recommended action
- List of impacted pages

Filter pillars by tier: All, Poor (0-24), Weak (25-49), Fair (50-74), Good (75-100).

### Recommendations Tab
Prioritized list of improvements sorted by impact. Each recommendation shows:
- Rank number
- Title and description
- Which pillar it affects
- Specific action to take
- Estimated score boost (e.g., "+2-5 points")
- Priority level (HIGH/MED/LOW)

### Pages Tab (Pro Feature)
Per-page analysis showing:
- Individual URL scores
- Schema.org status per page
- Accessibility and performance issues
- Filter by: All, Critical, Medium, Good
- Paginated (25 per page)

### History Tab
Timeline of all audit runs showing:
- Date of each scan
- Score at that time
- Change from previous scan
- Visual bar representation

### Setup Tab
Deployment files and domain verification:
- **llms.txt** — Your generated llms.txt file (view, copy, download)
- **llms-full.txt** — Extended version with full content
- **business.json** — Structured business data
- **schema.json** — Schema.org JSON-LD blocks
- **urls.txt** — URL list for reference
- **Domain Verification** — Verify ownership via DNS or meta tag
- **Implementation Status** — Checklist of deployed files

## Common Workflows

### Improving Your Score
1. Go to the Recommendations tab
2. Start with HIGH priority items
3. Click each recommendation for specific steps
4. Implement changes on your website
5. Re-run the audit to see score improvements

### Checking AI Citations
1. Click the citation check button (chat bubble icon) on the dashboard or results page
2. Wait for the scan to complete (takes ~1 minute)
3. View which AI engines mention your site and in what context

### Adding Competitors
1. On the results page Overview tab, use the competitor section
2. Add competitor domains to track
3. See competitive Share of Voice comparisons

### Downloading Reports
- **ZIP Archive**: Contains all generated files (llms.txt, schema blocks, etc.)
- **PDF Report**: Formatted report suitable for sharing with stakeholders
- Both available from the dashboard row actions or the results page header

### Deploying GEO Files
1. Go to the Setup tab on your results page
2. Download the generated files (llms.txt, business.json, etc.)
3. Follow the platform-specific integration instructions
4. Verify deployment using the domain verification tool

## Navigation Quick Reference

| Action | Where |
|--------|-------|
| Run new audit | Homepage or Dashboard "New Audit" |
| View results | Click domain row in Dashboard |
| Buy credits | "Buy Credits" button in Dashboard header |
| Change plan | Upgrade modal → Plans tab |
| Download files | Setup tab or Dashboard row actions |
| Check citations | Citation button on Dashboard or Results page |
| Add competitors | Overview tab on Results page |
| API keys | Bottom of Dashboard page |
| Sign out | Dashboard header |
