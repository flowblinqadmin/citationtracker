import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGoogleGenAIKey } from "@/lib/google-genai-key";

export interface BrandMention {
  brand: string;
  mentioned: boolean;
  position: number | null;
  context: string;
}

export interface PlatformQueryResult {
  platform: "ChatGPT" | "Claude" | "Gemini" | "Perplexity";
  fullResponse: string;
  targetBrandMentioned: boolean;
  targetBrandPosition: number | null;
  mentions: BrandMention[];
  error?: string;
}

export interface QueryResult {
  query: string;
  platforms: PlatformQueryResult[];
}

export interface SovResult {
  results: QueryResult[];
  summary: {
    brandSov: number;
    topCompetitorName: string;
    topCompetitorSov: number;
    platformsQueried: string[];
    queriesRun: number;
  };
}

const BASE_SHOPPING_PROMPT =
  "You are a knowledgeable shopping advisor helping someone find products to buy. Always recommend specific brands and retailers by name. Include where to buy the products (specific stores or websites). Mention 3-5 options ordered by your confidence in the recommendation. Consider factors like product quality, value for money, availability, and customer reviews.";

function getShoppingPrompt(primaryMarket?: string): string {
  if (!primaryMarket) return BASE_SHOPPING_PROMPT;
  return `${BASE_SHOPPING_PROMPT} The shopper is located in ${primaryMarket}. Prioritize brands, retailers, and websites that ship to or operate in ${primaryMarket}. Use local context — popular local brands, local e-commerce platforms, and regional availability.`;
}

function parseMentions(
  response: string,
  brandName: string,
  competitorNames: string[]
): { targetMentioned: boolean; targetPosition: number | null; mentions: BrandMention[] } {
  const allBrands = [brandName, ...competitorNames];
  const mentions: BrandMention[] = [];
  let brandPositions: Array<{ brand: string; index: number }> = [];

  for (const brand of allBrands) {
    const regex = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const match = regex.exec(response);
    const mentioned = match !== null;

    let context = "";
    if (match) {
      const start = Math.max(0, match.index - 50);
      const end = Math.min(response.length, match.index + brand.length + 50);
      context = response.slice(start, end);
      if (start > 0) context = "..." + context;
      if (end < response.length) context = context + "...";
      brandPositions.push({ brand, index: match.index });
    }

    mentions.push({
      brand,
      mentioned,
      position: null,
      context,
    });
  }

  // Assign positional ranking
  brandPositions.sort((a, b) => a.index - b.index);
  for (let i = 0; i < brandPositions.length; i++) {
    const m = mentions.find((m) => m.brand === brandPositions[i].brand);
    if (m) m.position = i + 1;
  }

  const targetMention = mentions.find(
    (m) => m.brand.toLowerCase() === brandName.toLowerCase()
  );

  return {
    targetMentioned: targetMention?.mentioned ?? false,
    targetPosition: targetMention?.position ?? null,
    mentions,
  };
}

async function queryChatGPT(query: string, systemPrompt: string): Promise<string> {
  const openai = new OpenAI();
  const completion = await openai.chat.completions.create({
    model: "gpt-5.4-mini",
    max_completion_tokens: 1024,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content || "";
}

async function queryClaude(query: string, systemPrompt: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("No ANTHROPIC_API_KEY");
  const anthropic = new Anthropic();
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: query }],
  });
  const block = msg.content[0];
  return block.type === "text" ? block.text : "";
}

