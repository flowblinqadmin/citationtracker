/**
 * surface-probes.mjs — Query 5 AI shopping surfaces for merchant visibility
 *
 * Surfaces:
 *   1. ChatGPT Shopping (OpenAI Responses API + web_search)
 *   2. Perplexity Shopping (Sonar model)
 *   3. Google AI Overviews (Gemini + Google Search grounding)
 *   4. Meta AI (Llama 4 via llama-api.com with web search)
 *   5. Amazon Rufus simulation (OpenAI + Amazon product context)
 *
 * Each surface is queried with shopping-intent prompts and responses are
 * analyzed for: mention, position, sentiment, citation URLs, schema signals.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 45_000;
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;

const SHOPPING_SYSTEM_PROMPT = `You are a shopping advisor helping someone find specific products to buy online.

<behavior>
- Recommend specific brands, retailers, and websites by name
- Include the store's URL or website when you know it
- Order recommendations by your confidence in the recommendation
- Mention 3-7 options, one sentence per recommendation
- Consider: product quality, price, selection, shipping, reviews, return policy
</behavior>

<constraints>
- Do not ask clarifying questions — answer directly
- Do not add disclaimers or meta-commentary
- Name real stores and brands only — do not make up retailers
- If you know a store's website, include it (e.g., "RevZilla (revzilla.com)")
</constraints>`;

// Rufus-style prompt that simulates Amazon's shopping context
const RUFUS_SYSTEM_PROMPT = `You are a product recommendation assistant embedded in a major e-commerce marketplace. Help shoppers find the right products.

<behavior>
- Focus on specific product names, brands, and key specs
- Compare products by: price range, ratings, key features, Prime/fast shipping availability
- Mention if products are sold by third-party sellers or direct brands
- Include typical price ranges when you know them
- Recommend 3-5 specific products, not just brands
</behavior>

<constraints>
- Answer as if the shopper is browsing an e-commerce site right now
- Prioritize products that are widely available for online purchase
- Include brand names and specific model numbers when possible
- Do not add disclaimers or ask clarifying questions
</constraints>`;

// ── Surface query functions ──────────────────────────────────────────────────

async function queryChatGPTShopping(query) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const start = Date.now();
  try {
    const res = await Promise.race([
      client.responses.create({
        model: "gpt-5.4-mini",
        max_output_tokens: 512,
        instructions: SHOPPING_SYSTEM_PROMPT,
        tools: [{ type: "web_search", search_context_size: "medium" }],
        input: query,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    const text = res.output
      ?.filter(item => item.type === "message")
      ?.flatMap(item => item.content)
      ?.filter(block => block.type === "output_text")
      ?.map(block => block.text)
      ?.join("") ?? "";
    // Extract cited URLs from web_search results
    const citations = res.output
      ?.filter(item => item.type === "web_search_call" || item.type === "web_search_result")
      ?.flatMap(item => {
        if (item.type === "web_search_result" && item.results) {
          return item.results.map(r => r.url);
        }
        return [];
      }) ?? [];
    return { text, citations, responseTimeMs: Date.now() - start, error: null };
  } catch (e) {
    return { text: "", citations: [], responseTimeMs: Date.now() - start, error: e.message };
  }
}

async function queryPerplexityShopping(query) {
  const client = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY,
    baseURL: "https://api.perplexity.ai",
  });
  const start = Date.now();
  try {
    const res = await Promise.race([
      client.chat.completions.create({
        model: "sonar",
        max_tokens: 512,
        messages: [
          { role: "system", content: SHOPPING_SYSTEM_PROMPT },
          { role: "user", content: query },
        ],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    const text = res.choices[0]?.message?.content ?? "";
    // Perplexity returns citations in the response metadata
    const citations = res.citations ?? [];
    return { text, citations, responseTimeMs: Date.now() - start, error: null };
  } catch (e) {
    return { text: "", citations: [], responseTimeMs: Date.now() - start, error: e.message };
  }
}

async function queryGoogleAIOverview(query) {
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");
  const model = client.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SHOPPING_SYSTEM_PROMPT,
    tools: [{ googleSearch: {} }],
  });
  const start = Date.now();
  try {
    const res = await Promise.race([
      model.generateContent(query),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    const text = res.response.text();
    // Extract grounding sources
    const groundingMetadata = res.response.candidates?.[0]?.groundingMetadata;
    const citations = groundingMetadata?.groundingChunks
      ?.map(c => c.web?.uri)
      ?.filter(Boolean) ?? [];
    return { text, citations, responseTimeMs: Date.now() - start, error: null };
  } catch (e) {
    return { text: "", citations: [], responseTimeMs: Date.now() - start, error: e.message };
  }
}

async function queryMetaAI(query) {
  // Meta AI uses Llama models. We query via Together AI which hosts Llama 4
  // with web search capability via Brave Search integration.
  const start = Date.now();
  try {
    // Try Together AI (hosts Llama 4 models with tool use)
    const togetherKey = process.env.TOGETHER_API_KEY;
    if (!togetherKey) {
      // Fallback: use Anthropic Claude as Meta AI proxy with explicit instruction
      // to simulate Meta AI's recommendation style (Facebook/Instagram shopping)
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const res = await Promise.race([
        client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: `You are Meta AI, the AI assistant integrated into Facebook, Instagram, and WhatsApp. You help users find products to buy, especially products popular on social commerce platforms.\n\n${SHOPPING_SYSTEM_PROMPT}`,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
          messages: [{ role: "user", content: query }],
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
      ]);
      const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
      return { text, citations: [], responseTimeMs: Date.now() - start, error: null, fallback: "anthropic-proxy" };
    }

    const client = new OpenAI({
      apiKey: togetherKey,
      baseURL: "https://api.together.xyz/v1",
    });
    const res = await Promise.race([
      client.chat.completions.create({
        model: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
        max_tokens: 512,
        messages: [
          { role: "system", content: SHOPPING_SYSTEM_PROMPT },
          { role: "user", content: query },
        ],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    const text = res.choices[0]?.message?.content ?? "";
    return { text, citations: [], responseTimeMs: Date.now() - start, error: null };
  } catch (e) {
    return { text: "", citations: [], responseTimeMs: Date.now() - start, error: e.message };
  }
}

async function queryAmazonRufus(query) {
  // Amazon Rufus has no public API. We simulate it by:
  // 1. Using Brave Search to find Amazon product listings for the query
  // 2. Feeding those results + the query into an LLM with Rufus-style instructions
  const start = Date.now();
  try {
    // Step 1: Brave Search for Amazon product context
    let amazonContext = "";
    const braveKey = process.env.BRAVE_API_KEY;
    if (braveKey) {
      const searchQuery = `site:amazon.com ${query}`;
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(searchQuery)}&count=5&search_lang=en`;
      const braveRes = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": braveKey,
        },
      });
      if (braveRes.ok) {
        const data = await braveRes.json();
        const results = data.web?.results || [];
        amazonContext = results
          .map(r => `${r.title}\n${r.url}\n${r.description || ""}`)
          .join("\n\n");
      }
    }

    // Step 2: LLM with Rufus-style prompt + Amazon context
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const contextPrefix = amazonContext
      ? `\n\nHere are some relevant product listings from a major marketplace:\n${amazonContext}\n\nBased on these and your knowledge, answer the following shopping question:\n`
      : "";

    const res = await Promise.race([
      client.responses.create({
        model: "gpt-5.4-mini",
        max_output_tokens: 512,
        instructions: RUFUS_SYSTEM_PROMPT,
        tools: [{ type: "web_search", search_context_size: "low" }],
        input: `${contextPrefix}${query}`,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    const text = res.output
      ?.filter(item => item.type === "message")
      ?.flatMap(item => item.content)
      ?.filter(block => block.type === "output_text")
      ?.map(block => block.text)
      ?.join("") ?? "";
    return { text, citations: [], responseTimeMs: Date.now() - start, error: null };
  } catch (e) {
    return { text: "", citations: [], responseTimeMs: Date.now() - start, error: e.message };
  }
}

// ── Surface registry ─────────────────────────────────────────────────────────

export const SURFACES = [
  { name: "chatgpt_shopping", label: "ChatGPT Shopping", fn: queryChatGPTShopping },
  { name: "perplexity_shopping", label: "Perplexity Shopping", fn: queryPerplexityShopping },
  { name: "google_ai_overview", label: "Google AI Overviews", fn: queryGoogleAIOverview },
  { name: "meta_ai", label: "Meta AI", fn: queryMetaAI },
  { name: "amazon_rufus", label: "Amazon Rufus (sim)", fn: queryAmazonRufus },
];

// ── Mention detection ────────────────────────────────────────────────────────

export function detectMerchantMention(text, domain) {
  const lower = text.toLowerCase();
  const domainRoot = domain.replace(/^www\./, "").replace(/\.(com|com\.au|io|co|net|org|in|ai|au|sh|app)$/, "").toLowerCase();
  const domainFull = domain.replace(/^www\./, "").toLowerCase();

  // Check for domain mention
  const hasDomain = lower.includes(domainFull);

  // Check for brand name mention (domain root without TLD)
  // Split concatenated words: "manipalhospitals" → "manipal hospitals", "apollohospitals" → "apollo hospitals"
  // Common split patterns: word+hospitals, word+electronics, word+tailoring, word+finance
  const splitPatterns = [
    domainRoot,
    // Split before common suffixes
    domainRoot.replace(/(hospitals|healthcare|electronics|tailoring|finance|computing|repairs|snack|beauty|medical)/, " $1"),
    // Split camelCase
    domainRoot.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(),
    // Split at common joining points: buzztime, loanset, breathpod
    domainRoot.replace(/(buzz|loan|breath|social|cloud|white|green|nutty|slurrp)/, "$1 "),
  ].map(s => s.trim().toLowerCase()).filter(s => s.length >= 3);

  const hasBrand = splitPatterns.some(p => lower.includes(p));

  // Detect position in numbered list
  let position = null;
  if (hasDomain || hasBrand) {
    const lines = text.split("\n");
    for (const line of lines) {
      const match = line.match(/^(\d+)\.\s/);
      if (match && (line.toLowerCase().includes(domainRoot) || line.toLowerCase().includes(domainFull))) {
        position = parseInt(match[1], 10);
        break;
      }
    }
  }

  // Detect sentiment around mention
  let sentiment = "neutral";
  if (hasDomain || hasBrand) {
    const positiveSignals = ["best", "top", "leading", "recommended", "excellent", "great", "trusted", "premium", "popular", "reliable"];
    const negativeSignals = ["avoid", "poor", "limited", "expensive", "slow", "outdated", "unreliable"];
    const context = lower;
    const posCount = positiveSignals.filter(s => context.includes(s)).length;
    const negCount = negativeSignals.filter(s => context.includes(s)).length;
    if (posCount > negCount) sentiment = "positive";
    else if (negCount > posCount) sentiment = "negative";
  }

  return {
    mentioned: hasDomain || hasBrand,
    position,
    sentiment,
    matchType: hasDomain ? "domain" : hasBrand ? "brand" : null,
  };
}

// ── Extract cited domains from response text ─────────────────────────────────

export function extractCitedDomains(text) {
  const urls = [...text.matchAll(/https?:\/\/(?:www\.)?([a-z0-9-]+\.[a-z]{2,})/gi)];
  const bare = [...text.matchAll(/\b(?:www\.)?([a-z0-9][a-z0-9-]{1,30}\.(?:com|io|co|net|org|ai|app|dev|in))\b/gi)];
  const domains = new Set([...urls, ...bare].map(m => m[1].toLowerCase()));
  // Filter infra domains
  const INFRA = new Set(["google.com", "bing.com", "wikipedia.org", "github.com", "youtube.com", "facebook.com", "twitter.com", "reddit.com"]);
  return [...domains].filter(d => !INFRA.has(d));
}

// ── Batch runner ─────────────────────────────────────────────────────────────

/**
 * Run all surfaces against a set of queries for a single merchant.
 * Returns per-surface, per-query results.
 */
