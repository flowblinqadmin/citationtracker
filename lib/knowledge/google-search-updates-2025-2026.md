# Google Search Updates: April 2025 - March 2026

Comprehensive knowledge document synthesized from Google Search Central Blog posts and related sources. Organized by topic for LLM reference.

Source: https://developers.google.com/search/blog
Last updated: March 2026

---

## 1. Core Algorithm Updates

### March 2025 Core Update
- **Dates**: March 13 - March 27, 2025 (14-day rollout)
- **Scope**: Global, all languages
- **Key changes**:
  - Helpful Content System fully integrated into core algorithm
  - Sharper focus on people-first content with real value, depth, and clarity
  - User-generated content (forums) lost some prominence in favor of expert/authoritative content
  - E-E-A-T signals elevated across all content types
  - Sites relying on shortcuts or low-effort content saw visibility drops
- **Source**: https://developers.google.com/search/docs/appearance/core-updates

### June 2025 Core Update
- **Dates**: June 30 - July 17, 2025 (16-day rollout)
- **Scope**: Global, all verticals — one of the most impactful updates in recent memory
- **Key changes**:
  - Emphasis on topical authority and E-E-A-T
  - Preparation for wider AI-driven features (AI Overviews)
  - Rise in zero-click results, reducing organic traffic to content-driven sites
  - Sites previously hurt by 2023 updates (September Core, Helpful Content, Reviews) saw substantial recoveries
  - Impacted rankings across news, health, finance, and shopping verticals
- **Source**: https://developers.google.com/search/docs/appearance/core-updates

### December 2025 Core Update
- **Dates**: December 11, 2025 - December 29, 2025 (18-day rollout)
- **Scope**: Global, all verticals
- **Key changes**:
  - Introduction of "authenticity score" evaluating whether content demonstrates genuine expertise vs. being created primarily for rankings
  - E-E-A-T requirements extended beyond YMYL to virtually all competitive queries (e-commerce, affiliate, SaaS, media)
  - Clear author identification with credentials became essentially mandatory for competitive queries
  - **Increased ranking weight of Core Web Vitals** — no longer just a tie-breaker; measurable ranking disadvantage for poor CWV, especially on mobile
  - Sites with LCP > 3 seconds experienced 23% more traffic loss; INP > 300ms caused ~31% drops on mobile
  - Impact rates: e-commerce 52%, health 67%, affiliate sites 71%
- **Source**: https://developers.google.com/search/docs/appearance/core-updates

### February 2026 Discover Core Update
- **Dates**: February 5 - February 26, 2026 (21-day rollout)
- **Scope**: Initially English-language users in the U.S.; expanding to all countries/languages
- **Significance**: First-ever Discover-only update (not affecting Search)
- **Key changes**:
  - More locally relevant content from websites based in user's country
  - Reduced sensational content and clickbait in Discover
  - More in-depth, original, and timely content from sites with demonstrated expertise
- **Source**: https://developers.google.com/search/blog/2026/02/discover-core-update

### August 2025 Spam Update
- **Dates**: August 26 - September 22, 2025 (26-day rollout)
- **Scope**: All languages worldwide
- **Focus areas**:
  - **Scaled content abuse**: Mass-produced low-value pages targeting AI search rankings
  - **Site reputation abuse** ("parasite SEO"): Third-party content placed on established sites to exploit ranking signals
  - **Expired domain abuse**: Buying aged domains and filling with irrelevant content
  - **Link spam**: Tighter scrutiny on link networks selling backlinks
- **Source**: https://developers.google.com/search/docs/appearance/spam-updates

---

## 2. Structured Data / Schema Changes

### Search Results Simplification — Phase 1 (June 2025)
- **Date**: June 12, 2025
- **Seven structured data types deprecated**:
  1. Book Actions
  2. Course Info / Course Listings
  3. Claim Review (Fact Check)
  4. Estimated Salary
  5. Learning Video
  6. Special Announcement
  7. Vehicle Listing / Automotive Listings
