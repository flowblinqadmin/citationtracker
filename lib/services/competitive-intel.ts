import OpenAI from "openai";
import type { CrawlData } from "./geo-crawler";
import { classifyIndustry, type GroundTruthIndustry } from "./industry-classifier";

export type { GroundTruthIndustry };

export interface CompetitorGeoStatus {
  domain: string;
  hasLlmsTxt: boolean;
  hasUcp: boolean;
  hasStructuredData: boolean;
}

export interface CompetitiveIntel {
  topCompetitors: string[];
  brandPerception: string;
  competitivePosition: string;
  competitorGeoStatus: CompetitorGeoStatus[];
  industryContext: string;
  groundTruthIndustry: GroundTruthIndustry;
}

function getPerplexityClient() {
  return new OpenAI({
    baseURL: "https://api.perplexity.ai",
    apiKey: process.env.PERPLEXITY_API_KEY!,
  });
}

const SYSTEM_PROMPT = `# Role
You are a competitive intelligence analyst. Report ONLY what you can verify from search results. If you cannot find real evidence for a field, say "Insufficient data" — never fabricate.

<task>
Return competitive intelligence for the company described below as a single JSON object.
</task>

<output_format>
Return ONLY valid JSON. No prose. No markdown. No code fences.

{
  "competitors": [
    { "domain": "competitor1.com", "basis": "Why this is a direct competitor in 1 phrase" },
    { "domain": "competitor2.com", "basis": "Why this is a direct competitor in 1 phrase" }
  ],
  "brandPerception": {
    "summary": "1-2 sentences on what the company is known for",
    "confidence": "high | medium | low"
  },
  "competitivePosition": {
    "summary": "1-2 sentences on how the company compares to the named competitors",
    "confidence": "high | medium | low"
  }
}
</output_format>

<rules>
- competitors: list 3-5 direct competitor domains based strictly on what the company offers — not on domain name or brand name similarity
- If you cannot identify 3 competitors with confidence, return fewer rather than guessing
- brandPerception: base ONLY on verifiable customer reviews, press coverage, or market reports you can find. If you cannot find real evidence, set confidence to "low" and say what you can verify
- competitivePosition: compare ONLY on dimensions where you have evidence (pricing, features, market segment). Do NOT fabricate strengths/weaknesses you cannot verify
- Do NOT infer what a company does from its domain name — use only the provided description and what you find in search results
</rules>`;

async function checkGeoStatus(domain: string): Promise<CompetitorGeoStatus> {
  const base = "https://" + domain;
  const chk = async (url: string) => {
    try {
      const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      return r.status === 200;
    } catch { return false; }
  };
  const [hasLlmsTxt, hasUcp, hasSd] = await Promise.all([
    chk(base + "/llms.txt"),
    chk(base + "/.well-known/ucp"),
    fetch(base, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.text())
      .then((html) => html.includes("ld+json"))
      .catch(() => false),
  ]);
  return { domain, hasLlmsTxt, hasUcp, hasStructuredData: hasSd };
}

function extractDomains(text: string): string[] {
  const pattern = /([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/g;
  const common = new Set(["example.com", "google.com", "amazon.com", "wikipedia.org"]);
  const found: string[] = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const d = m[1].toLowerCase();
    if (!common.has(d) && !found.includes(d) && found.length < 5) found.push(d);
  }
  return found;
}

/** Validate domain is a safe RFC hostname — no special chars that could inject into prompts */
function assertSafeDomain(domain: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-\.]{0,252}[a-zA-Z0-9]$/.test(domain)) {
    throw new Error(`[competitive-intel] Unsafe domain rejected: ${domain}`);
  }
}

export async function gatherCompetitiveIntel(
  domain: string,
  businessDescription: string,
  crawlData: CrawlData
): Promise<CompetitiveIntel> {
  assertSafeDomain(domain);
  const desc = businessDescription.substring(0, 400);
  const userPrompt =
    `<context>\n` +
    `Company domain: ${domain}\n` +
    `What they offer: "${desc}"\n` +
    `</context>\n\n` +
    `Return competitive intelligence for the company above as a single JSON object.`;

  const res = await getPerplexityClient().chat.completions.create({
    model: "sonar",
    temperature: 0.1,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
    max_completion_tokens: 600,
  });

  const raw = (res.choices[0]?.message?.content ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let competitorDomains: string[] = [];
  let brandPerception = "";
  let competitivePosition = "";

  try {
    const parsed = JSON.parse(raw) as {
      competitors?: Array<{ domain?: string; basis?: string } | string>;
      brandPerception?: { summary?: string; confidence?: string } | string;
      competitivePosition?: { summary?: string; confidence?: string } | string;
    };

    // competitors: handle both new [{domain, basis}] and old [string] formats
    if (Array.isArray(parsed.competitors)) {
      competitorDomains = parsed.competitors
        .map(c => (typeof c === "string" ? c : c.domain ?? ""))
        .filter(d => typeof d === "string" && d.length > 0)
        .slice(0, 5);
    }

    // brandPerception: handle both new {summary, confidence} and old string
    const bp = parsed.brandPerception;
    brandPerception = typeof bp === "string" ? bp : (bp?.summary ?? "");

    // competitivePosition: handle both new {summary, confidence} and old string
    const cp = parsed.competitivePosition;
    competitivePosition = typeof cp === "string" ? cp : (cp?.summary ?? "");
  } catch {
    // Fallback: extract domains from raw text if JSON parse fails
    console.warn("[competitive-intel] JSON parse failed, falling back to domain extraction");
    competitorDomains = extractDomains(raw);
    brandPerception = raw.substring(0, 200);
    competitivePosition = "";
  }

  const [competitorGeoStatus, groundTruthIndustry] = await Promise.all([
    Promise.all(competitorDomains.slice(0, 3).map(checkGeoStatus)),
    Promise.resolve(classifyIndustry(crawlData)),
  ]);

  return {
    topCompetitors: competitorDomains,
    brandPerception,
    competitivePosition,
    competitorGeoStatus,
    industryContext: businessDescription.substring(0, 300),
    groundTruthIndustry,
  };
}
