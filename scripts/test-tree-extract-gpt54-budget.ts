/**
 * Diagnostic script — kept per ES-086 AC-11 as a runnable SDK regression detector.
 *
 * Bypasses the production Promise.race timeout wrapper to probe OpenAI
 * gpt-5.4 reasoning-model SDK behavior directly. Useful when:
 *   - SDK version bumps to verify max_completion_tokens compatibility
 *   - Suspected reasoning-token regressions on gpt-5.4 / o-series models
 *   - Manipal-class fixture re-validation post-prompt-restructure
 *
 * NOT invoked from application code. Operator-only.
 *
 * History: this script empirically validated TS-086 §2.2 (gpt-5.4 OQ-1
 * resolution sweep — 3 budgets, reasoning_tokens=0 across all) and
 * locked in 20K as the post-fix budget for the OpenAI fallback.
 *
 * The HolePoker OQ-1 concern was that 20K tokens (the Sonnet sweet spot)
 * may be tight for gpt-5.4 because reasoning models consume reasoning
 * tokens INTERNALLY that count against max_completion_tokens but never
 * appear in the output text. The diagnostic verified reasoning_tokens === 0
 * for tree extraction (the prompt is transformation, not planning), so
 * 20K is the validated sweet spot.
 *
 * Run:
 *   ~/.nvm/versions/node/v22.12.0/bin/node --env-file=.env.local \
 *     ./node_modules/.bin/tsx scripts/test-tree-extract-gpt54-budget.ts
 */

import OpenAI from "openai";
import postgres from "postgres";

const TEST_SITE_ID = "manipal-ts083-79f1775171a9";
const MODEL = "gpt-5.4";  // codebase primary OpenAI model (NOT a typo)
const BUDGETS_TO_TEST = [20_000, 30_000, 40_000];

const SYSTEM_PROMPT = `You are a business analysis expert. Given a page inventory from a website crawl, extract:

1. **Geographic Tree** (geoTree): Where the business operates. Structure: Global → Country → State → City (leaf).
   - Use ISO-style IDs: "in" for India, "in-ka" for Karnataka, "in-ka-blr" for Bangalore.
   - If the business is purely digital/SaaS with no physical presence, return an empty tree (Global root, no children, leafCount=0).
   - Max 500 city-level leaf nodes.

2. **Category Tree** (categoryTree): What the business offers. Structure: Industry → Business Line → Service/Product (leaf).
   - Use kebab-case IDs: "healthcare", "healthcare-oncology", "healthcare-oncology-chemo".
   - Max 100 leaf nodes.

3. **Sparse Mapping** (mapping): Which categories are valid at which locations.
   - strength: "strong" (dedicated page exists), "moderate" (mentioned on a page), "inferred" (LLM inferred).
   - Max 1000 entries. Prefer leaf-level geoId and categoryId.

Return ONLY valid JSON matching this schema:
{
  "geoTree": { "root": GeoNode, "leafCount": number, "extractedAt": string },
  "categoryTree": { "root": CategoryNode, "leafCount": number, "extractedAt": string },
  "mapping": { "entries": GeoCategoryEntry[], "totalEntries": number, "extractedAt": string }
}

GeoNode: { id, name, level ("global"|"country"|"state"|"city"), children: GeoNode[], pageCount, evidence: string[] }
CategoryNode: { id, name, level (number, 0=root), children: CategoryNode[], pageCount, evidence: string[] }
GeoCategoryEntry: { geoId, categoryId, strength ("strong"|"moderate"|"inferred"), evidence: string[] }

No prose. No markdown. No code fences. JSON only.`;

const MAX_INVENTORY_PAGES = 200;
const STRUCTURAL_TYPES = new Set([
  "homepage",
  "about",
  "services",
  "pricing",
  "team",
  "contact",
]);

interface CrawledPage {
  url: string;
  pageType: string;
  title?: string;
  h1?: string;
  headings?: Array<{ level: number; text: string }>;
}

