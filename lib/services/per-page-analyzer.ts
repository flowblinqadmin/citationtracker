import type { CrawlData, CrawledPage } from "./geo-crawler";

// ── Types ──

export interface PerPageVulnerability {
  pillar: string;
  pillarName: string;
  severity: "critical" | "high" | "medium" | "low";
  finding: string;
  recommendation: string;
}

export interface PerPageResult {
  url: string;
  pageType: string;
  title: string;
  vulnerabilities: PerPageVulnerability[];
  overallPageHealth: "good" | "needs-work" | "poor";
}

// ── Pillar mapping ──

const PILLAR_NAMES: Record<string, string> = {
  semantic_html: "Semantic HTML",
  structured_data: "Structured Data",
  content_structure: "Content Structure",
  faq_coverage: "FAQ Coverage",
  contact_trust: "Contact & Trust Signals",
  author_authority: "Author Authority (E-E-A-T)",
  metadata_freshness: "Metadata & Freshness",
};

// ── Main function ──

export function extractPerPageVulnerabilities(
  crawlData: CrawlData,
  scorecard?: { pillars: Array<{ pillar: string; impactedPages?: string[] }> }
): PerPageResult[] {
  return crawlData.pages.map((page: CrawledPage) => {
    const vulns: PerPageVulnerability[] = [];

    // Rule 1a: Missing H1
    if (!page.h1 || page.h1.trim() === "") {
      vulns.push({
        pillar: "semantic_html",
        pillarName: PILLAR_NAMES.semantic_html,
        severity: "high",
        finding: "Page has no H1 heading.",
        recommendation: "Add a single, descriptive H1 that summarizes the page content.",
      });
    }
    // Rule 1b: Multiple H1s
    const h1Count = page.headings.filter((h) => h.level === 1).length;
    if (h1Count > 1) {
      vulns.push({
        pillar: "semantic_html",
        pillarName: PILLAR_NAMES.semantic_html,
        severity: "medium",
        finding: `Page has ${h1Count} H1 headings (should have exactly 1).`,
        recommendation: "Use a single H1 per page. Demote extras to H2 or lower.",
      });
    }

    // Rule 2: No structured data
    if (!page.hasStructuredData || page.existingSchema.length === 0) {
      vulns.push({
        pillar: "structured_data",
        pillarName: PILLAR_NAMES.structured_data,
        severity: "high",
        finding: "No JSON-LD structured data found.",
        recommendation: "Add JSON-LD schema markup (Article, FAQPage, Organization, etc.) for AI discoverability.",
      });
    }

    // Rule 3: Thin content
    if (page.content.length < 300) {
      vulns.push({
        pillar: "content_structure",
        pillarName: PILLAR_NAMES.content_structure,
        severity: page.content.length < 100 ? "critical" : "medium",
        finding: `Thin content: only ${page.content.length} characters (minimum 300 recommended).`,
        recommendation: "Expand page content with substantive, original text. Aim for 500+ characters.",
      });
    }

    // Rule 4: No FAQ on content pages
    const contentPageTypes = ["services", "pricing", "faq", "about"];
    if (contentPageTypes.includes(page.pageType) && page.faqContent.length === 0) {
      vulns.push({
        pillar: "faq_coverage",
        pillarName: PILLAR_NAMES.faq_coverage,
        severity: "medium",
        finding: `No FAQ content found on ${page.pageType} page.`,
        recommendation: "Add an FAQ section with questions users commonly ask about this topic.",
      });
    }

    // Rule 5: No contact info on key pages
    const trustPageTypes = ["homepage", "about", "contact", "services"];
    if (trustPageTypes.includes(page.pageType) && page.contactInfo.length === 0) {
      vulns.push({
        pillar: "contact_trust",
        pillarName: PILLAR_NAMES.contact_trust,
        severity: page.pageType === "contact" ? "critical" : "medium",
        finding: `No contact information found on ${page.pageType} page.`,
        recommendation: "Add email, phone, or physical address to establish trust signals.",
      });
    }

    // Rule 6: No author signals on content pages
    const authorPageTypes = ["blog", "case-studies", "docs"];
    if (authorPageTypes.includes(page.pageType)) {
      const hasAuthor =
        page.content.toLowerCase().includes("author") ||
        page.existingSchema.some((s) => s.includes("Person") || s.includes("Author"));
      if (!hasAuthor) {
        vulns.push({
          pillar: "author_authority",
          pillarName: PILLAR_NAMES.author_authority,
          severity: "medium",
          finding: "No author attribution found on content page.",
          recommendation: "Add author name, bio, and credentials to demonstrate E-E-A-T.",
        });
      }
    }

    // Rule 7: Missing title tag
    if (!page.title || page.title.trim() === "") {
      vulns.push({
        pillar: "metadata_freshness",
        pillarName: PILLAR_NAMES.metadata_freshness,
        severity: "critical",
        finding: "Page has no title tag.",
        recommendation: "Add a unique, descriptive <title> tag (50-60 characters).",
      });
    }

    // Rule 8: Correlate from scorecard impactedPages
    if (scorecard) {
      for (const pillarInfo of scorecard.pillars) {
        if (
          pillarInfo.impactedPages?.some(
            (p) => page.url.includes(p) || p.includes(page.url)
          )
        ) {
          if (!vulns.some((v) => v.pillar === pillarInfo.pillar)) {
            vulns.push({
              pillar: pillarInfo.pillar,
              pillarName: PILLAR_NAMES[pillarInfo.pillar] ?? pillarInfo.pillar,
              severity: "low",
              finding: `Flagged by site-level GEO analysis as impacted for ${PILLAR_NAMES[pillarInfo.pillar] ?? pillarInfo.pillar}.`,
              recommendation: "Review the site-level scorecard for specific recommendations.",
            });
          }
        }
      }
    }

    // Compute health
    const criticalCount = vulns.filter((v) => v.severity === "critical").length;
    const highCount = vulns.filter((v) => v.severity === "high").length;
    let overallPageHealth: "good" | "needs-work" | "poor";
    if (criticalCount > 0 || highCount >= 3) {
      overallPageHealth = "poor";
    } else if (highCount > 0 || vulns.length >= 3) {
      overallPageHealth = "needs-work";
    } else {
      overallPageHealth = "good";
    }

    return {
      url: page.url,
      pageType: page.pageType,
      title: page.title || "(untitled)",
      vulnerabilities: vulns,
      overallPageHealth,
    };
  });
}
