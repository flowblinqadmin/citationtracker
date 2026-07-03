/**
 * A/B test: native grounding vs Firecrawl/Brave search tool
 *
 * Compares for each provider:
 *   A) Native grounding (current approach — provider-executed search)
 *   B) External search + ungrounded LLM (Firecrawl for Google/OpenAI, Brave for Anthropic)
 *
 * Measures: response text, brands mentioned, token usage, cost, latency
 *
 * Run: node --env-file=.env.local scripts/test-grounding-vs-firecrawl.mjs
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import FirecrawlApp from "@mendable/firecrawl-js";

// ── Config ────────────────────────────────────────────────────────────────────

const BRAVE_API_KEY = "BSAkkzqMz54Rhxx0oISrmcDa8hyeQ4I";

const SYSTEM_PROMPT = `You are a helpful assistant answering questions about tools, companies, and market options.

<behavior>
- Answer in a numbered list when the question asks for comparisons, rankings, or recommendations
- Name specific companies, products, and services — do not give generic category descriptions
- Be concise: 3-7 items maximum, one sentence per item
- Do not add disclaimers, caveats, or meta-commentary
</behavior>

<constraints>
- Do not ask clarifying questions — answer directly with what you know
- Do not explain that you are an AI or that your information may be outdated
- Do not pad the answer with introductory phrases like "Great question" or "Certainly"
- If you do not have reliable information about a specific company or product, say "I don't have enough information about [name] to provide details" rather than guessing or fabricating facts
</constraints>`;

const TEST_PROMPTS = [
  "Best hospitals in Bangalore for cardiac surgery?",
  "Top GEO optimization tools for improving AI visibility in 2026?",
  "Best alternatives to HubSpot for small business CRM?",
];

// ── Pricing (per 1M tokens) ──────────────────────────────────────────────────

const PRICING = {
  "gpt-5.4-mini":              { input: 0.75, output: 4.50, search: 10.00 },  // search = $/1K calls
  "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00, search: 10.00 },
  "gemini-2.5-flash":          { input: 0.30, output: 2.50, search: 35.00 },
  "firecrawl":                 { perSearch: 0.013 }, // ~2 credits at Growth plan pricing
  "brave":                     { perSearch: 0.005 }, // $5/1K queries
};

function calcCost(model, inputTokens, outputTokens, searchCalls = 0) {
  const p = PRICING[model];
  if (!p) return 0;
  const tokenCost = (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
  const searchCost = searchCalls * (p.search / 1000);
  return { tokenCost, searchCost, total: tokenCost + searchCost };
}

// ── Search helpers ───────────────────────────────────────────────────────────

async function firecrawlSearch(query) {
  const fc = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
  const start = Date.now();
  const res = await fc.search(query, { limit: 5 });
  const ms = Date.now() - start;
  if (!res.success || !res.data?.length) return { context: "", results: [], ms };

  const results = res.data.slice(0, 5).map(r => ({
    title: r.title || r.metadata?.title || "",
    url: r.url || "",
    description: r.description || r.metadata?.description || "",
  }));

  const context = "\n\n<web_search_results>\n" +
    results.map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${r.description}`).join("\n\n") +
    "\n</web_search_results>";

  return { context, results, ms };
}

async function braveSearch(query) {
  const start = Date.now();
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetch(url, {
    headers: { "X-Subscription-Token": BRAVE_API_KEY, "Accept": "application/json" },
  });
  const ms = Date.now() - start;
  if (!res.ok) return { context: "", results: [], ms };

  const data = await res.json();
  const results = (data.web?.results || []).slice(0, 5).map(r => ({
    title: r.title || "",
    url: r.url || "",
    description: r.description || "",
  }));

  const context = "\n\n<web_search_results>\n" +
    results.map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${r.description}`).join("\n\n") +
    "\n</web_search_results>";

  return { context, results, ms };
}

// ── Provider A: Native grounding ─────────────────────────────────────────────

async function nativeGoogle(prompt) {
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = client.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ googleSearch: {} }],
  });
  const start = Date.now();
  const res = await model.generateContent(prompt);
  const ms = Date.now() - start;
  const text = res.response.text();
  const usage = res.response.usageMetadata;
  return {
    text, ms,
    inputTokens: usage?.promptTokenCount || 0,
    outputTokens: usage?.candidatesTokenCount || 0,
    cost: calcCost("gemini-2.5-flash", usage?.promptTokenCount || 0, usage?.candidatesTokenCount || 0, 1),
  };
}

async function nativeOpenAI(prompt) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const start = Date.now();
  const res = await client.responses.create({
    model: "gpt-5.4-mini",
    max_output_tokens: 256,
    instructions: SYSTEM_PROMPT,
    tools: [{ type: "web_search", search_context_size: "low" }],
    input: prompt,
  });
  const ms = Date.now() - start;
  const text = res.output
    ?.filter(item => item.type === "message")
    ?.flatMap(item => item.content)
    ?.filter(block => block.type === "output_text")
    ?.map(block => block.text)
    ?.join("") ?? "";
  const usage = res.usage || {};
  return {
    text, ms,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cost: calcCost("gpt-5.4-mini", usage.input_tokens || 0, usage.output_tokens || 0, 1),
  };
}

async function nativeAnthropic(prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const start = Date.now();
  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    messages: [{ role: "user", content: prompt }],
  });
  const ms = Date.now() - start;
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  return {
    text, ms,
    inputTokens: res.usage?.input_tokens || 0,
    outputTokens: res.usage?.output_tokens || 0,
    cost: calcCost("claude-haiku-4-5-20251001", res.usage?.input_tokens || 0, res.usage?.output_tokens || 0, 1),
  };
}

// ── Provider B: External search + ungrounded LLM ─────────────────────────────

async function firecrawlGoogle(prompt) {
  const search = await firecrawlSearch(prompt);
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = client.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT + "\n\nUse the following web search results to inform your answer. Cite specific companies and products found in the results.",
  });
  const start = Date.now();
  const res = await model.generateContent(prompt + search.context);
  const ms = Date.now() - start;
  const text = res.response.text();
  const usage = res.response.usageMetadata;
  const tokenCost = calcCost("gemini-2.5-flash", usage?.promptTokenCount || 0, usage?.candidatesTokenCount || 0, 0);
  return {
    text, ms: search.ms + ms, searchMs: search.ms, llmMs: ms,
    inputTokens: usage?.promptTokenCount || 0,
    outputTokens: usage?.candidatesTokenCount || 0,
    searchResults: search.results,
    cost: { ...tokenCost, searchCost: PRICING.firecrawl.perSearch, total: tokenCost.total + PRICING.firecrawl.perSearch },
  };
}

async function firecrawlOpenAI(prompt) {
  const search = await firecrawlSearch(prompt);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const start = Date.now();
  const res = await client.chat.completions.create({
    model: "gpt-5.4-mini",
    max_completion_tokens: 256,
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n\nUse the following web search results to inform your answer. Cite specific companies and products found in the results." },
      { role: "user", content: prompt + search.context },
    ],
  });
  const ms = Date.now() - start;
  const text = res.choices[0]?.message?.content ?? "";
  const usage = res.usage || {};
  const tokenCost = calcCost("gpt-5.4-mini", usage.prompt_tokens || 0, usage.completion_tokens || 0, 0);
  return {
    text, ms: search.ms + ms, searchMs: search.ms, llmMs: ms,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    searchResults: search.results,
    cost: { ...tokenCost, searchCost: PRICING.firecrawl.perSearch, total: tokenCost.total + PRICING.firecrawl.perSearch },
  };
}

async function braveAnthropic(prompt) {
  const search = await braveSearch(prompt);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const start = Date.now();
  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    system: SYSTEM_PROMPT + "\n\nUse the following web search results to inform your answer. Cite specific companies and products found in the results.",
    messages: [{ role: "user", content: prompt + search.context }],
  });
  const ms = Date.now() - start;
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  const tokenCost = calcCost("claude-haiku-4-5-20251001", res.usage?.input_tokens || 0, res.usage?.output_tokens || 0, 0);
  return {
    text, ms: search.ms + ms, searchMs: search.ms, llmMs: ms,
    inputTokens: res.usage?.input_tokens || 0,
    outputTokens: res.usage?.output_tokens || 0,
    searchResults: search.results,
    cost: { ...tokenCost, searchCost: PRICING.brave.perSearch, total: tokenCost.total + PRICING.brave.perSearch },
  };
}

// ── Runner ───────────────────────────────────────────────────────────────────

function extractBrands(text) {
  // Simple heuristic: find capitalized multi-word names or known patterns
  const brands = new Set();
  const patterns = text.match(/[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g) || [];
  for (const p of patterns) {
    if (p.length > 2 && !["The", "This", "That", "Best", "Top", "For", "And", "With"].includes(p)) {
      brands.add(p);
    }
  }
  return [...brands];
}

async function runComparison(promptText, providerName, nativeFn, externalFn, externalLabel) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`Provider: ${providerName} | Prompt: "${promptText}"`);
  console.log("=".repeat(80));

  let nativeResult, externalResult;

  try {
    console.log(`\n--- A) Native grounding ---`);
    nativeResult = await nativeFn(promptText);
    console.log(`Latency: ${nativeResult.ms}ms`);
    console.log(`Tokens: ${nativeResult.inputTokens} in / ${nativeResult.outputTokens} out`);
    console.log(`Cost: tokens=$${nativeResult.cost.tokenCost.toFixed(6)} + search=$${nativeResult.cost.searchCost.toFixed(6)} = $${nativeResult.cost.total.toFixed(6)}`);
    console.log(`\nResponse:\n${nativeResult.text}`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    nativeResult = null;
  }

  try {
    console.log(`\n--- B) ${externalLabel} search + ungrounded LLM ---`);
    externalResult = await externalFn(promptText);
    console.log(`Latency: ${externalResult.ms}ms total (search=${externalResult.searchMs}ms, llm=${externalResult.llmMs}ms)`);
    console.log(`Tokens: ${externalResult.inputTokens} in / ${externalResult.outputTokens} out`);
    console.log(`Cost: tokens=$${externalResult.cost.tokenCost.toFixed(6)} + search=$${externalResult.cost.searchCost.toFixed(6)} = $${externalResult.cost.total.toFixed(6)}`);
    console.log(`\nSearch results fed to LLM:`);
    for (const r of externalResult.searchResults) {
      console.log(`  - ${r.title} (${r.url})`);
    }
    console.log(`\nResponse:\n${externalResult.text}`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    externalResult = null;
  }

  // Compare
  if (nativeResult && externalResult) {
    console.log(`\n--- COMPARISON ---`);
    const nativeBrands = extractBrands(nativeResult.text);
    const externalBrands = extractBrands(externalResult.text);
    const overlap = nativeBrands.filter(b => externalBrands.some(eb => eb.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(eb.toLowerCase())));

    console.log(`Native brands: ${nativeBrands.join(", ")}`);
    console.log(`${externalLabel} brands: ${externalBrands.join(", ")}`);
    console.log(`Overlap: ${overlap.length}/${Math.max(nativeBrands.length, externalBrands.length)} brands match`);
    console.log(`Token delta: ${externalResult.inputTokens - nativeResult.inputTokens} more input tokens with ${externalLabel}`);
    console.log(`Cost delta: $${(externalResult.cost.total - nativeResult.cost.total).toFixed(6)} (${externalResult.cost.total < nativeResult.cost.total ? "CHEAPER" : "MORE EXPENSIVE"})`);
    console.log(`Cost savings: ${((1 - externalResult.cost.total / nativeResult.cost.total) * 100).toFixed(1)}%`);
  }

  return { nativeResult, externalResult };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Grounding vs External Search A/B Test");
  console.log(`Testing ${TEST_PROMPTS.length} prompts × 3 providers = ${TEST_PROMPTS.length * 3} comparisons\n`);

  const totals = {
    google:    { nativeCost: 0, externalCost: 0, nativeTokensIn: 0, externalTokensIn: 0 },
    openai:    { nativeCost: 0, externalCost: 0, nativeTokensIn: 0, externalTokensIn: 0 },
    anthropic: { nativeCost: 0, externalCost: 0, nativeTokensIn: 0, externalTokensIn: 0 },
  };

  for (const prompt of TEST_PROMPTS) {
    // Google: native googleSearch vs Firecrawl
    const g = await runComparison(prompt, "Google (Gemini Flash)", nativeGoogle, firecrawlGoogle, "Firecrawl");
    if (g.nativeResult) { totals.google.nativeCost += g.nativeResult.cost.total; totals.google.nativeTokensIn += g.nativeResult.inputTokens; }
    if (g.externalResult) { totals.google.externalCost += g.externalResult.cost.total; totals.google.externalTokensIn += g.externalResult.inputTokens; }

    // OpenAI: native web_search vs Firecrawl
    const o = await runComparison(prompt, "OpenAI (GPT-5.4-mini)", nativeOpenAI, firecrawlOpenAI, "Firecrawl");
    if (o.nativeResult) { totals.openai.nativeCost += o.nativeResult.cost.total; totals.openai.nativeTokensIn += o.nativeResult.inputTokens; }
    if (o.externalResult) { totals.openai.externalCost += o.externalResult.cost.total; totals.openai.externalTokensIn += o.externalResult.inputTokens; }

    // Anthropic: native web_search vs Brave
    const a = await runComparison(prompt, "Anthropic (Haiku)", nativeAnthropic, braveAnthropic, "Brave");
    if (a.nativeResult) { totals.anthropic.nativeCost += a.nativeResult.cost.total; totals.anthropic.nativeTokensIn += a.nativeResult.inputTokens; }
    if (a.externalResult) { totals.anthropic.externalCost += a.externalResult.cost.total; totals.anthropic.externalTokensIn += a.externalResult.inputTokens; }
  }

  // Summary
  console.log(`\n${"=".repeat(80)}`);
  console.log("TOTALS (across all 3 prompts)");
  console.log("=".repeat(80));

  for (const [name, t] of Object.entries(totals)) {
    const savings = ((1 - t.externalCost / t.nativeCost) * 100).toFixed(1);
    const tokenDelta = t.externalTokensIn - t.nativeTokensIn;
    console.log(`\n${name.toUpperCase()}:`);
    console.log(`  Native cost:   $${t.nativeCost.toFixed(6)} (${t.nativeTokensIn} input tokens)`);
    console.log(`  External cost: $${t.externalCost.toFixed(6)} (${t.externalTokensIn} input tokens)`);
    console.log(`  Savings:       ${savings}% ($${(t.nativeCost - t.externalCost).toFixed(6)})`);
    console.log(`  Token delta:   +${tokenDelta} input tokens with external search`);
  }

  const totalNative = totals.google.nativeCost + totals.openai.nativeCost + totals.anthropic.nativeCost;
  const totalExternal = totals.google.externalCost + totals.openai.externalCost + totals.anthropic.externalCost;
  console.log(`\nALL PROVIDERS COMBINED:`);
  console.log(`  Native:   $${totalNative.toFixed(6)}`);
  console.log(`  External: $${totalExternal.toFixed(6)}`);
  console.log(`  Savings:  ${((1 - totalExternal / totalNative) * 100).toFixed(1)}% ($${(totalNative - totalExternal).toFixed(6)})`);
  console.log(`\n  Extrapolated to 48 prompts/audit:`);
  console.log(`  Native:   $${(totalNative / TEST_PROMPTS.length * 48).toFixed(4)}`);
  console.log(`  External: $${(totalExternal / TEST_PROMPTS.length * 48).toFixed(4)}`);
  console.log(`  Savings:  $${((totalNative - totalExternal) / TEST_PROMPTS.length * 48).toFixed(4)}/audit`);
}

main().catch(console.error);