- **Reason**: Low adoption, high complexity, limited user value
- **Impact on rankings**: None — this does not affect how pages are ranked
- **Source**: https://developers.google.com/search/blog/2025/06/simplifying-search-results

### Search Results Simplification — Phase 2 (November 2025)
- **Effective**: January 2026
- **Additional removals**:
  - Practice Problem structured data
  - Nutrition facts display
  - Nearby offers display
  - Dataset markup clarified as serving only Google Dataset Search, not general Search
- **Search Console API**: Support for deprecated types removed January 2026
- **Source**: https://developers.google.com/search/blog/2025/11/update-on-our-efforts

### Loyalty Program Markup (June 2025)
- **Date**: June 10, 2025
- **New schema types**: `MemberProgram` nested under `Organization`, with `validForMemberTier` and `MembershipPointsEarned`
- **Availability**: Australia, Brazil, Canada, France, Germany, Mexico, UK, US (desktop + mobile)
- **Implementation**: Add under Organization structured data; works alongside Merchant Center (MC takes priority if configured)
- **Source**: https://developers.google.com/search/blog/2025/06/loyalty-program

### Shipping & Returns Policy Markup (November 2025)
- **Date**: November 12, 2025
- **Two new methods**:
  1. **Search Console configuration**: Directly configure policies in GSC (no Merchant Center needed); settings take precedence over markup
  2. **Organization-level structured data**: Site-wide shipping policy markup (complements existing organization-level return policies)
- **Key benefit**: One site-wide policy instead of per-product markup; product-level markup still takes priority for specific items
- **Source**: https://developers.google.com/search/blog/2025/11/more-ways-to-share-shipping

### Mobile Breadcrumb Simplification (January 2025)
- **Date**: January 23, 2025
- **Change**: Breadcrumbs removed from mobile search results; mobile shows domain only
- **Desktop**: Unchanged (still shows domain + breadcrumb)
- **Action needed**: None — BreadcrumbList schema still read by crawlers, still valuable for site hierarchy understanding
- **Source**: https://developers.google.com/search/blog/2025/01/simplifying-breadcrumbs

### Still-Active Structured Data Types (as of March 2026)
Structured data that Google still actively supports and generates rich results for:
- Article, Product, Review, LocalBusiness, Organization
- FAQ (limited to authoritative government and health websites only)
- BreadcrumbList (desktop only for display)
- Event, Recipe, JobPosting
- MemberProgram (loyalty), Shipping/Returns
- Store widget integration
- **HowTo**: Deprecated (no longer shown on desktop since September 2023)

---

## 3. AI Overviews / AI Search Features

### AI Overviews Expansion
- **Coverage**: ~48% of all search queries as of March 2026 (up from ~16% in late 2025)
- **CTR impact**: Organic CTR dropped 61% (1.76% to 0.61%) for queries triggering AI Overviews
- **Conversion quality**: Visitors from AI Overview-affected queries convert at 23x the rate of standard search visitors
- **Volatile**: July 2025 peak at ~25%, fell to <16% by November 2025, surged again
- **Source**: Various industry studies (Semrush, Seer Interactive)

### AI Mode Launch (May 2025)
- **Built on**: Gemini 2.5 (upgraded to Gemini 3 on January 27, 2026)
- **Availability**: Launched broadly in US May 2025; 180+ countries by end of 2025; 200+ countries by March 2026
- **How it works**: "Query fan-out" technology — analyzes intent, generates multiple related queries, searches simultaneously (up to 16 searches), synthesizes across sources
- **Deep Search**: Can issue hundreds of searches and create expert-level cited reports
- **Key difference from AI Overviews**: AI Mode has NO traditional 10 blue links — purely conversational with citations
- **SEO impact**: Either you get cited or you don't; ~75% of cited sources were already in organic Top 10

