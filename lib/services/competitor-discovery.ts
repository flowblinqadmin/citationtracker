import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { type GeoSite } from "@/lib/db/schema";
import { type DiscoveredCompetitor } from "@/lib/types/citation";
import { humanizeDomainToBrand, looksLikeDomainStem } from "@/lib/services/brand-detector";
import { getGoogleGenAIKey } from "@/lib/google-genai-key";

const TIMEOUT_MS = 30_000;

// ── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `# Role
You are a competitive intelligence analyst. Identify companies that compete directly for the same customers and use cases as the queried business.

<rules>
- Ground every answer in what the company offers (provided in the query). Do NOT infer competitors from the domain name or brand name similarity.
- "Direct" competitor = sells the same product/service type to the same buyer.
- Always include the primary domain for each competitor.
- For each competitor, include ONE verifiable fact (e.g. "founded 2019", "YC-backed", "serves enterprise e-commerce", "offers free tier"). This must be something you are confident is true. If unsure, write "unverified".
- Do NOT include the queried company itself, or infrastructure/platform companies (Google, AWS, GitHub, Wikipedia, Shopify — unless they compete directly on the exact same product type).
- Name actual companies — never give generic category descriptions in place of a company name.
- If you can confidently identify fewer than 5, return fewer. Do NOT pad the list with guesses.
</rules>

<output_format>
Return ONLY valid JSON. No prose. No markdown. No code fences.

