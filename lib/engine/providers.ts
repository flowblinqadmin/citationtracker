// Provider query functions — trimmed from geo's lib/services/citation-checker.ts
// (as merged with PR #194): MODELS, the four query functions, and their URL
// extraction. The audit-only machinery (competitor extraction, runCitationCheck,
// aggregation, cost-usage accounting) stays in geo — the engine only needs
// text + responseTimeMs + citedUrls per query.

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGoogleGenAIKey } from "@/lib/engine/google-genai-key";

// ── System prompt for citation queries ───────────────────────────────────────
// Kept deliberately neutral — the goal is to measure natural citation behavior,
// not to steer the model toward or away from any specific company.
// The prompt standardizes response length and format without biasing content.
// The tracker never uses this default (it passes systemPrompt explicitly:
// null for measurement runs, the grounded prompt for team orgs) — kept so the
// functions behave byte-for-byte like geo's when opts are omitted.
const CITATION_SYSTEM_PROMPT = `You are a helpful assistant answering questions about tools, companies, and market options.

<behavior>
- Answer in a numbered list when the question asks for comparisons, rankings, or recommendations
- Name specific companies, products, and services — do not give generic category descriptions
- Be concise: 3–7 items maximum, one sentence per item
- Do not add disclaimers, caveats, or meta-commentary
</behavior>

<constraints>
- Do not ask clarifying questions — answer directly with what you know
- Do not explain that you are an AI or that your information may be outdated
- Do not pad the answer with introductory phrases like "Great question" or "Certainly"
- If you do not have reliable information about a specific company or product, say "I don't have enough information about [name] to provide details" rather than guessing or fabricating facts
</constraints>`;

/**
 * Web search enforcement policy
 *
 * - Anthropic: HARD ENFORCEMENT via tools[].max_uses (max_uses_exceeded beyond).
 * - OpenAI / Google grounding / Perplexity: SOFT CONTROL only — search count is
 *   model-managed; token limits and prompt instructions are not hard caps.
 */

// ── Models (must stay in lockstep with geo's until its tracker is deleted —
// modelsUsed comparability across the transition window) ─────────────────────
export const MODELS = {
  openai:     "gpt-5.4-mini",
  anthropic:  "claude-haiku-4-5-20251001",
  perplexity: "sonar",
  google:     "gemini-3.5-flash",
} as const;

const TIMEOUT_MS = 30_000;

/**
 * Options for a provider query.
 *
 * - `systemPrompt: undefined` → use CITATION_SYSTEM_PROMPT (geo audit default).
 * - `systemPrompt: null`      → submit the user prompt VERBATIM with no system
 *                                steering (measurement runs).
 * - `maxTokens`               → override the per-provider token cap (default 256).
 *                                The tracker raises this (~1024) because it stores
 *                                full response text, not just a ranked list.
 */
export interface ProviderQueryOpts {
  systemPrompt?: string | null;
  maxTokens?: number;
}

/**
 * Result of a provider query. `citedUrls` are raw (not normalized /
 * redirect-resolved) — that is the matcher's job. For Google grounding these
 * are `vertexaisearch.cloud.google.com/...` redirect URLs that MUST be
 * resolved before matching.
 */
export interface ProviderQueryResult {
  text: string;
  responseTimeMs: number;
  citedUrls: string[];
}

/** Resolve the effective system prompt: undefined → default; null → none. */
function resolveSystemPrompt(opts?: ProviderQueryOpts): string | null {
  return opts?.systemPrompt === undefined ? CITATION_SYSTEM_PROMPT : opts.systemPrompt;
}

