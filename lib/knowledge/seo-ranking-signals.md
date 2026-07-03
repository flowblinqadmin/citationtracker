# SEO + GEO Ranking Signals Reference

Last updated: 2026-03-30
Sources: Google Search Central Blog, Google documentation, industry research (Semrush, Seer Interactive, ALM Corp)

This document is structured for injection into LLM scoring prompts. Each signal includes its current weight/importance and actionable criteria.

---

## TIER 1: Critical Ranking Signals (Direct, High Impact)

### 1.1 Content Quality & Relevance
- **Search intent match**: Content must satisfy the specific user intent behind the query. Google evaluates whether users feel fully satisfied or need to continue searching.
- **Authenticity score** (new Dec 2025): Google evaluates whether content demonstrates genuine expertise vs. being created primarily for rankings.
- **Topical authority**: Sites with demonstrated deep expertise in a subject area rank higher than generalists.
- **Content depth and completeness**: Thin, generic, or incomplete content ranks poorly regardless of other signals.
- **Unique value**: Non-commodity content that provides information not available elsewhere.
- **Freshness**: Timely, up-to-date content for queries where recency matters.

### 1.2 E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness)
- **Not a direct ranking factor** but reflected in measurable ranking signals.
- **Now applies to ALL competitive queries** (expanded beyond YMYL as of Dec 2025).
- **Experience**: First-hand evidence, detailed personal knowledge of the topic.
- **Expertise**: Subject matter credentials, demonstrated skill.
- **Authoritativeness**: Recognition by peers, citations, reputation in the field.
- **Trustworthiness**: Accuracy, transparency, safety of the site.
- **Author identification**: Clear author bios with verifiable credentials are essentially mandatory for competitive queries.

### 1.3 Backlink Profile
- **Quality over quantity**: Judged by trustworthiness, contextual alignment, relevance.
- **Topical authority of linking site**: Links from sites with clear topical authority and audience overlap carry more weight.
- **Natural link patterns**: Link networks, paid links, excessive exchanges are penalized.
- **Diversity**: Links from varied authoritative sources signal broader recognition.

### 1.4 Core Web Vitals (Elevated to Tier 1 as of Dec 2025)
- **LCP** (Largest Contentful Paint): < 2.5 seconds (good), > 4.0 seconds (poor)
- **INP** (Interaction to Next Paint): < 200ms (good), > 500ms (poor) — 43% of sites fail this
- **CLS** (Cumulative Layout Shift): < 0.1 (good), > 0.25 (poor)
- **VSI** (Visual Stability Index, new 2026): Layout stability throughout entire user session
- **Cross-browser**: Now measured in Chrome, Firefox 144+, and Safari 26.2+
- **Mobile especially critical**: INP > 300ms caused ~31% traffic drops on mobile in Dec 2025 update

---

## TIER 2: Important Ranking Signals (Direct, Moderate Impact)

### 2.1 Page Experience
- **Mobile-friendliness**: Mobile-first indexing is the default.
- **HTTPS**: Required for full trust signals.
- **No intrusive interstitials**: Pop-ups and overlays that block content hurt rankings.
- **Content above fold**: Content pushed below the fold by ads or other elements penalized.
- **Safe browsing**: No malware, deceptive content, or harmful downloads.

### 2.2 On-Page SEO
- **Title tags**: Accurate, descriptive, include primary keyword naturally.
- **Meta descriptions**: While not a direct ranking factor, affect CTR which signals relevance.
- **Heading structure**: H1-H6 hierarchy reflecting content organization.
- **Internal linking**: Clear site structure, contextual internal links help crawling and authority distribution.
- **URL structure**: Clean, descriptive URLs preferred.

### 2.3 Structured Data
- **Active types that generate rich results**: Article, Product, Review, LocalBusiness, Organization, Event, Recipe, JobPosting, BreadcrumbList (desktop), MemberProgram, Shipping/Returns
- **FAQ**: Only for authoritative government and health websites
- **HowTo**: Deprecated (no rich results since Sep 2023)
- **Deprecated (June 2025)**: Book Actions, Course Info, Claim Review, Estimated Salary, Learning Video, Special Announcement, Vehicle Listing
- **Deprecated (Jan 2026)**: Practice Problem, Nutrition Facts display, Nearby Offers display
- **Impact**: Structured data improves visibility in rich results and helps AI features extract information but is NOT a direct ranking factor for organic position.

### 2.4 Crawlability & Indexability
- **robots.txt**: Properly configured; blocks crawling but NOT indexing.
- **noindex**: Use for pages you want excluded from search results.
- **XML sitemap**: Up-to-date, submitted in Search Console.
- **Canonical tags**: Proper canonicalization to avoid duplicate content.
- **Crawl budget**: Efficient use — avoid crawling low-value pages.
- **robots.txt caching**: Google caches for up to 24 hours; use GSC for faster refresh.

---

## TIER 3: Supporting Signals (Indirect or Contextual)

### 3.1 User Engagement Signals
- **Click-through rate**: Relative CTR for position affects perceived relevance.
- **Dwell time / time on page**: Longer engagement suggests content satisfaction.
- **Bounce rate / pogo-sticking**: Users quickly returning to search results suggests poor match.

### 3.2 Site Architecture
- **Logical hierarchy**: Clear category/subcategory structure.
- **Flat architecture**: Important pages within 3-4 clicks of homepage.
- **Breadcrumb navigation**: Helps users and crawlers understand site structure.
- **App deep links**: iOS Universal Links and Android App Links for mobile visibility.