### Google's Official AI Search Guidance (May 2025)
Eight recommendations from Google for succeeding in AI search experiences:
1. **Understand visit value**: Clicks from AI search are higher quality — users spend more time on site
2. **Focus on unique, valuable content**: Users ask longer, more specific questions with follow-ups
3. **Ensure good page experience**: Fast loading, cross-device display, clear content hierarchy
4. **Go multimodal**: High-quality images and videos; keep Merchant Center and GBP updated
5. **Meet technical requirements**: Ensure pages are findable, crawlable, indexable
6. **Use metadata controls**: `nosnippet` and `max-snippet` apply to AI content too
7. **No special AI optimization needed**: Standard SEO best practices remain the foundation
8. **E-E-A-T matters**: Firsthand experience signals more important than ever
- **Source**: https://developers.google.com/search/blog/2025/05/succeeding-in-ai-search

### Search Live (March 2026)
- Google launched Search Live globally — real-time conversational search across 200+ countries
- **Source**: TechCrunch, March 26, 2026

---

## 4. Crawling and Indexing Changes

### Robots Refresher Series (February-March 2025)
Four-part series from Google Search Relations team:

**Part 1 — Introduction** (February 2025)
- Series overview on the Robots Exclusion Protocol (REP)
- **Source**: https://developers.google.com/search/blog/2025/02/intro-robots-refresher

**Part 2 — robots.txt Basics** (March 2025)
- robots.txt manages crawler access to URLs; primarily for avoiding server overload
- **Critical distinction**: robots.txt prevents crawling, NOT indexing; blocked URLs can still appear in search if linked elsewhere
- Google caches robots.txt for up to 24 hours; faster recrawl via robots.txt report in GSC
- Allow + Disallow directives for fine-grained control
- **Source**: https://developers.google.com/search/blog/2025/03/robotstxt-flexible-way-to-control

**Part 3 — Page-Level Granularity** (March 2025)
- robots.txt, robots meta tags, and X-Robots-Tag HTTP headers form the full REP
- Page-level instructions only work if crawling is not blocked by robots.txt
- Use `noindex` for hiding pages from search (not robots.txt)
- **Source**: https://developers.google.com/search/blog/2025/03/robots-refresher-page-level

**Part 4 — Future-Proofing** (March 2025)
- REP became a standard in 2022 (RFC 9309)
- Excellent candidate for carrying new AI crawler preferences due to wide adoption
- Most AI crawlers follow REP; if robots.txt allows all bots, AI crawlers will crawl
- No single entity can change the standard unilaterally — consensus-driven process
- Google open-sourced its robots.txt parser
- **Source**: https://developers.google.com/search/blog/2025/03/robots-future

### App Deep Links (May 2025)
- Google emphasized importance of app deep links for mobile visibility
- iOS Universal Links and Android App Links both supported in Google Search
- Search Console includes Android app deep link performance data
- Firebase Dynamic Links shutting down August 2025 — migrate to native deep links
- **Source**: https://developers.google.com/search/blog/2025/05/app-deep-links

---

## 5. Core Web Vitals / Page Experience

### Current Core Web Vitals (as of March 2026)
| Metric | What It Measures | Good Threshold |
|--------|-----------------|----------------|
| **LCP** (Largest Contentful Paint) | Loading performance | < 2.5 seconds |
| **INP** (Interaction to Next Paint) | Responsiveness | < 200 milliseconds |
| **CLS** (Cumulative Layout Shift) | Visual stability | < 0.1 |

### Key Changes in 2025-2026
- **INP replaced FID** as a Core Web Vital in March 2024; 43% of sites fail the 200ms threshold in 2026
- **Cross-browser measurement**: Firefox 144 (October 2025) and Safari 26.2 (December 2025) added INP support — no longer Chrome-only
- **December 2025 core update increased CWV ranking weight**: No longer just a tie-breaker; sites with poor CWV now face measurable ranking disadvantage, especially mobile
- **Visual Stability Index (VSI)**: New metric introduced early 2026 measuring layout stability throughout entire user session (not just initial load) — "Core Web Vitals 2.0"
- Only 47% of sites reach Google's "good" thresholds overall in 2026

