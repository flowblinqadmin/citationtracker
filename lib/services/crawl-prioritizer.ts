/**
 * Crawl Structural Page Prioritization — ES-053 / C1
 *
 * Detects site architecture from discovered URLs + homepage nav,
 * classifies each URL into priority tiers (P0–P6), and selects
 * the most valuable pages for crawling within a page budget.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type PagePriorityTier = "P0" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6";

export type SiteArchitecture = {
  navPages: string[];
  structuralPages: string[];
  contentPages: string[];
  otherPages: string[];
};

export type PrioritizedUrl = {
  url: string;
  tier: PagePriorityTier;
  depth: number;
};

// ── Constants ────────────────────────────────────────────────────────────────

const TIER_ORDER: PagePriorityTier[] = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"];

const P0_PATTERNS = [/^\/$/, /^\/about(\/|$)/i, /^\/contact(\/|$)/i, /^\/team(\/|$)/i, /^\/pricing(\/|$)/i];
const P1_PATTERNS = [/^\/services(\/|$)/i, /^\/products(\/|$)/i, /^\/departments(\/|$)/i, /^\/specialties(\/|$)/i, /^\/solutions(\/|$)/i, /^\/features(\/|$)/i];
const P2_PATTERNS = [/^\/locations?(\/|$)/i, /^\/offices?(\/|$)/i, /^\/branches?(\/|$)/i];
const P4_PATTERNS = [/^\/faq(\/|$)/i, /^\/testimonials?(\/|$)/i, /^\/case-studies?(\/|$)/i, /^\/docs?(\/|$)/i, /^\/resources?(\/|$)/i];
const P5_PATTERNS = [/^\/blog(\/|$)/i, /^\/articles?(\/|$)/i, /^\/news(\/|$)/i, /^\/press(\/|$)/i];

const STRUCTURAL_PATTERNS = [...P1_PATTERNS, ...P2_PATTERNS];
const CONTENT_PATTERNS = P5_PATTERNS;

const BLOG_CAP_PERCENT = 0.30;

// ── Industry-specific boosts (→ P1) ─────────────────────────────────────────

const INDUSTRY_BOOSTS: Record<string, RegExp[]> = {
  healthcare: [/^\/departments?\//i, /^\/doctors?\//i, /^\/specialties?\//i, /^\/treatments?\//i],
  ecommerce: [/^\/products?\//i, /^\/categor(y|ies)\//i, /^\/collections?\//i, /^\/shop\//i],
  saas: [/^\/features?\//i, /^\/integrations?\//i, /^\/solutions?\//i, /^\/use-cases?\//i],
  software: [/^\/features?\//i, /^\/integrations?\//i, /^\/solutions?\//i, /^\/use-cases?\//i],
  education: [/^\/programs?\//i, /^\/courses?\//i, /^\/faculties?\//i, /^\/admissions?\//i],
  restaurant: [/^\/menu\//i, /^\/locations?\//i, /^\/catering\//i],
  food: [/^\/menu\//i, /^\/locations?\//i, /^\/catering\//i],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}

function getUrlDepth(url: string): number {
  const pathname = getPathname(url);
  return pathname.split("/").filter(Boolean).length;
}

function matchesAny(pathname: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(pathname));
}

function extractNavLinks(homepageContent: string, urls: string[]): string[] {
  // Extract href values from <nav> elements
  const navRegex = /<nav[^>]*>([\s\S]*?)<\/nav>/gi;
  const hrefRegex = /href=["']([^"']+)["']/gi;
  const navLinks: string[] = [];

  let navMatch;
  while ((navMatch = navRegex.exec(homepageContent)) !== null) {
    let hrefMatch;
    while ((hrefMatch = hrefRegex.exec(navMatch[1])) !== null) {
      navLinks.push(hrefMatch[1]);
    }
  }

  // Also check header/footer links
  const headerFooterRegex = /<(?:header|footer)[^>]*>([\s\S]*?)<\/(?:header|footer)>/gi;
  hrefRegex.lastIndex = 0; // reset — /g flag leaks lastIndex between loops
  let hfMatch;
  while ((hfMatch = headerFooterRegex.exec(homepageContent)) !== null) {
    hrefRegex.lastIndex = 0; // reset for each match
    let hrefMatch;
    while ((hrefMatch = hrefRegex.exec(hfMatch[1])) !== null) {
      navLinks.push(hrefMatch[1]);
    }
  }

  // Resolve relative links and match against discovered URLs
  const urlSet = new Set(urls);
  const resolvedNav: string[] = [];

  // All discovered URLs share a small set of origins (usually one). Derive the
  // distinct origins once (O(N) parses) instead of re-parsing every URL's origin
  // inside the per-link inner loop (which was O(navLinks × urls) URL constructions).
  const origins = [
    ...new Set(
      urls
        .map((url) => {
          try {
            return new URL(url).origin;
          } catch {
            return null;
          }
        })
        .filter((o): o is string => o !== null)
    ),
  ];

  for (const link of navLinks) {
    // Try to match as-is or as full URL
    if (urlSet.has(link)) {
      resolvedNav.push(link);
      continue;
    }
    // Try resolving relative paths against each distinct origin
    for (const origin of origins) {
      try {
        const resolved = new URL(link, origin).href;
        if (urlSet.has(resolved)) {
          resolvedNav.push(resolved);
          break;
        }
      } catch {
        // skip invalid
      }
    }
  }

  return [...new Set(resolvedNav)];
}

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Detect site architecture from discovered URLs + homepage crawl data.
 */