async function queryGemini(query: string, systemPrompt: string): Promise<string> {
  const genAI = new GoogleGenerativeAI(getGoogleGenAIKey());
  // FIX-025: gemini-3.5-flash, NOT flash-lite. flash-lite hallucinates brand
  // names on unknown / long-tail brands in share-of-voice detection — the model
  // the repo abandoned for brand detection for exactly this reason. flash is
  // materially more reliable at grounded brand mentions for a negligible cost
  // delta, and matches the Flash tier used elsewhere (geo-analyzer).
  const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });  // 2026-06-10 modernization (was gemini-2.5-flash)

  // Retry with backoff for 429 rate limits
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await model.generateContent(
        `${systemPrompt}\n\nUser: ${query}`
      );
      return result.response.text();
    } catch (err) {
      const msg = (err as Error).message || "";
      if (msg.includes("429") && attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Gemini: max retries exceeded");
}

async function queryPerplexity(query: string, systemPrompt: string): Promise<string> {
  if (!process.env.PERPLEXITY_API_KEY)
    throw new Error("No PERPLEXITY_API_KEY");
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
      max_tokens: 1024,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

type PlatformQueryFn = (query: string, systemPrompt: string) => Promise<string>;

interface PlatformConfig {
  name: "ChatGPT" | "Claude" | "Gemini" | "Perplexity";
  fn: PlatformQueryFn;
  required: boolean;
  envKey?: string;
}

function getAvailablePlatforms(): PlatformConfig[] {
  const platforms: PlatformConfig[] = [
    { name: "ChatGPT", fn: queryChatGPT, required: false, envKey: "OPENAI_API_KEY" },
    { name: "Claude", fn: queryClaude, required: false, envKey: "ANTHROPIC_API_KEY" },
    { name: "Gemini", fn: queryGemini, required: false, envKey: "GEMINI_API_KEY" },
    { name: "Perplexity", fn: queryPerplexity, required: false, envKey: "PERPLEXITY_API_KEY" },
  ];
  return platforms.filter((p) => p.envKey && process.env[p.envKey]);
}

/** Run a single query across all available platforms. Used by per-query progress flow. */
export async function checkSingleQuery(
  query: string,
  brandName: string,
  competitorNames: string[],
  primaryMarket?: string
): Promise<QueryResult> {
  const availablePlatforms = getAvailablePlatforms();
  const systemPrompt = getShoppingPrompt(primaryMarket);
  const platformPromises = availablePlatforms.map(async (platform) => {
    try {
      const response = await platform.fn(query, systemPrompt);
      const { targetMentioned, targetPosition, mentions } = parseMentions(
        response,
        brandName,
        competitorNames
      );
      return {
        platform: platform.name,
        fullResponse: response,
        targetBrandMentioned: targetMentioned,
        targetBrandPosition: targetPosition,
        mentions,
      } as PlatformQueryResult;
    } catch (err) {
      console.error(`SoV query failed for ${platform.name}:`, (err as Error).message);
      return {
        platform: platform.name,
        fullResponse: "",
        targetBrandMentioned: false,
        targetBrandPosition: null,
        mentions: [],
        error: (err as Error).message,
      } as PlatformQueryResult;
    }
  });

  const settled = await Promise.allSettled(platformPromises);
  const platforms: PlatformQueryResult[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      platforms.push(result.value);
    }
  }

  return { query, platforms };
}

/** Compute SoV summary from collected query results. Pure math, no API calls. */
export function computeSovSummary(
  results: QueryResult[],
  brandName: string
): SovResult["summary"] {
  let totalSlots = 0;
  let brandMentions = 0;
  const competitorMentionCounts: Record<string, number> = {};
  const platformNames = new Set<string>();

  for (const result of results) {
    for (const p of result.platforms) {
      platformNames.add(p.platform);
      // Only count platforms that returned a real response (no error)
      if (p.error) continue;
      totalSlots++;
      if (p.targetBrandMentioned) brandMentions++;
      for (const m of p.mentions) {
        if (m.mentioned && m.brand.toLowerCase() !== brandName.toLowerCase()) {
          competitorMentionCounts[m.brand] = (competitorMentionCounts[m.brand] || 0) + 1;
        }
      }
    }
  }

  let topCompetitorName = "";
  let topCompetitorCount = 0;
  for (const [name, count] of Object.entries(competitorMentionCounts)) {
    if (count > topCompetitorCount) {
      topCompetitorName = name;
      topCompetitorCount = count;
    }
  }

  const brandSov = totalSlots > 0 ? Math.round((brandMentions / totalSlots) * 100) : 0;
  const topCompetitorSov = totalSlots > 0 ? Math.round((topCompetitorCount / totalSlots) * 100) : 0;

  return {
    brandSov,
    topCompetitorName,
    topCompetitorSov,
    platformsQueried: Array.from(platformNames),
    queriesRun: results.length,
  };
}

/** Original batch function — runs all queries sequentially. Kept for backward compatibility. */
export async function checkShareOfVoice(
  queries: string[],
  brandName: string,
  competitorNames: string[],
  primaryMarket?: string
): Promise<SovResult> {
  const results: QueryResult[] = [];

  for (const query of queries.slice(0, 8)) {
    const result = await checkSingleQuery(query, brandName, competitorNames, primaryMarket);
    results.push(result);

    // Delay between queries to respect rate limits
    if (queries.indexOf(query) < queries.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const summary = computeSovSummary(results, brandName);
  return { results, summary };
}