### 3.3 Domain Signals
- **Domain age**: Minor signal; established domains have slight advantage.
- **Domain history**: Clean history preferred; expired domain abuse is penalized.
- **Brand signals**: Brand searches, branded queries filter in GSC helps monitor.

### 3.4 Social Signals
- **Not a direct ranking factor** but social presence correlates with brand authority.
- **Search Console now tracks social channels** (Dec 2025) — unified view of search + social performance.

---

## AI SEARCH SIGNALS (AI Overviews & AI Mode)

### Citation Eligibility
- ~75% of sources cited in AI Overviews are already in organic Top 10.
- Strong traditional SEO is the foundation for AI citation.
- Long-tail content, structured data, and writing clarity boost AI citation chances.

### Content Characteristics for AI Citation
- **Clear, direct answers**: Concise responses to specific questions.
- **Well-structured content**: Headings, lists, tables that are easy for AI to parse.
- **Factual accuracy**: Verifiable claims with sources.
- **Comprehensive coverage**: Depth on the topic that AI can synthesize from.
- **Multimodal content**: Images, videos alongside text increase AI feature eligibility.

### AI Content Controls
- `nosnippet` meta tag: Prevents content from appearing in AI features.
- `max-snippet:[number]` meta tag: Limits length of content shown in AI features.
- `data-nosnippet` attribute: Blocks specific HTML elements from AI features.
- Standard SEO best practices remain the foundation — no special AI optimization needed.

### AI Search Traffic Characteristics
- CTR from AI Overviews is lower (61% drop) BUT conversion quality is 23x higher.
- AI Mode (conversational) provides citations but no organic links.
- AI search traffic projected to overtake traditional organic search by ~2028.

---

## SPAM DISQUALIFIERS (Automatic Ranking Penalties)

These will cause ranking suppression or removal:
1. **Scaled content abuse**: Mass-produced low-value content (AI or human) for rankings
2. **Site reputation abuse**: Hosting third-party content to exploit domain authority ("parasite SEO")
3. **Expired domain abuse**: Buying aged domains and filling with irrelevant content
4. **Link spam**: Paid links, link networks, excessive link exchanges
5. **Cloaking**: Different content for users vs. search engines
6. **Hidden text/links**: Content invisible to users but visible to crawlers
7. **Doorway pages**: Pages solely for funneling users elsewhere
8. **Scraped content**: Copied content without added value
9. **Keyword stuffing**: Unnatural keyword density
10. **Sneaky redirects**: Redirecting users to unexpected content

---

## SCORING CRITERIA FOR GEO AUDITS

When scoring a page or site for SEO health, evaluate against these categories:

### Content Score (Weight: 35%)
- [ ] Unique, non-commodity content with genuine expertise
- [ ] Clear author identification with credentials
- [ ] Matches search intent for target queries
- [ ] Comprehensive depth on the topic
- [ ] Fresh and up-to-date where recency matters
- [ ] Multimodal (text + images/video)
- [ ] No signs of scaled content abuse

### Technical Score (Weight: 25%)
- [ ] Core Web Vitals pass (LCP < 2.5s, INP < 200ms, CLS < 0.1)
- [ ] Mobile-friendly and responsive
- [ ] HTTPS enabled
- [ ] Proper robots.txt configuration
- [ ] XML sitemap present and submitted
- [ ] Clean URL structure with canonical tags
- [ ] No crawl errors or blocked resources
- [ ] Structured data implemented (active types only)

### Authority Score (Weight: 20%)
- [ ] Quality backlink profile (relevant, authoritative, diverse)
- [ ] Topical authority demonstrated across content cluster
- [ ] Brand signals present (branded queries, direct traffic)
- [ ] No spam or manipulative link patterns
- [ ] Citations from recognized sources

### Page Experience Score (Weight: 10%)
- [ ] No intrusive interstitials or pop-ups
- [ ] Content above fold (not pushed down by ads)
- [ ] Fast loading on mobile and desktop
- [ ] Safe browsing status clean
- [ ] Accessible to users with disabilities

### AI Readiness Score (Weight: 10%)
- [ ] Clear, direct answers to common questions
- [ ] Well-structured with headings, lists, tables
- [ ] Factually accurate and verifiable
- [ ] Proper metadata controls configured
- [ ] Rich results eligible (structured data implemented)

---

## QUICK REFERENCE: What Changed in the Last 12 Months

| Change | Date | Impact |
|--------|------|--------|
| CWV elevated to primary ranking signal | Dec 2025 | High — no longer tie-breaker |
| Authenticity score introduced | Dec 2025 | High — penalizes ranking-first content |
| E-E-A-T expanded to all queries | Dec 2025 | High — not just YMYL anymore |
| 7 structured data types deprecated | Jun 2025 | Medium — no ranking impact, visual only |
| AI Overviews at ~48% of queries | Mar 2026 | High — CTR down 61% where active |
| AI Mode launched globally | 2025-2026 | High — no organic links, citation only |
| Helpful Content merged into core | Mar 2025 | High — people-first content or drop |
| INP cross-browser measurement | Oct-Dec 2025 | Medium — Safari/Firefox users now count |
| Spam update (scaled content focus) | Aug 2025 | Medium — mass content penalized |
| Shipping/returns in Search Console | Nov 2025 | Low-Medium — e-commerce visibility |
| Loyalty program schema added | Jun 2025 | Low — new rich result type |
| Breadcrumbs removed from mobile | Jan 2025 | Low — visual change only |
| First Discover-only core update | Feb 2026 | Medium — affects Discover traffic only |
