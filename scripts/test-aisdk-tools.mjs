/**
 * Tool-use test round 2: Brave search + Firecrawl scrape via function calling.
 * Fixes from round 1: Google response format, FirecrawlAppV1, OpenAI tool_choice auto.
 * Native results saved from previous run — only tool-use calls are made.
 *
 * Run: node --env-file=.env.local scripts/test-aisdk-tools.mjs
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

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

const PRICING = {
  "gpt-5.4-mini":              { input: 0.75, output: 4.50 },
  "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00 },
  "gemini-2.5-flash":          { input: 0.30, output: 2.50 },
};

const NATIVE_RESULTS = {
  google: [
    { prompt: TEST_PROMPTS[0], cost: 0.035764, inputTokens: 198, outputTokens: 282, brands: ["Narayana Health City", "Sakra World Hospital", "Manipal Hospitals", "Fortis Hospital", "Apollo Hospitals", "BGS Gleneagles", "Sri Jayadeva Institute"] },
    { prompt: TEST_PROMPTS[1], cost: 0.035887, inputTokens: 205, outputTokens: 330, brands: ["Local Dominator", "Profound", "Brandi AI", "Semrush AI Toolkit", "BrightLocal", "Localo", "Geoptie"] },
    { prompt: TEST_PROMPTS[2], cost: 0.035855, inputTokens: 199, outputTokens: 318, brands: ["Zoho CRM", "Pipedrive", "Salesforce", "ActiveCampaign", "Freshsales", "monday.com CRM", "Keap"] },
  ],
  openai: [
    { prompt: TEST_PROMPTS[0], cost: 0.017712, inputTokens: 8747, outputTokens: 256, brands: ["Sri Jayadeva Institute", "Narayana Institute", "Apollo Hospitals"] },
    { prompt: TEST_PROMPTS[1], cost: 0.017711, inputTokens: 8745, outputTokens: 256, brands: ["AthenaHQ", "Writesonic", "Wix AI Visibility"] },
    { prompt: TEST_PROMPTS[2], cost: 0.017664, inputTokens: 8683, outputTokens: 256, brands: ["Pipedrive", "Zoho CRM", "Freshsales", "monday CRM", "Insightly", "Nutshell"] },
  ],
  anthropic: [
    { prompt: TEST_PROMPTS[0], cost: 0.028185, inputTokens: 16610, outputTokens: 315, brands: ["Narayana Multispeciality Hospital", "Manipal Hospital", "Sakra World Hospital", "Aster CMI Hospital"] },
    { prompt: TEST_PROMPTS[1], cost: 0.030769, inputTokens: 19174, outputTokens: 319, brands: ["SE Ranking", "Profound", "Geoptie", "Otterly.AI", "Search Party"] },
    { prompt: TEST_PROMPTS[2], cost: 0.031723, inputTokens: 20113, outputTokens: 322, brands: ["Zoho CRM", "Pipedrive", "EngageBay CRM", "ActiveCampaign"] },
  ],
};

// ── Tool execution ───────────────────────────────────────────────────────────

async function executeBraveSearch(query) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetch(url, { headers: { "X-Subscription-Token": BRAVE_API_KEY, Accept: "application/json" } });
  if (!res.ok) return { error: `Search failed: ${res.status}` };
  const data = await res.json();
  return { results: (data.web?.results || []).slice(0, 5).map(r => ({ title: r.title || "", url: r.url || "", description: (r.description || "").slice(0, 200) })) };
}

async function executeFirecrawlScrape(targetUrl) {
  const { FirecrawlAppV1 } = await import("@mendable/firecrawl-js");
  const fc = new FirecrawlAppV1({ apiKey: process.env.FIRECRAWL_API_KEY });
  try {
    const result = await Promise.race([
      fc.scrapeUrl(targetUrl, { formats: ["markdown"] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("scrape-timeout")), 10000)),
    ]);
    if (!result.success) return { error: "Scrape failed" };
    return { title: result.metadata?.title || "", content: (result.markdown || "").slice(0, 2000) };
  } catch (e) {
    return { error: e.message };
  }
}

async function executeToolCall(name, args) {
  if (name === "webSearch") return executeBraveSearch(args.query);
  if (name === "scrapePage") return executeFirecrawlScrape(args.url);
  return { error: `Unknown tool: ${name}` };
}

// ── Tool-use: Google (Gemini function calling) ───────────────────────────────

async function toolGoogle(prompt) {
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = client.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ functionDeclarations: [
      { name: "webSearch", description: "Search the web for current information about companies, products, and services. Use this to get up-to-date results before answering.", parameters: { type: SchemaType.OBJECT, properties: { query: { type: SchemaType.STRING, description: "Search query" } }, required: ["query"] } },
      { name: "scrapePage", description: "Scrape a webpage URL to get its full content. Use when a search result looks promising.", parameters: { type: SchemaType.OBJECT, properties: { url: { type: SchemaType.STRING, description: "URL to scrape" } }, required: ["url"] } },
    ] }],
  });
  const start = Date.now();
  const toolLog = [];
  let totalIn = 0, totalOut = 0;
  const chat = model.startChat();
  let res = await chat.sendMessage(prompt);
  totalIn += res.response.usageMetadata?.promptTokenCount || 0;
  totalOut += res.response.usageMetadata?.candidatesTokenCount || 0;

  for (let step = 0; step < 4; step++) {
    const fcs = res.response.functionCalls();
    if (!fcs?.length) break;
    const parts = [];
    for (const fc of fcs) {
      const args = fc.args || {};
      toolLog.push({ tool: fc.name, args });
      const result = await executeToolCall(fc.name, args);
      // Google requires functionResponse.response to be an object
      parts.push({ functionResponse: { name: fc.name, response: result } });
    }
    res = await chat.sendMessage(parts);
    totalIn += res.response.usageMetadata?.promptTokenCount || 0;
    totalOut += res.response.usageMetadata?.candidatesTokenCount || 0;
  }
  const text = res.response.text();
  const tokenCost = totalIn / 1e6 * 0.30 + totalOut / 1e6 * 2.50;
  const braveN = toolLog.filter(t => t.tool === "webSearch").length;
  const scrapeN = toolLog.filter(t => t.tool === "scrapePage").length;
  const toolCost = braveN * 0.005 + scrapeN * 0.0063;
  return { text, ms: Date.now() - start, inputTokens: totalIn, outputTokens: totalOut, toolLog, steps: toolLog.length + 1, cost: { tokens: tokenCost, tools: toolCost, total: tokenCost + toolCost } };
}

// ── Tool-use: OpenAI (Chat Completions function calling) ─────────────────────

const OAI_TOOLS = [
  { type: "function", function: { name: "webSearch", description: "Search the web for current information about companies, products, and services. Use this to get up-to-date results before answering.", parameters: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "scrapePage", description: "Scrape a webpage URL to get its full content. Use when a search result looks promising.", parameters: { type: "object", properties: { url: { type: "string", description: "URL to scrape" } }, required: ["url"], additionalProperties: false } } },
];

async function toolOpenAI(prompt) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const start = Date.now();
  const toolLog = [];
  let totalIn = 0, totalOut = 0;
  let messages = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }];

  for (let step = 0; step < 4; step++) {
    const res = await client.chat.completions.create({ model: "gpt-5.4-mini", messages, tools: OAI_TOOLS, tool_choice: "auto", max_completion_tokens: 512 });
    totalIn += res.usage?.prompt_tokens || 0;
    totalOut += res.usage?.completion_tokens || 0;
    const msg = res.choices[0]?.message;
    if (!msg) break;
    if (msg.tool_calls?.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        toolLog.push({ tool: tc.function.name, args });
        const result = await executeToolCall(tc.function.name, args);
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
    } else {
      const tokenCost = totalIn / 1e6 * 0.75 + totalOut / 1e6 * 4.50;
      const braveN = toolLog.filter(t => t.tool === "webSearch").length;
      const scrapeN = toolLog.filter(t => t.tool === "scrapePage").length;
      const toolCost = braveN * 0.005 + scrapeN * 0.0063;
      return { text: msg.content || "", ms: Date.now() - start, inputTokens: totalIn, outputTokens: totalOut, toolLog, steps: step + 1, cost: { tokens: tokenCost, tools: toolCost, total: tokenCost + toolCost } };
    }
  }
  return { text: "", ms: Date.now() - start, inputTokens: totalIn, outputTokens: totalOut, toolLog, steps: 4, cost: { tokens: 0, tools: 0, total: 0 } };
}

// ── Tool-use: Anthropic ──────────────────────────────────────────────────────

async function toolAnthropic(prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const start = Date.now();
  const toolLog = [];
  let totalIn = 0, totalOut = 0;
  const toolDefs = [
    { name: "webSearch", description: "Search the web for current information about companies, products, and services. Use this to get up-to-date results before answering.", input_schema: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] } },
    { name: "scrapePage", description: "Scrape a webpage URL to get its full content. Use when a search result looks promising.", input_schema: { type: "object", properties: { url: { type: "string", description: "URL to scrape" } }, required: ["url"] } },
  ];
  let messages = [{ role: "user", content: prompt }];

  for (let step = 0; step < 4; step++) {
    const res = await client.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 512, system: SYSTEM_PROMPT, tools: toolDefs, messages });
    totalIn += res.usage?.input_tokens || 0;
    totalOut += res.usage?.output_tokens || 0;
    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const toolResults = [];
      for (const block of res.content.filter(b => b.type === "tool_use")) {
        toolLog.push({ tool: block.name, args: block.input });
        const result = await executeToolCall(block.name, block.input);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: toolResults });
    } else {
      const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
      const tokenCost = totalIn / 1e6 * 1.00 + totalOut / 1e6 * 5.00;
      const braveN = toolLog.filter(t => t.tool === "webSearch").length;
      const scrapeN = toolLog.filter(t => t.tool === "scrapePage").length;
      const toolCost = braveN * 0.005 + scrapeN * 0.0063;
      return { text, ms: Date.now() - start, inputTokens: totalIn, outputTokens: totalOut, toolLog, steps: step + 1, cost: { tokens: tokenCost, tools: toolCost, total: tokenCost + toolCost } };
    }
  }
  return { text: "", ms: Date.now() - start, inputTokens: totalIn, outputTokens: totalOut, toolLog, steps: 4, cost: { tokens: 0, tools: 0, total: 0 } };
}

// ── Runner ───────────────────────────────────────────────────────────────────

function extractBrands(text) {
  const brands = new Set();
  for (const m of text.matchAll(/\*\*([^*]+)\*\*/g)) if (m[1].length > 2) brands.add(m[1].trim());
  if (brands.size === 0) for (const m of text.matchAll(/\d+\.\s+([A-Z][^\n—–-]+?)(?:\s*[—–-]|\s+is\b|\s+offers?\b)/g)) brands.add(m[1].trim());
  return [...brands];
}