### Ranking Impact
- LCP > 3 seconds: ~23% more traffic loss vs faster competitors with similar content
- INP > 300ms: ~31% traffic drops, particularly on mobile
- Sites with intrusive ads, slow-loading elements, or content pushed below fold saw disproportionate ranking losses in December 2025 update

---

## 6. Link and Content Quality Signals

### Content Quality (2025-2026 State)
- **Authenticity score**: Google evaluates whether content shows genuine expertise vs. being created for rankings
- **E-E-A-T expanded**: Now applies to virtually all competitive queries, not just YMYL
- **Author identification**: Clear author credentials essentially mandatory for competitive queries
- **People-first content**: Helpful Content System fully merged into core algorithm (March 2025)
- **Search intent matching**: Google prioritizes intent alignment more heavily than ever
- **User satisfaction**: Google evaluates whether users feel fully satisfied after reading or need to continue searching

### Backlinks (2025-2026 State)
- Quality over quantity: Judged by trustworthiness, contextual alignment, and relevance
- Topical authority and audience overlap matter more than raw volume
- Link networks under tighter scrutiny (August 2025 spam update)
- Spammy link effects are simply removed; lost ranking benefits cannot be regained

### AI-Generated Content
- Google targets mass-produced AI content as "scaled content abuse"
- AI content created for ranking purposes (not user value) specifically targeted
- Quality AI content with genuine value is not inherently penalized
- Human oversight and editing of AI content remains a best practice

---

## 7. Spam and Abuse Policies

### Active Spam Policies (as of March 2026)
1. **Scaled Content Abuse**: Mass-produced low-value content (AI or human) created solely for rankings
2. **Site Reputation Abuse** ("Parasite SEO"): Third-party content on established sites exploiting host domain authority
3. **Expired Domain Abuse**: Buying aged domains and filling with irrelevant content to pass authority
4. **Link Spam**: Link networks, paid links, excessive link exchanges
5. **Cloaking**: Showing different content to users vs. search engines
6. **Hidden Text/Links**: Content invisible to users but visible to crawlers
7. **Doorway Pages**: Pages created to funnel users to a different destination
8. **Scraped Content**: Content copied from other sources without added value

### August 2025 Spam Update Specifics
- 26-day rollout (Aug 26 - Sep 22, 2025)
- All languages worldwide
- Focus: scaled/thin content, expired domain abuse, site reputation abuse, link spam
- Overall impact described as "muted" with some sites seeing sharp declines in first 24 hours

---

## 8. New Search Features and Tools

### Search Console Enhancements

**Hourly Data in Search Analytics API** (April 2025)
- New `HOUR` dimension and `HOURLY_ALL` data state
- Returns data for up to 10 days with hourly breakdown (UI only shows 24 hours)
- **Source**: https://developers.google.com/search/blog/2025/04/san-hourly-data

**Search Console Insights Report Refresh** (June 2025)
- Revamped insights report with improved data visualization
- **Source**: https://developers.google.com/search/blog/2025/06/search-console-insights

**Google Trends API Alpha** (July 2025)
- Programmatic access to Google Trends data (rolling 1800-day window)
- Daily, weekly, monthly, yearly aggregations
- Compare dozens of terms (vs. 5 on website)
- Region/subregion breakdowns (ISO 3166-2)
- **Source**: https://developers.google.com/search/blog/2025/07/trends-api

**Store Widget** (September 2025)
- Embeddable widget showing store ratings, shipping/returns info, reviews on merchant websites
- Available via Merchant Center (copy-paste code snippet)
- Businesses using widget saw up to 8% higher sales within 90 days
- **Source**: https://developers.google.com/search/blog/2025/09/store-widget