/** De-dupe while preserving first-seen order; drop falsy entries. */
function dedupeUrls(urls: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

export async function queryOpenAI(prompt: string, opts?: ProviderQueryOpts): Promise<ProviderQueryResult> {
  const start = Date.now();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const sys = resolveSystemPrompt(opts);
  // Use Responses API with web_search to measure real-world discoverability,
  // not just parametric memory (which only updates on model retraining).
  // search_context_size:"low" reduces the scope of content fetched per search
  // but does NOT cap the number of searches — search count is model-managed.
  const res = await Promise.race([
    client.responses.create({
      model: MODELS.openai,
      max_output_tokens: opts?.maxTokens ?? 256,
      ...(sys !== null ? { instructions: sys } : {}),
      tools: [{ type: "web_search", search_context_size: "low" } as any],
      input: prompt,
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
  ]);
  // Extract text + url_citation annotations from the same output_text blocks.
  // We deliberately use ONLY the inline `url_citation` annotations (the URLs the
  // model actually grounded its answer on) and NOT `web_search_call.action.sources`
  // (the raw candidate pages the search surfaced). For a CITATION tracker the
  // distinction is load-bearing: pulling in action.sources would count un-cited
  // search candidates and turn the metric into a search-impressions metric, and
  // would diverge from Perplexity/Gemini/Anthropic, which all return used sources.
  const outputBlocks = (res as any).output
    ?.filter((item: any) => item.type === "message")
    ?.flatMap((item: any) => item.content)
    ?.filter((block: any) => block.type === "output_text") ?? [];
  const text = outputBlocks.map((block: any) => block.text).join("") ?? "";
  const citedUrls = dedupeUrls(
    outputBlocks.flatMap((block: any) =>
      (block.annotations ?? [])
        .filter((a: any) => a?.type === "url_citation")
        .map((a: any) => a?.url as string | undefined),
    ),
  );
  return { text, responseTimeMs: Date.now() - start, citedUrls };
}

export async function queryAnthropic(prompt: string, opts?: ProviderQueryOpts): Promise<ProviderQueryResult> {
  const start = Date.now();
  const client = new Anthropic();
  const sys = resolveSystemPrompt(opts);
  // Enable web_search server tool so citation checks measure live discoverability.
  // max_uses:2 is HARD ENFORCEMENT — the Anthropic API enforces this cap directly;
  // if the model attempts a third search, the API returns max_uses_exceeded.
  const res = await Promise.race([
    client.messages.create({
      model: MODELS.anthropic,
      max_tokens: opts?.maxTokens ?? 256,
      ...(sys !== null ? { system: sys } : {}),
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 } as any],
      messages: [{ role: "user", content: prompt }],
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
  ]);
  const text = res.content.filter(b => b.type === "text").map(b => (b as { type: "text"; text: string }).text).join("");
  // Web-search citations ride along on text blocks as `citations[]`.
  const citedUrls = dedupeUrls(
    res.content.flatMap((b: any) =>
      (b?.citations ?? []).map((c: any) => c?.url as string | undefined),
    ),
  );
  return { text, responseTimeMs: Date.now() - start, citedUrls };
}

export async function queryPerplexity(prompt: string, opts?: ProviderQueryOpts): Promise<ProviderQueryResult> {
  const start = Date.now();
  const client = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY,
    baseURL: process.env.PERPLEXITY_BASE_URL ?? "https://api.perplexity.ai",
  });
  const sys = resolveSystemPrompt(opts);
  const res = await Promise.race([
    client.chat.completions.create({
      model: MODELS.perplexity,
      max_tokens: opts?.maxTokens ?? 256,
      messages: [
        ...(sys !== null ? [{ role: "system" as const, content: sys }] : []),
        { role: "user" as const, content: prompt },
      ],
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
  ]);
  // Perplexity returns sources top-level as `citations: string[]` and/or
  // `search_results: [{ url }]`. Neither is part of the OpenAI SDK types.
  const citedUrls = dedupeUrls([
    ...(((res as any).citations as string[] | undefined) ?? []),
    ...(((res as any).search_results as Array<{ url?: string }> | undefined)?.map(r => r?.url) ?? []),
  ]);
  return { text: res.choices[0]?.message?.content ?? "", responseTimeMs: Date.now() - start, citedUrls };
}

export async function queryGoogle(prompt: string, opts?: ProviderQueryOpts): Promise<ProviderQueryResult> {
  const start = Date.now();
  const client = new GoogleGenerativeAI(getGoogleGenAIKey());
  const sys = resolveSystemPrompt(opts);
  // Enable Google Search grounding so citation checks measure live web presence
  const model = client.getGenerativeModel({
    model: MODELS.google,
    ...(sys !== null ? { systemInstruction: sys } : {}),
    tools: [{ googleSearch: {} } as any],
  });
  // Preserve geo's exact call shape (bare prompt, no maxOutputTokens) when no
  // token cap is requested; only switch to the structured request when the
  // tracker raises the cap.
  const genReq: any = opts?.maxTokens != null
    ? { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: opts.maxTokens } }
    : prompt;
  const res = await Promise.race([
    model.generateContent(genReq),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
  ]);
  // Grounding sources live on groundingMetadata.groundingChunks[].web.uri.
  // NOTE: these are vertexaisearch redirect URLs — the matcher must resolve them.
  const citedUrls = dedupeUrls(
    (res.response as any).candidates?.[0]?.groundingMetadata?.groundingChunks
      ?.map((c: any) => c?.web?.uri as string | undefined) ?? [],
  );
  return { text: res.response.text(), responseTimeMs: Date.now() - start, citedUrls };
}