[
  {
    "domain": "competitor.com",
    "name": "Competitor Inc",
    "basis": "Same buyer persona and use case — both sell X to Y buyers",
    "fact": "YC W22 batch, Series A in 2023"
  },
  {
    "domain": "another.com",
    "name": "Another Tool",
    "basis": "Direct alternative for same workflow",
    "fact": "unverified"
  }
]
</output_format>`;

// ── Discovery prompts ─────────────────────────────────────────────────────

function buildDiscoveryPrompts(
  domain: string,
  siteType: string | null,
  executiveSummary: string | null,
  crawledDescription: string | null,
  excludeNames?: string[],
): Array<{ system: string; user: string }> {
  // Use crawled content as primary grounding — more reliable than executiveSummary
  // which can be poisoned by LLM confusion with similarly-named companies.
  const groundingText = (crawledDescription ?? executiveSummary ?? "").slice(0, 300);
  // Derive category from grounding text if siteType is empty — don't default to "software tool"
  const category = siteType || (groundingText ? groundingText.split(/[.!?]/)[0]?.trim().slice(0, 80) || "business" : "business");

  // Derive a natural-language use case from the grounding text (first sentence) or category
  const useCase = groundingText
    ? groundingText.split(/[.!?]/)[0]?.trim() || category
    : category;

  const description = groundingText.slice(0, 150);

  const systemPrompt = excludeNames?.length
    ? `${SYSTEM_PROMPT}\n\nDo NOT include these companies: ${excludeNames.join(", ")}`
    : SYSTEM_PROMPT;

  return [
    {
      system: systemPrompt,
      user:
        `<company>\n${domain} — ${description}\nCategory: ${category}\nPrimary use case: ${useCase}\n</company>\n\n` +
        `What are the top direct alternatives to ${domain} for this exact use case? ` +
        `These are companies a buyer would evaluate side-by-side with ${domain}. ` +
        `Rank by how frequently buyers compare them.`,
    },
    {
      system: systemPrompt,
      user:
        `<company>\n${domain} — ${description}\nCategory: ${category}\nPrimary use case: ${useCase}\n</company>\n\n` +
        `If a buyer evaluates ${domain} and decides against it, what are the most likely alternatives they switch to instead? ` +
        `These may be slightly different products that solve the same underlying problem. ` +
        `Rank by frequency of substitution.`,
    },
  ];
}

// ── Provider query ────────────────────────────────────────────────────────
// Use Perplexity first (real-time search), then OpenAI, Google, Haiku for best results.

/** Thrown when at least one provider was configured but every attempt failed at
 *  runtime (timeout, rate limit, auth, empty response). Distinct from
 *  `no_providers_configured`, which means no API keys are present at all. */
export class AllProvidersFailedError extends Error {
  constructor(failures: string[]) {
    super(`all_providers_failed: ${failures.join("; ")}`);
    this.name = "AllProvidersFailedError";
  }
}

/** Compact one-line description of a provider failure, including HTTP status when
 *  the SDK surfaces one (OpenAI/Anthropic attach `.status` to API errors). */
function describeProviderFailure(name: string, err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  return status != null ? `${name} [${status}]: ${message}` : `${name}: ${message}`;
}

async function queryForDiscovery(prompt: { system: string; user: string }): Promise<string> {
  let providersConfigured = 0;
  const failures: string[] = [];

  if (process.env.PERPLEXITY_API_KEY) {
    providersConfigured++;
    try {
      const client = new OpenAI({ apiKey: process.env.PERPLEXITY_API_KEY, baseURL: "https://api.perplexity.ai" });
      const res = await Promise.race([
        client.chat.completions.create({ model: "sonar", max_tokens: 300, stream: false as const, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }] }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
      ]);
      const text = res.choices[0]?.message?.content ?? "";
      if (text) return text;
      failures.push("perplexity: empty response");
    } catch (err) {
      const failure = describeProviderFailure("perplexity", err);
      console.warn(`[competitor-discovery] provider failed — ${failure}`);
      failures.push(failure);
    }
  }
  if (process.env.OPENAI_API_KEY) {
    providersConfigured++;
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const res = await Promise.race([
        client.chat.completions.create({ model: "gpt-5.4-mini", max_completion_tokens: 300, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }] }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
      ]);
      const text = res.choices[0]?.message?.content ?? "";
      if (text) return text;
      failures.push("openai: empty response");
    } catch (err) {
      const failure = describeProviderFailure("openai", err);
      console.warn(`[competitor-discovery] provider failed — ${failure}`);
      failures.push(failure);
    }
  }
  if (process.env.GEMINI_API_KEY) {
    providersConfigured++;
    try {
      const client = new GoogleGenerativeAI(getGoogleGenAIKey());
      // gemini-3.5-flash (not flash-lite): flash-lite hallucinates brand names on
      // unknown companies — matches citation-checker's model choice.
      const model = client.getGenerativeModel({ model: "gemini-3.5-flash", systemInstruction: prompt.system });
      const res = await Promise.race([
        model.generateContent(prompt.user),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
      ]);
      const text = res.response.text();
      if (text) return text;
      failures.push("gemini: empty response");
    } catch (err) {
      const failure = describeProviderFailure("gemini", err);
      console.warn(`[competitor-discovery] provider failed — ${failure}`);
      failures.push(failure);
    }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providersConfigured++;
    try {
      const client = new Anthropic();
      const res = await Promise.race([
        client.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 300, system: prompt.system, messages: [{ role: "user", content: prompt.user }] }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
      ]);
      const text = res.content.filter(b => b.type === "text").map(b => (b as { type: "text"; text: string }).text).join("");
      if (text) return text;
      failures.push("anthropic: empty response");
    } catch (err) {
      const failure = describeProviderFailure("anthropic", err);
      console.warn(`[competitor-discovery] provider failed — ${failure}`);
      failures.push(failure);
    }
  }

  // No keys at all vs. every configured provider failing at runtime are different
  // operational problems — surface them as distinct errors instead of one
  // misleading "no_providers_configured".
  if (providersConfigured === 0) {
    throw new Error("no_providers_configured");
  }
  throw new AllProvidersFailedError(failures);
}

// ── JSON extraction ────────────────────────────────────────────────────────
// Parse JSON arrays returned by the updated system prompt.
// Falls back to regex extraction if JSON parsing fails for all responses.

const NON_COMPETITOR_DOMAINS = new Set([
  "google.com", "bing.com", "yahoo.com", "duckduckgo.com",
  "github.com", "gitlab.com", "stackoverflow.com", "wikipedia.org", "wikimedia.org",
  "schema.org", "w3.org", "w3schools.com", "amazon.com", "amazonaws.com",
  "apple.com", "microsoft.com", "cloudflare.com", "example.com",
]);

type RawCompetitorEntry = { domain?: string; name?: string; basis?: string; fact?: string };

async function extractCompetitorsFromJson(
  domainSelf: string,
  responses: string[],
  maxResults: number,
): Promise<DiscoveredCompetitor[]> {
  const domainRoot = domainSelf.replace(/^www\./, "").toLowerCase();
  const mentionCounts = new Map<string, number>();
  const nameMap       = new Map<string, string>();

  // FIND-SILENTFAILURE-030: track parse outcomes so an all-unparseable batch can be
  // surfaced as a failure instead of silently returning an empty competitor list.
  let parsedArrays = 0;
  let parseFailures = 0;

  for (const text of responses) {
    const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try {
      const parsed = JSON.parse(clean) as unknown;
      if (!Array.isArray(parsed)) { parseFailures++; continue; }
      parsedArrays++;
      for (const item of parsed as RawCompetitorEntry[]) {
        if (typeof item !== "object" || item === null) continue;
        const d = (item.domain ?? "").toLowerCase().replace(/^www\./, "");
        if (!d || d.includes(domainRoot) || NON_COMPETITOR_DOMAINS.has(d)) continue;
        mentionCounts.set(d, (mentionCounts.get(d) ?? 0) + 1);
        // TS-081: Reject names that look like domain stems ("apollohospitals")
        // — they're clearly the LLM giving up. Humanize the domain instead.
        if (item.name && !nameMap.has(d) && !looksLikeDomainStem(item.name)) {
          nameMap.set(d, item.name);
        }
      }
    } catch { parseFailures++; }
  }

  // TS-081 / HP-146: humanizeDomainToBrand is now async (Haiku-backed). Pre-
  // resolve all domains that need humanization in parallel so the .map() below
  // stays synchronous and per-row ordering is preserved.
  const ranked = [...mentionCounts.entries()]
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults);

  const humanized = new Map<string, string>();
  await Promise.all(
    ranked.map(async ([domain]) => {
      if (!nameMap.has(domain)) {
        humanized.set(domain, await humanizeDomainToBrand(domain));
      }
    }),
  );

  const results = ranked.map(([domain, mentions], i) => ({
    name:     nameMap.get(domain) ?? humanized.get(domain) ?? domain,
    domain,
    rank:     i + 1,
    mentions,
    category: "direct" as const,
  } satisfies DiscoveredCompetitor));

  // Fallback: if JSON parsing yielded nothing, extract domains from raw text
  if (results.length === 0) {
    const fallbackCounts = new Map<string, number>();
    for (const text of responses) {
      const bare = [...text.matchAll(/\b(?:www\.)?([a-z0-9][a-z0-9-]{1,30}\.(?:com|io|co|net|org|ai|app|dev))\b/gi)]
        .map(m => m[1].toLowerCase())
        .filter(d => !d.includes(domainRoot) && !NON_COMPETITOR_DOMAINS.has(d));
      for (const d of [...new Set(bare)]) {
        fallbackCounts.set(d, (fallbackCounts.get(d) ?? 0) + 1);
      }
    }
    const fallbackRanked = [...fallbackCounts.entries()]
      .filter(([, c]) => c >= 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxResults);

    // FIND-SILENTFAILURE-030: if no response parsed as a JSON array AND the raw-text
    // fallback also found nothing, the model output was unusable — surface it rather
    // than reporting "no competitors found" (a legitimately empty JSON array would
    // have incremented parsedArrays and is treated as a genuine zero-result instead).
    if (fallbackRanked.length === 0 && parsedArrays === 0 && parseFailures > 0) {
      throw new Error(
        `competitor extraction failed: ${parseFailures}/${responses.length} responses were unparseable and text fallback found no domains`,
      );
    }

    // HP-146: humanizeDomainToBrand is now async, pre-resolve in parallel.
    const fallbackHumanized = new Map<string, string>();
    await Promise.all(
      fallbackRanked.map(async ([domain]) => {
        fallbackHumanized.set(domain, await humanizeDomainToBrand(domain));
      }),
    );

    return fallbackRanked.map(([domain, mentions], i) => ({
      name: fallbackHumanized.get(domain) ?? domain,
      domain,
      rank: i + 1,
      mentions,
      category: "direct" as const,
    } satisfies DiscoveredCompetitor));
  }

  return results;
}

// ── Main export ───────────────────────────────────────────────────────────

export interface DiscoveryCallbacks {
  onPromptStart:    (index: number, total: number, prompt: string) => void;
  onPromptComplete: (index: number, total: number) => void;
}

export async function discoverCompetitors(
  site: Pick<GeoSite, "domain" | "siteType" | "executiveSummary" | "crawlData">,
  callbacks: DiscoveryCallbacks,
  options?: { excludeNames?: string[]; maxResults?: number },
): Promise<DiscoveredCompetitor[]> {
  const { domain } = site;
  const crawlData = site.crawlData as { pages?: Array<{ pageType?: string; content?: string }> } | null;
  const homepageContent = crawlData?.pages?.find(p => p.pageType === "homepage")?.content?.slice(0, 400) ?? "";
  const aboutContent = crawlData?.pages?.find(p => p.pageType === "about")?.content?.slice(0, 200) ?? "";
  const crawledDescription = (homepageContent + " " + aboutContent).trim().slice(0, 500) || null;

  const prompts = buildDiscoveryPrompts(
    domain,
    site.siteType as string | null,
    site.executiveSummary as string | null,
    crawledDescription,
    options?.excludeNames,
  );

  const rawResponses: string[] = [];
  // FIND-SILENTFAILURE-029: retain the last provider-level failure so an all-failed
  // batch can be surfaced instead of swallowed. queryForDiscovery either returns
  // non-empty text or throws, so an empty rawResponses means every prompt threw.
  let lastError: unknown = null;

  for (let i = 0; i < prompts.length; i++) {
    callbacks.onPromptStart(i + 1, prompts.length, prompts[i].user);
    try {
      const text = await queryForDiscovery(prompts[i]);
      if (text) rawResponses.push(text);
    } catch (err) {
      lastError = err;
      console.warn(`[competitor-discovery] prompt ${i + 1} failed:`, err);
    }
    callbacks.onPromptComplete(i + 1, prompts.length);
  }

  if (rawResponses.length === 0) {
    console.warn(`[competitor-discovery] ${domain}: all discovery prompts failed — no responses to extract from`);
    // Re-throw the real cause (no_providers_configured vs all_providers_failed) so the
    // caller surfaces it as an error rather than reporting "no competitors found".
    if (lastError) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`competitor discovery failed: ${String(lastError)}`);
    }
    return [];
  }

  console.info(`[competitor-discovery] ${domain}: collected ${rawResponses.length} responses — extracting competitors`);
  // Cap extraction at the caller-supplied tier limit (replaces the old hardcoded 6).
  // Falls back to 6 only when no limit is provided.
  const maxResults = options?.maxResults ?? 6;
  let competitors = await extractCompetitorsFromJson(domain, rawResponses, maxResults);

  // Filter against excludeNames (case-insensitive)
  if (options?.excludeNames?.length) {
    const excludeSet = new Set(options.excludeNames.map((n) => n.toLowerCase()));
    competitors = competitors.filter(
      (c) => !excludeSet.has(c.name.toLowerCase()) && !(c.domain && excludeSet.has(c.domain.toLowerCase()))
    );
  }

  // Slice to maxResults
  if (options?.maxResults != null) {
    competitors = competitors.slice(0, options.maxResults);
  }

  console.info(`[competitor-discovery] ${domain}: extracted ${competitors.length} competitors`);
  return competitors;
}
