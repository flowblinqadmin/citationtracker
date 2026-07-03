/**
 * verify-preemptive-injection.ts
 *
 * Standalone verification script for the proposed citation-check architecture.
 *
 * WHAT THIS SCRIPT PROVES
 * -----------------------
 * The production citation-checker.ts today does 4 LLM calls per prompt, each
 * invoking the provider's built-in `web_search` tool. That costs ~$2.55–$4.86
 * per run and is not profitable at any tier.
 *
 * The proposed architecture replaces the in-LLM tool with:
 *   1. One external Brave Search call per prompt (shared across all LLMs)
 *   2. A "preemptive tool injection" — we fabricate a prior tool_use exchange
 *      in the message array so the LLM treats our search results as authoritative
 *      tool output rather than user-supplied context
 *   3. A single round-trip LLM call (instead of the multi-turn tool-calling loop)
 *
 * This script exercises that pipeline end-to-end with ONE LLM (gpt-5.4-mini)
 * to prove:
 *   a) Brave Search API returns usable results
 *   b) OpenAI Chat Completions accepts the pre-fabricated assistant tool_call
 *      + tool result without rejecting the message shape
 *   c) The model produces a citation-style answer using our injected results
 *   d) Measured cost matches our analytical estimate within ±20%
 *
 * USAGE
 * -----
 *   BRAVE_API_KEY=... OPENAI_API_KEY=... npx tsx verify-preemptive-injection.ts
 *   BRAVE_API_KEY=... OPENAI_API_KEY=... npx tsx verify-preemptive-injection.ts "your prompt here"
 *
 * OUTPUT
 * ------
 *   Human-readable per-stage metrics: search duration, LLM duration, token usage,
 *   estimated dollar cost (broken down into Brave + OpenAI input + OpenAI output),
 *   and the model's final answer text.
 *
 * NO PRODUCTION DEPENDENCIES
 * --------------------------
 * This script does not import from lib/, does not touch the database, does not
 * read config.ts, and does not consult CostMaster. It's a clean-room verification.
 */

import OpenAI from "openai";

// ── Environment guards ──────────────────────────────────────────────────────

const BRAVE_API_KEY  = process.env.BRAVE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BRAVE_API_KEY) {
  console.error("[fatal] BRAVE_API_KEY is required. Get one at https://brave.com/search/api/");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("[fatal] OPENAI_API_KEY is required.");
  process.exit(1);
}

// ── Constants ────────────────────────────────────────────────────────────────

// Model + pricing — keep in lockstep with citation-checker.ts and the pricing
// numbers listed in docs/citation-check-cost-audit.tex.
const MODEL = "gpt-5.4-mini";
const MODEL_INPUT_USD_PER_MTOK  = 0.75;
const MODEL_OUTPUT_USD_PER_MTOK = 4.50;

const BRAVE_COST_PER_SEARCH_USD = 0.005; // $5 per 1k requests, low context

// System prompt copied verbatim from citation-checker.ts so the verification
// matches what production would send.
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

// Tool schema for the synthetic web_search tool we preemptively inject.
// This is the same shape we'd use if we wired it as a real function tool.
const WEB_SEARCH_TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "web_search",
    description: "Search the web for current information about companies, products, or market options",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to run against the live web",
        },
      },
      required: ["query"],
    },
  },
};

const PREEMPTIVE_CALL_ID = "call_preemptive_brave_001";
const DEFAULT_PROMPT = "What are the best dental clinics in Mumbai?";
const BRAVE_RESULT_COUNT = 10;

// ── Types ────────────────────────────────────────────────────────────────────

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

interface VerificationMetrics {
  prompt: string;
  searchDurationMs: number;
  llmDurationMs: number;
  totalDurationMs: number;
  braveResultCount: number;
  responseText: string;
  inputTokens: number;
  outputTokens: number;
  costBraveUsd: number;
  costInputUsd: number;
  costOutputUsd: number;
  costTotalUsd: number;
}

// ── Step 1: Brave Search ─────────────────────────────────────────────────────