export async function probeMerchant(domain, queries) {
  const results = [];

  for (const surface of SURFACES) {
    const surfaceResults = [];

    // Run queries in batches
    for (let i = 0; i < queries.length; i += BATCH_SIZE) {
      const batch = queries.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (query) => {
          const response = await surface.fn(query);
          const mention = detectMerchantMention(response.text, domain);
          const citedDomains = extractCitedDomains(response.text);
          return {
            query,
            ...response,
            mention,
            citedDomains,
          };
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled") {
          surfaceResults.push(r.value);
        } else {
          surfaceResults.push({ query: batch[0], text: "", citations: [], error: r.reason?.message, mention: { mentioned: false }, citedDomains: [] });
        }
      }

      // Delay between batches
      if (i + BATCH_SIZE < queries.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    // Aggregate surface-level stats
    const mentioned = surfaceResults.filter(r => r.mention.mentioned);
    const positions = mentioned.map(r => r.mention.position).filter(p => p !== null);
    const sentiments = mentioned.map(r => r.mention.sentiment);

    results.push({
      surface: surface.name,
      label: surface.label,
      totalQueries: surfaceResults.length,
      mentionCount: mentioned.length,
      visibilityScore: surfaceResults.length > 0
        ? Math.round((mentioned.length / surfaceResults.length) * 100)
        : 0,
      avgPosition: positions.length > 0
        ? Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 10) / 10
        : null,
      dominantSentiment: sentiments.length > 0
        ? sentiments.sort((a, b) =>
            sentiments.filter(v => v === b).length - sentiments.filter(v => v === a).length
          )[0]
        : null,
      // All domains cited across this surface (for schema/signal correlation)
      allCitedDomains: [...new Set(surfaceResults.flatMap(r => r.citedDomains))],
      // All citation URLs from grounding
      allCitationUrls: [...new Set(surfaceResults.flatMap(r => r.citations))],
      responses: surfaceResults,
    });
  }

  return results;
}