export function detectArchitecture(
  urls: string[],
  homepageContent?: string
): SiteArchitecture {
  const navPages = homepageContent ? extractNavLinks(homepageContent, urls) : [];
  const structuralPages: string[] = [];
  const contentPages: string[] = [];
  const otherPages: string[] = [];

  for (const url of urls) {
    const pathname = getPathname(url);
    if (matchesAny(pathname, STRUCTURAL_PATTERNS)) {
      structuralPages.push(url);
    } else if (matchesAny(pathname, CONTENT_PATTERNS)) {
      contentPages.push(url);
    } else if (!matchesAny(pathname, P0_PATTERNS)) {
      otherPages.push(url);
    }
  }

  return { navPages, structuralPages, contentPages, otherPages };
}

/**
 * Assign priority tier to each URL based on architecture + industry.
 */
export function classifyUrls(
  urls: string[],
  architecture: SiteArchitecture,
  industry?: string
): PrioritizedUrl[] {
  const navSet = new Set(architecture.navPages);
  const industryBoosts = industry
    ? Object.entries(INDUSTRY_BOOSTS)
        .filter(([key]) => industry.toLowerCase().includes(key))
        .flatMap(([, patterns]) => patterns)
    : [];

  return urls.map((url) => {
    const pathname = getPathname(url);
    const depth = getUrlDepth(url);

    let tier: PagePriorityTier;
    if (matchesAny(pathname, P0_PATTERNS)) {
      tier = "P0";
    } else if (matchesAny(pathname, P1_PATTERNS)) {
      tier = "P1";
    } else if (industryBoosts.length > 0 && matchesAny(pathname, industryBoosts)) {
      tier = "P1";
    } else if (matchesAny(pathname, P2_PATTERNS)) {
      tier = "P2";
    } else if (navSet.has(url)) {
      tier = "P3";
    } else if (matchesAny(pathname, P4_PATTERNS)) {
      tier = "P4";
    } else if (matchesAny(pathname, P5_PATTERNS)) {
      tier = "P5";
    } else {
      tier = "P6";
    }

    return { url, tier, depth };
  });
}

/**
 * Select top N URLs from prioritized set, respecting tier order and budget constraints.
 */
export function prioritizeUrls(
  urls: string[],
  architecture: SiteArchitecture,
  industry?: string,
  crawlLimit?: number
): string[] {
  if (urls.length === 0) return [];

  const limit = crawlLimit ?? urls.length;
  const classified = classifyUrls(urls, architecture, industry);

  // Sort: by tier order (P0 first), then by depth (shallower first)
  classified.sort((a, b) => {
    const tierDiff = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
    if (tierDiff !== 0) return tierDiff;
    return a.depth - b.depth;
  });

  const blogCap = Math.floor(limit * BLOG_CAP_PERCENT);
  const result: string[] = [];
  let blogCount = 0;

  for (const item of classified) {
    if (result.length >= limit) break;

    if (item.tier === "P5") {
      if (blogCount >= blogCap) continue;
      blogCount++;
    }

    result.push(item.url);
  }

  return result;
}