function sanitize(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function buildPageInventory(pages: CrawledPage[]): string {
  if (pages.length === 0) return "No pages crawled.";
  const structural: CrawledPage[] = [];
  const rest: CrawledPage[] = [];
  for (const page of pages) {
    if (STRUCTURAL_TYPES.has(page.pageType)) structural.push(page);
    else rest.push(page);
  }
  const selected = [...structural, ...rest].slice(0, MAX_INVENTORY_PAGES);
  return selected
    .map((page) => {
      const headingsList = (page.headings ?? [])
        .map((h) => `${"#".repeat(h.level)} ${sanitize(h.text, 200)}`)
        .join(", ");
      return [
        `URL: ${page.url}`,
        `Type: ${page.pageType}`,
        `Title: ${sanitize(page.title, 200)}`,
        `H1: ${sanitize(page.h1, 200)}`,
        headingsList ? `Headings: ${headingsList}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .join("\n");
}

interface RunResult {
  budget: number;
  success: boolean;
  dt_sec: number;
  stop_reason?: string;
  input_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  output_text_length?: number;
  parsed?: boolean;
  geo_leaf?: number;
  cat_leaf?: number;
  mapping_entries?: number;
  error?: string;
}

async function runOnce(client: OpenAI, userPrompt: string, budget: number): Promise<RunResult> {
  console.log(`\n[budget=${budget}] calling ${MODEL} with max_completion_tokens=${budget}, temperature=0...`);
  const t0 = Date.now();

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: budget,  // canonical field for OpenAI reasoning models
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const dt_sec = (Date.now() - t0) / 1000;
    const choice = response.choices[0];
    const usage = response.usage;

    // Reasoning tokens may be in usage.completion_tokens_details.reasoning_tokens
    const reasoning_tokens =
      (usage as unknown as { completion_tokens_details?: { reasoning_tokens?: number } })
        ?.completion_tokens_details?.reasoning_tokens;

    const text = choice.message?.content ?? "";
    const stop_reason = choice.finish_reason;

    console.log(`    returned in ${dt_sec.toFixed(1)}s`);
    console.log(`    finish_reason: ${stop_reason}`);
    console.log(`    usage: input=${usage?.prompt_tokens} completion=${usage?.completion_tokens} reasoning=${reasoning_tokens ?? "n/a"}`);
    console.log(`    response text length: ${text.length} chars`);

    const result: RunResult = {
      budget,
      success: true,
      dt_sec,
      stop_reason: stop_reason ?? undefined,
      input_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      reasoning_tokens,
      output_text_length: text.length,
      parsed: false,
    };

    if (stop_reason === "length") {
      console.warn(`    ⚠️  HIT MAX COMPLETION TOKENS — output likely truncated`);
    }

    // Try to parse
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const parsed = JSON.parse(cleaned) as {
        geoTree?: { leafCount?: number; root?: { children?: unknown[] } };
        categoryTree?: { leafCount?: number };
        mapping?: { totalEntries?: number; entries?: unknown[] };
      };
      result.parsed = true;
      result.geo_leaf = parsed.geoTree?.leafCount ?? 0;
      result.cat_leaf = parsed.categoryTree?.leafCount ?? 0;
      result.mapping_entries = parsed.mapping?.entries?.length ?? parsed.mapping?.totalEntries ?? 0;
      console.log(`    ✓ JSON parsed: geo_leaf=${result.geo_leaf} cat_leaf=${result.cat_leaf} mapping=${result.mapping_entries}`);
    } catch (parseErr) {
      console.error(`    ✗ JSON parse FAILED: ${(parseErr as Error).message}`);
      const fs = await import("node:fs");
      fs.writeFileSync(`/tmp/gpt54-response-${budget}.json`, text);
      console.log(`    Full response → /tmp/gpt54-response-${budget}.json`);
    }

    return result;
  } catch (err) {
    const dt_sec = (Date.now() - t0) / 1000;
    console.error(`    ✗ API call FAILED: ${(err as Error).message}`);
    return {
      budget,
      success: false,
      dt_sec,
      error: (err as Error).message,
    };
  }
}

async function main(): Promise<void> {
  console.log(`[test-tree-extract-gpt54-budget] mode=DIAGNOSTIC site=${TEST_SITE_ID} model=${MODEL}`);
  console.log(`[test-tree-extract-gpt54-budget] budgets: ${BUDGETS_TO_TEST.join(", ")}`);

  const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 1 });
  const [row] = (await sql`
    SELECT id, domain, crawl_data FROM geo_sites WHERE id = ${TEST_SITE_ID}
  `) as Array<{ id: string; domain: string; crawl_data: { pages: CrawledPage[] } }>;
  await sql.end();

  if (!row) {
    console.error(`FATAL: row ${TEST_SITE_ID} not found`);
    process.exit(1);
  }

  const pages = row.crawl_data?.pages ?? [];
  console.log(`[1] Loaded test row. pages=${pages.length}`);

  const inventory = buildPageInventory(pages);
  const userPrompt = `<page_inventory>\n${inventory}\n</page_inventory>\n\n<domain>${row.domain}</domain>\n<industry>Healthcare</industry>\n`;
  console.log(`[2] Inventory built. ${inventory.split("\n").length} lines, ${inventory.length} chars, prompt ${userPrompt.length} chars`);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("FATAL: OPENAI_API_KEY missing");
    process.exit(2);
  }
  const client = new OpenAI({ apiKey });

  const results: RunResult[] = [];
  for (const budget of BUDGETS_TO_TEST) {
    const result = await runOnce(client, userPrompt, budget);
    results.push(result);
    if (result.parsed && (result.geo_leaf ?? 0) > 0) {
      console.log(`\n[stop-early] budget=${budget} produced a populated tree; continuing to measure higher budgets for comparison`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`SUMMARY — gpt-5.4 budget sweep for Manipal-class fixture`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log("budget  | success | dt_sec | stop_reason | input  | compl  | reason | parsed | geo | cat | map");
  for (const r of results) {
    if (!r.success) {
      console.log(`${String(r.budget).padEnd(7)} | FAIL    | ${r.dt_sec.toFixed(1).padStart(6)} | ${r.error ?? ""}`);
      continue;
    }
    const reason = r.reasoning_tokens ?? "n/a";
    console.log(
      `${String(r.budget).padEnd(7)} | ${(r.success ? "ok" : "no").padEnd(7)} | ${r.dt_sec.toFixed(1).padStart(6)} | ${(r.stop_reason ?? "").padEnd(11)} | ${String(r.input_tokens ?? "").padEnd(6)} | ${String(r.completion_tokens ?? "").padEnd(6)} | ${String(reason).padEnd(6)} | ${r.parsed ? "✓" : "✗"}       | ${String(r.geo_leaf ?? "-").padStart(3)} | ${String(r.cat_leaf ?? "-").padStart(3)} | ${String(r.mapping_entries ?? "-").padStart(3)}`
    );
  }

  // Pick the sweet spot: smallest budget that produced a populated tree
  const populated = results.find(r => r.parsed && (r.geo_leaf ?? 0) > 0);
  if (populated) {
    console.log(`\n✅ gpt-5.4 sweet spot: max_completion_tokens=${populated.budget}`);
    if (populated.reasoning_tokens != null && populated.completion_tokens != null) {
      const output_only = populated.completion_tokens - populated.reasoning_tokens;
      console.log(`    reasoning_tokens: ${populated.reasoning_tokens}`);
      console.log(`    output_tokens   : ${output_only}`);
      console.log(`    total consumed  : ${populated.completion_tokens}`);
    }
  } else {
    console.log(`\n❌ NO budget produced a populated tree — gpt-5.4 may need >40K, or streaming, or different prompt`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(99);
});