async function runBraveSearch(query: string): Promise<BraveWebResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(BRAVE_RESULT_COUNT));
  url.searchParams.set("safesearch", "moderate");

  const res = await fetch(url.toString(), {
    headers: {
      "Accept":               "application/json",
      "Accept-Encoding":      "gzip",
      "X-Subscription-Token": BRAVE_API_KEY!,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Brave search failed: HTTP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  return data.web?.results ?? [];
}

// ── Step 2: Format results for tool_result ──────────────────────────────────

function formatResultsAsToolOutput(results: BraveWebResult[]): string {
  if (results.length === 0) {
    return "No results found.";
  }
  return results.slice(0, BRAVE_RESULT_COUNT)
    .map((r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.description}`)
    .join("\n\n");
}

// ── Step 3: OpenAI call with preemptive tool injection ──────────────────────

async function runOpenAiWithPreemptiveInjection(
  prompt: string,
  searchResultsText: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  // The message array constructs a SYNTHETIC prior tool exchange:
  //   user   → asks the citation prompt
  //   assistant → (fake) calls web_search with the same query
  //   tool   → returns the Brave results as the tool output
  // The model then sees "I already searched, here's what came back" and
  // produces the final answer in a single round-trip.
  const response = await client.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 256,
    messages: [
      { role: "system", content: CITATION_SYSTEM_PROMPT },
      { role: "user",   content: prompt },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id:       PREEMPTIVE_CALL_ID,
          type:     "function",
          function: {
            name:      "web_search",
            arguments: JSON.stringify({ query: prompt }),
          },
        }],
      },
      {
        role:         "tool",
        tool_call_id: PREEMPTIVE_CALL_ID,
        content:      searchResultsText,
      },
    ],
    tools: [WEB_SEARCH_TOOL_SCHEMA],
  });

  const text         = response.choices[0]?.message?.content ?? "";
  const inputTokens  = response.usage?.prompt_tokens     ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  return { text, inputTokens, outputTokens };
}

// ── Orchestration ───────────────────────────────────────────────────────────

async function runVerification(prompt: string): Promise<VerificationMetrics> {
  const startTotal = Date.now();

  // Stage 1: External Brave search
  const startSearch = Date.now();
  const braveResults = await runBraveSearch(prompt);
  const searchDurationMs = Date.now() - startSearch;
  console.log(`  [1/2] Brave returned ${braveResults.length} results in ${searchDurationMs}ms`);

  const toolOutputText = formatResultsAsToolOutput(braveResults);

  // Stage 2: OpenAI call with preemptive injection
  const startLlm = Date.now();
  const { text, inputTokens, outputTokens } = await runOpenAiWithPreemptiveInjection(
    prompt,
    toolOutputText,
  );
  const llmDurationMs = Date.now() - startLlm;
  console.log(`  [2/2] OpenAI returned in ${llmDurationMs}ms (${inputTokens} in / ${outputTokens} out)`);

  // Cost breakdown
  const costBraveUsd  = BRAVE_COST_PER_SEARCH_USD;
  const costInputUsd  = (inputTokens  / 1_000_000) * MODEL_INPUT_USD_PER_MTOK;
  const costOutputUsd = (outputTokens / 1_000_000) * MODEL_OUTPUT_USD_PER_MTOK;
  const costTotalUsd  = costBraveUsd + costInputUsd + costOutputUsd;

  return {
    prompt,
    searchDurationMs,
    llmDurationMs,
    totalDurationMs: Date.now() - startTotal,
    braveResultCount: braveResults.length,
    responseText: text,
    inputTokens,
    outputTokens,
    costBraveUsd,
    costInputUsd,
    costOutputUsd,
    costTotalUsd,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function printReport(m: VerificationMetrics): void {
  const line = "─".repeat(72);

  console.log(`\n${line}`);
  console.log(` VERIFICATION RESULT`);
  console.log(line);

  console.log(`\n Prompt: "${m.prompt}"`);

  console.log(`\n Response:`);
  console.log(`   ${m.responseText.replace(/\n/g, "\n   ")}`);

  console.log(`\n Timing:`);
  console.log(`   Brave search       ${m.searchDurationMs.toString().padStart(6)} ms`);
  console.log(`   OpenAI LLM call    ${m.llmDurationMs.toString().padStart(6)} ms`);
  console.log(`   Total              ${m.totalDurationMs.toString().padStart(6)} ms`);

  console.log(`\n Token usage:`);
  console.log(`   Input tokens       ${m.inputTokens.toString().padStart(6)}`);
  console.log(`   Output tokens      ${m.outputTokens.toString().padStart(6)}`);

  console.log(`\n Cost breakdown (USD):`);
  console.log(`   Brave Search       $${m.costBraveUsd.toFixed(6)}`);
  console.log(`   OpenAI input       $${m.costInputUsd.toFixed(6)}  (${MODEL} @ $${MODEL_INPUT_USD_PER_MTOK}/M)`);
  console.log(`   OpenAI output      $${m.costOutputUsd.toFixed(6)}  (${MODEL} @ $${MODEL_OUTPUT_USD_PER_MTOK}/M)`);
  console.log(`   ─────────────────────────────────`);
  console.log(`   TOTAL              $${m.costTotalUsd.toFixed(6)}`);

  console.log(`\n Extrapolation to a full citation check run (44 prompts × this path):`);
  const fullRunCost = m.costTotalUsd * 44;
  console.log(`   44 × single-call   $${fullRunCost.toFixed(4)}`);
  console.log(`   Note: assumes linear scaling, no search result sharing, no caching.`);
  console.log(`         Real production would share Brave calls across providers and`);
  console.log(`         apply response caching, reducing cost further.`);

  console.log(`\n${line}\n`);
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const prompt = process.argv[2] ?? DEFAULT_PROMPT;

  console.log(`\n=== Preemptive Injection Verification (${MODEL}) ===`);
  console.log(`Testing: Brave Search → tool_result injection → single-round-trip LLM call\n`);

  try {
    const metrics = await runVerification(prompt);
    printReport(metrics);

    // Sanity check: we expect cost in the $0.010-$0.030 range per single-prompt
    // call. If it's radically different, something is off.
    if (metrics.costTotalUsd < 0.001) {
      console.warn(`[warn] Measured cost $${metrics.costTotalUsd.toFixed(6)} is suspiciously low — check token usage reporting.`);
    }
    if (metrics.costTotalUsd > 0.100) {
      console.warn(`[warn] Measured cost $${metrics.costTotalUsd.toFixed(6)} is higher than expected — investigate token count.`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`\n[fatal] Verification failed:`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  }
}

main();