**Query Groups in Insights** (October 2025)
- AI-powered grouping of similar search queries (variations, misspellings, different languages)
- Shows Top, Trending Up, and Trending Down groups
- Available for high-volume properties only
- **Source**: https://developers.google.com/search/blog/2025/10/search-console-query-groups

**Branded Queries Filter** (November 2025)
- Automatically differentiates branded vs. non-branded queries in Performance report
- Available to all eligible sites as of March 11, 2026
- **Source**: https://developers.google.com/search/blog/2025/11/search-console-branded-filter

**Custom Chart Annotations** (November 2025)
- Add contextual notes directly to performance charts (mark algorithm updates, content changes, etc.)
- **Source**: https://developers.google.com/search/blog/2025/11/custom-chart-annotations

**Weekly and Monthly Views** (December 2025)
- Aggregate performance data by week or month in Performance report
- Reduces noise from daily fluctuations; reveals seasonal patterns
- **Source**: https://developers.google.com/search/blog/2025/12/weekly-monthly-views-search-console

**Social Channels** (December 2025)
- Unified view of search performance across website and social media channels
- Expanded Insights report to include social channel performance data
- **Source**: https://developers.google.com/search/blog/2025/12/social-channels-search-console

**AI-Powered Configuration** (December 2025)
- Natural language interface for Performance report analysis
- Describe the analysis you want in plain language; AI configures filters and comparisons
- **Source**: https://developers.google.com/search/blog/2025/12/ai-powered-configuration

---

## 9. Recommendations for Site Owners

### Content Strategy
1. **Demonstrate genuine expertise**: Create content from real experience; the "authenticity score" penalizes content created primarily for rankings
2. **Author attribution**: Include clear author bios with credentials on all content
3. **Unique, non-commodity content**: Generic, repetitive, or incomplete content performs poorly regardless of technical optimization
4. **Match search intent**: Understand and satisfy the specific intent behind queries
5. **Go multimodal**: Include high-quality images and videos alongside text
6. **Longer-form, deeper content**: AI search users ask more specific, complex questions

### Technical SEO
1. **Core Web Vitals are ranking factors**: LCP < 2.5s, INP < 200ms, CLS < 0.1 — especially critical on mobile
2. **Mobile-first**: Ensure excellent mobile experience; breadcrumbs no longer shown on mobile
3. **Structured data**: Implement active types (Article, Product, Review, Organization, etc.); remove deprecated types to reduce noise
4. **Crawlability**: Proper robots.txt, use noindex for pages to hide (not robots.txt block), ensure all important pages are crawlable
5. **App deep links**: Configure iOS Universal Links and Android App Links if you have apps
6. **Page experience**: No intrusive ads, content above fold, fast-loading elements

### For E-Commerce Sites
1. **Store widget**: Embed Google store widget for ratings and trust signals (up to 8% sales lift)
2. **Shipping/returns**: Configure policies in Search Console or via organization-level structured data
3. **Loyalty programs**: Implement MemberProgram schema under Organization
4. **Merchant Center**: Keep updated for AI feature eligibility

### AI Search Optimization
1. **No special optimization needed**: Standard SEO best practices are the foundation
2. **Be citation-worthy**: ~75% of AI Overview citations come from pages already in organic Top 10
3. **Structured content**: Clear headings, concise answers, well-organized information helps AI extraction
4. **Control with metadata**: Use `nosnippet` and `max-snippet` to control AI content usage
5. **Monitor impact**: Track AI Overview appearance for your queries; CTR may drop but conversion quality may increase

### Spam Avoidance
1. **No scaled content abuse**: Avoid mass-producing content (AI or human) solely for rankings
2. **No site reputation abuse**: Don't host third-party content to exploit domain authority
3. **No expired domain abuse**: Don't buy aged domains to redirect authority
4. **Natural link building**: Avoid link networks, paid links, excessive exchanges
5. **Quality AI content is fine**: AI-assisted content with genuine value and human oversight is not penalized