function indent(t) { return t.split("\n").map(l => "    " + l).join("\n"); }

async function main() {
  console.log("ROUND 2: Tool-Use Test (Brave + Firecrawl, LLM decides)\n");

  let totalNative = 0, totalTool = 0;

  const providers = [
    { name: "GOOGLE", fn: toolGoogle, saved: NATIVE_RESULTS.google },
    { name: "OPENAI", fn: toolOpenAI, saved: NATIVE_RESULTS.openai },
    { name: "ANTHROPIC", fn: toolAnthropic, saved: NATIVE_RESULTS.anthropic },
  ];

  for (const { name, fn, saved } of providers) {
    for (let i = 0; i < TEST_PROMPTS.length; i++) {
      const prompt = TEST_PROMPTS[i];
      const native = saved[i];
      totalNative += native.cost;

      console.log(`\n${"=".repeat(90)}`);
      console.log(`${name} | "${prompt}"`);
      console.log("=".repeat(90));
      console.log(`  NATIVE (saved): $${native.cost.toFixed(5)} | ${native.inputTokens} in / ${native.outputTokens} out`);
      console.log(`    Brands: ${native.brands.join(" | ")}`);

      try {
        const r = await fn(prompt);
        totalTool += r.cost.total;
        const braveN = r.toolLog.filter(t => t.tool === "webSearch").length;
        const scrapeN = r.toolLog.filter(t => t.tool === "scrapePage").length;
        console.log(`\n  TOOL USE: $${r.cost.total.toFixed(5)} | ${r.inputTokens} in / ${r.outputTokens} out | ${r.steps} steps | ${r.ms}ms`);
        console.log(`    Tools: ${braveN} search + ${scrapeN} scrape`);
        for (const t of r.toolLog) {
          if (t.tool === "webSearch") console.log(`      -> search("${t.args.query}")`);
          else console.log(`      -> scrape(${t.args.url})`);
        }
        console.log(`\n${indent(r.text)}`);

        const tb = extractBrands(r.text);
        const overlap = native.brands.filter(b => tb.some(t => t.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(t.toLowerCase())));
        console.log(`\n    Tool brands:  ${tb.join(" | ")}`);
        console.log(`    Native brands: ${native.brands.join(" | ")}`);
        console.log(`    Overlap:  ${overlap.length}/${Math.max(native.brands.length, tb.length)} (${overlap.join(", ") || "none"})`);
        console.log(`    Savings:  ${((1 - r.cost.total / native.cost) * 100).toFixed(0)}%`);
      } catch (e) {
        console.log(`\n  FAILED: ${e.message}`);
      }
    }
  }

  console.log(`\n${"=".repeat(90)}`);
  console.log("TOTALS (3 prompts × 3 providers)");
  console.log(`  Native:  $${totalNative.toFixed(5)}`);
  console.log(`  Tool:    $${totalTool.toFixed(5)}`);
  console.log(`  Savings: ${((1 - totalTool / totalNative) * 100).toFixed(0)}%`);
  console.log(`\n  Per audit (48 prompts):`);
  console.log(`    Native:  $${(totalNative / 3 * 48).toFixed(4)}`);
  console.log(`    Tool:    $${(totalTool / 3 * 48).toFixed(4)}`);
  console.log(`    Savings: $${((totalNative - totalTool) / 3 * 48).toFixed(4)}/audit`);
}

main().catch(e => { console.error("Fatal:", e.message, e.stack?.split("\n").slice(0, 3).join("\n")); process.exit(1); });
