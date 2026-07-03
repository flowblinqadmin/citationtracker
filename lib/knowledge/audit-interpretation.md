# Understanding Your GEO Audit Results

## Overall GEO Score (0-100)

Your GEO score measures how visible your website is to AI agents (ChatGPT, Perplexity, Gemini, Claude). Higher scores mean AI systems are more likely to find, understand, and cite your content.

### Score Tiers
- **Good (75-100)** — Your site is well-optimized for AI visibility. Focus on maintaining and minor improvements.
- **Fair (50-74)** — Decent foundation but significant room for improvement. Prioritize HIGH recommendations.
- **Weak (25-49)** — AI agents struggle to understand your site. Multiple critical issues need fixing.
- **Poor (0-24)** — Your site is largely invisible to AI. Start with the basics: structured data, meta tags, and llms.txt.

## Audit Pillars

The audit evaluates your site across multiple pillars. Each pillar scores 0-100 independently.

### Key Pillars

**Schema.org / Structured Data**
Measures whether your pages have JSON-LD structured data that AI agents can parse. Schema.org markup helps AI understand your business type, products, services, location, and content structure. Missing schema = AI agents guess about your site.

**llms.txt Compliance**
Checks if you serve an llms.txt file at /llms.txt following the llmstxt.org specification. This file tells AI agents what your site is about in a format they can directly consume. Like robots.txt but for AI comprehension.

**Meta Tags & Open Graph**
Evaluates title tags, meta descriptions, Open Graph tags, and Twitter cards. These are the primary signals AI agents use to understand what each page is about. Missing or duplicate meta tags hurt AI visibility.

**Content Quality & Depth**
Assesses content length, structure (headings, lists, paragraphs), readability, and topical depth. AI agents favor well-structured, comprehensive content over thin or shallow pages.

**Technical SEO**
Checks page speed, mobile-friendliness, canonical URLs, XML sitemaps, robots.txt configuration, and crawlability. Technical issues prevent AI crawlers from accessing your content.

**Internal Linking**
Measures how well pages link to each other. Strong internal linking helps AI agents discover and understand the relationships between your content.

**AI Crawler Access**
Verifies that AI-specific crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) are allowed in your robots.txt. Many sites accidentally block AI crawlers.

**Local SEO**
For businesses with physical locations: checks NAP consistency (Name, Address, Phone), Google Business Profile markup, and local schema.org data.

**E-E-A-T Signals**
Evaluates Experience, Expertise, Authoritativeness, and Trustworthiness signals. Author bios, credentials, citations, and trust indicators help AI engines assess content quality.

**FAQ & Knowledge Base**
Checks for FAQ sections, Q&A structured data, and knowledge base content. These formats are highly consumable by AI agents for direct answers.

**Image Optimization**
Evaluates alt text, image titles, and image schema. AI agents increasingly process images but need text descriptions to understand them.

**Security & Trust**
Checks HTTPS, security headers, privacy policy, and trust signals. AI agents may downweight content from sites with security issues.

## Priority Levels

Each pillar finding is tagged with a priority:

- **Critical** — Must fix immediately. These issues severely hurt AI visibility (e.g., no structured data at all, AI crawlers blocked).
- **High** — Fix soon. Significant impact on scores (e.g., missing llms.txt, incomplete meta tags).
- **Medium** — Fix when possible. Moderate impact (e.g., some pages missing schema, thin content on secondary pages).
- **Low** — Nice to have. Minor improvements (e.g., adding FAQ schema, optimizing image alt text).

## Recommendations

Recommendations are sorted by projected impact. Each recommendation includes:

- **Rank** — Priority order (1 = most impactful)
- **Title** — What to do
- **Pillar** — Which audit pillar it addresses
- **Specific Action** — Exact steps to implement
- **Estimated Boost** — Projected score improvement (e.g., "+2-5 points")
- **Priority** — HIGH, MED, or LOW

### How to Use Recommendations
1. Start with rank #1 (highest impact)
2. Implement the specific action described
3. Move to the next recommendation
4. Re-run your audit after implementing several changes to see updated scores

## Score Changes (Delta)

After re-running an audit, you'll see:
- **Positive delta (green)** — Your score improved since the last scan
- **Negative delta (red)** — Your score decreased (content changes, new issues, or algorithm updates)
- **Zero delta (gray)** — No change

## Citation Rate

The citation rate shows what percentage of AI engines mention your site when asked relevant questions. A higher citation rate means:
- AI agents know about your business
- They consider you a relevant source
- They're likely to recommend you to users

Citation checks query multiple AI providers (GPT, Claude, Perplexity, Gemini) with industry-relevant prompts and check if your domain appears in responses.

## Per-Page Results (Pro Feature)

The Pages tab shows individual URL analysis:
- **AI Visibility** — Per-page score
- **Schema** — Good (complete JSON-LD), Partial (some markup), None (no structured data)
- **Issues** — Specific problems found on that page

## Generated Files

The audit generates ready-to-deploy files:

- **llms.txt** — Concise summary of your business for AI agents. Deploy at /llms.txt on your domain.
- **llms-full.txt** — Extended version with detailed content descriptions. Deploy at /llms-full.txt.
- **business.json** — Structured business data in UCP format. Deploy at /.well-known/ucp.json.
- **schema.json** — JSON-LD schema.org blocks. Add to your page's <head> as <script type="application/ld+json">.
- **urls.txt** — Reference list of all crawled URLs.

## Competitive Intelligence

When competitors are discovered or added:
- **Share of Voice (SOV)** — What % of AI mentions go to you vs competitors
- **Competitor GEO Scores** — How competitors compare on AI visibility
- Use this to identify gaps and prioritize improvements that put you ahead