---

## Complete Blog Post Index (April 2025 - March 2026)

| Date | Title | URL |
|------|-------|-----|
| Mar 2026 | Search Central Live is coming to Canada | https://developers.google.com/search/blog/2026/03/scl-canada-2026 |
| Mar 2026 | Search Central Live Asia Pacific 2026 | https://developers.google.com/search/blog/2026/03/scl-apac-2026 |
| Feb 2026 | Google's February 2026 Discover core update | https://developers.google.com/search/blog/2026/02/discover-core-update |
| Jan 2026 | Search Central Live South America | https://developers.google.com/search/blog/2026/01/search-central-live-brasil-argentina |
| Dec 2025 | Search Central Live APAC 2025 Recap | https://developers.google.com/search/blog/2025/12/scl-eoy |
| Dec 2025 | Weekly and monthly views in Search Console | https://developers.google.com/search/blog/2025/12/weekly-monthly-views-search-console |
| Dec 2025 | Social channels in Search Console | https://developers.google.com/search/blog/2025/12/social-channels-search-console |
| Dec 2025 | AI-powered configuration in Search Console | https://developers.google.com/search/blog/2025/12/ai-powered-configuration |
| Nov 2025 | Branded queries filter in Search Console | https://developers.google.com/search/blog/2025/11/search-console-branded-filter |
| Nov 2025 | Custom chart annotations in Search Console | https://developers.google.com/search/blog/2025/11/custom-chart-annotations |
| Nov 2025 | More ways to share shipping and returns | https://developers.google.com/search/blog/2025/11/more-ways-to-share-shipping |
| Nov 2025 | Search Central Live Zurich | https://developers.google.com/search/blog/2025/11/search-central-live-zurich-is-back |
| Nov 2025 | Update on simplifying search results page | https://developers.google.com/search/blog/2025/11/update-on-our-efforts |
| Oct 2025 | Query groups in Search Console Insights | https://developers.google.com/search/blog/2025/10/search-console-query-groups |
| Sep 2025 | Search Central Live Dubai | https://developers.google.com/search/blog/2025/09/scl-dubai |
| Sep 2025 | Store widget announcement | https://developers.google.com/search/blog/2025/09/store-widget |
| Sep 2025 | Search Central Live Tokyo | https://developers.google.com/search/blog/2025/09/scl-tok |
| Sep 2025 | Search Central Live Hong Kong | https://developers.google.com/search/blog/2025/09/scl-hkk |
| Aug 2025 | Search Central Live Mexico City | https://developers.google.com/search/blog/2025/08/search-central-live-mexico-2025 |
| Jul 2025 | Google Trends API (alpha) | https://developers.google.com/search/blog/2025/07/trends-api |
| Jun 2025 | Search Console Insights report refresh | https://developers.google.com/search/blog/2025/06/search-console-insights |
| Jun 2025 | SCL Deep Dive APAC 2025 | https://developers.google.com/search/blog/2025/06/scl-dd-apac-2025-news |
| Jun 2025 | Simplifying the search results page | https://developers.google.com/search/blog/2025/06/simplifying-search-results |
| Jun 2025 | Loyalty program markup support | https://developers.google.com/search/blog/2025/06/loyalty-program |
| May 2025 | Succeeding in AI search experiences | https://developers.google.com/search/blog/2025/05/succeeding-in-ai-search |
| May 2025 | App deep links | https://developers.google.com/search/blog/2025/05/app-deep-links |
| Apr 2025 | Search Central Live Deep Dive 2025 | https://developers.google.com/search/blog/2025/04/search-central-live-deep-dive-2025 |
| Apr 2025 | Search Analytics API hourly data | https://developers.google.com/search/blog/2025/04/san-hourly-data |
