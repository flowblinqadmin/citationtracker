// Brand auto-population for onboarding: given a domain, scrape the homepage
// (Firecrawl) and ask Gemini for a brand name, real competitors, and realistic
// buyer-intent prompts in the brand's category.
//
// PROVIDER FAILURE IS NEVER FATAL. Any missing key, scrape error, LLM timeout,
// or unparseable output degrades to `{ name: null, competitors: [], prompts: [] }`.
// The onboarding UI treats a degraded response as "no suggestions", never an error.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { normalizeDomain } from "@/lib/domain";
import { getGoogleGenAIKey } from "@/lib/engine/google-genai-key";

export interface BrandSuggestions {
  name: string | null;
  competitors: Array<{ name: string; domain: string }>;
  prompts: string[];
}

const EMPTY: BrandSuggestions = { name: null, competitors: [], prompts: [] };

const MAX_MARKDOWN_CHARS = 8_000;
const MAX_COMPETITORS = 10;
const MAX_PROMPTS = 15;
const MAX_PROMPT_CHARS = 500;
// Overall budget ≤20s — split across the two provider calls.
const SCRAPE_TIMEOUT_MS = 15_000;
const LLM_TIMEOUT_MS = 15_000;

// Gemini model + token cap. The maxOutputTokens gotcha: thinking tokens spend
// the budget first. Measured 2026-07-12: this JSON request thinks ~1k tokens
// before emitting a byte, so 1024 truncated at MAX_TOKENS with 40 tokens of
// output. 8192 leaves headroom for thinking + 15 prompts of JSON.
const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_MAX_TOKENS = 8192;

// The LLM must emit STRICT JSON in this shape; we validate + clamp it below.
// name/domain are permissive here (real cleaning happens after parse) so a
// single malformed row doesn't nuke the whole payload.
const llmSchema = z.object({
  name: z.string().nullish(),
  competitors: z
    .array(z.object({ name: z.string(), domain: z.string() }))
    .optional()
    .default([]),
  prompts: z.array(z.string()).optional().default([]),
});

/** Scrape the homepage of `domain` through Firecrawl; null on any failure. */
async function scrapeHomepage(domain: string): Promise<string | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `https://${domain}`,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: 12_000,
      }),
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const md = body?.data?.markdown;
    if (typeof md !== "string" || md.trim().length === 0) return null;
    return md.slice(0, MAX_MARKDOWN_CHARS);
  } catch {
    return null;
  }
}

function buildPrompt(domain: string, markdown: string): string {
  return `You are helping set up AI-visibility monitoring for a brand at the domain "${domain}".

Below is the markdown of the brand's homepage. Use it to infer the brand and its market category.

--- HOMEPAGE ---
${markdown}
--- END HOMEPAGE ---

Return STRICT JSON only (no prose, no markdown fences) with exactly this shape:
{
  "name": string,                                  // the brand's name
  "competitors": [{ "name": string, "domain": string }],  // up to 10 REAL competing companies with registrable domains (e.g. "example.com")
  "prompts": [string]                              // exactly 15 realistic buyer-intent questions a potential customer would ask an AI assistant in this category
}

Rules for "prompts":
- They must read like real questions a buyer types into ChatGPT/Perplexity when researching this category.
- Most prompts must NOT mention the brand by name — AI-visibility monitoring measures whether the brand surfaces for category questions it does not appear in verbatim.
- Keep each under 500 characters.

Rules for "competitors":
- Real companies only, each with a real registrable domain. No placeholders.`;
}

/** Strip ```json fences and grab the outermost JSON object, if any. */
function extractJson(text: string): string | null {
  let s = text.trim();
  // Remove leading/trailing code fences.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  return s.slice(first, last + 1);
}

/** One Gemini call returning the raw parsed+validated LLM object; null on failure. */
async function askGemini(prompt: string): Promise<z.infer<typeof llmSchema> | null> {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) return null;
  try {
    const client = new GoogleGenerativeAI(getGoogleGenAIKey());
    const model = client.getGenerativeModel({ model: GEMINI_MODEL });
    const res = await Promise.race([
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: GEMINI_MAX_TOKENS },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("gemini timeout")), LLM_TIMEOUT_MS),
      ),
    ]);
    const text = (res as { response: { text: () => string } }).response.text();
    const json = extractJson(text);
    if (!json) return null;
    const parsed = llmSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Validate + clamp the LLM output into the public shape. */
function clamp(raw: z.infer<typeof llmSchema>): BrandSuggestions {
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;

  const competitors: Array<{ name: string; domain: string }> = [];
  const seenDomains = new Set<string>();
  for (const c of raw.competitors ?? []) {
    const cName = typeof c?.name === "string" ? c.name.trim() : "";
    const cDomain = normalizeDomain(typeof c?.domain === "string" ? c.domain : "");
    if (!cName || !cDomain) continue; // drop invalid rows
    if (seenDomains.has(cDomain)) continue; // dedupe by domain
    seenDomains.add(cDomain);
    competitors.push({ name: cName.slice(0, 100), domain: cDomain });
    if (competitors.length >= MAX_COMPETITORS) break;
  }

  const prompts: string[] = [];
  for (const p of raw.prompts ?? []) {
    if (typeof p !== "string") continue;
    const trimmed = p.trim().slice(0, MAX_PROMPT_CHARS);
    if (!trimmed) continue;
    prompts.push(trimmed);
    if (prompts.length >= MAX_PROMPTS) break;
  }

  return { name, competitors, prompts };
}

/**
 * Scrape + LLM to auto-populate a brand's onboarding form. Never throws;
 * degrades to EMPTY on any provider failure.
 */
export async function fetchBrandSuggestions(domain: string): Promise<BrandSuggestions> {
  try {
    const markdown = await scrapeHomepage(domain);
    if (markdown === null) {
      // Degradation is invisible to the user by design — make it visible to us.
      console.error(`[suggest] degraded for ${domain}: homepage scrape failed`);
      return EMPTY;
    }
    const raw = await askGemini(buildPrompt(domain, markdown));
    if (raw === null) {
      console.error(`[suggest] degraded for ${domain}: LLM call/parse failed`);
      return EMPTY;
    }
    return clamp(raw);
  } catch (err) {
    console.error(`[suggest] degraded for ${domain}:`, err);
    return EMPTY;
  }
}
