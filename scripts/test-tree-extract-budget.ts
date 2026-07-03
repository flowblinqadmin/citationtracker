/**
 * Diagnostic script — kept per ES-086 AC-11 as a runnable SDK regression detector.
 *
 * Bypasses the production Promise.race timeout wrapper to probe Anthropic
 * SDK behavior directly. Useful when:
 *   - SDK version bumps to verify field-name compatibility
 *   - Suspected reasoning-token regressions on Sonnet
 *   - Manipal-class fixture re-validation post-prompt-restructure
 *
 * NOT invoked from application code. Operator-only.
 *
 * History: this script was the empirical validation of TS-086 §2.1
 * (5-budget Sonnet sweep) that locked in 20K as the post-fix budget.
 *
 * Run:
 *   ~/.nvm/versions/node/v22.12.0/bin/node --env-file=.env.local \
 *     ./node_modules/.bin/tsx scripts/test-tree-extract-budget.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import postgres from "postgres";

const TEST_SITE_ID = "manipal-ts083-79f1775171a9";
const NEW_MAX_TOKENS = 20_000;  // 24000 hit streaming wall, 16000 truncated

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

async function main(): Promise<void> {
  console.log(`[test-tree-extract-budget] mode=DIAGNOSTIC site=${TEST_SITE_ID} max_tokens=${NEW_MAX_TOKENS}`);

  // ── 1. Read test row from production ─────────────────────────────────────
  const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 1 });

  const [row] = (await sql`
    SELECT id, domain, crawl_data, discovery_data
    FROM geo_sites WHERE id = ${TEST_SITE_ID}
  `) as Array<{ id: string; domain: string; crawl_data: { pages: CrawledPage[] }; discovery_data: unknown }>;

  if (!row) {
    console.error(`FATAL: row ${TEST_SITE_ID} not found`);
    await sql.end();
    process.exit(1);
  }

  const pages = row.crawl_data?.pages ?? [];
  console.log(`[1] Loaded test row. domain=${row.domain} pages=${pages.length}`);

  // ── 2. Build the inventory ────────────────────────────────────────────────
  const inventory = buildPageInventory(pages);
  const userPrompt = `<page_inventory>\n${inventory}\n</page_inventory>\n\n<domain>${row.domain}</domain>\n<industry>Healthcare</industry>\n`;

  const inventoryChars = inventory.length;
  const userPromptChars = userPrompt.length;
  const estInputTokens = Math.ceil(userPromptChars / 4);
  console.log(`[2] Inventory built. ${pages.length} pages → ${MAX_INVENTORY_PAGES} cap → ${inventory.split("\n").length} lines`);
  console.log(`    inventoryChars=${inventoryChars} userPromptChars=${userPromptChars} estInputTokens=${estInputTokens}`);

  // ── 3. Call Sonnet with bumped budget ─────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("FATAL: ANTHROPIC_API_KEY missing");
    await sql.end();
    process.exit(2);
  }

  const client = new Anthropic({ apiKey });

  console.log(`[3] Calling Sonnet (model=claude-sonnet-4-6, max_completion_tokens=${NEW_MAX_TOKENS}, temperature=0)...`);
  const t0 = Date.now();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: NEW_MAX_TOKENS,  // ← Anthropic uses max_tokens, NOT max_completion_tokens
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
  } catch (err) {
    console.error(`FATAL: Sonnet call threw: ${(err as Error).message}`);
    await sql.end();
    process.exit(3);
  }

  const dt = Date.now() - t0;
  console.log(`[3] Sonnet returned in ${(dt / 1000).toFixed(1)}s`);
  console.log(`    stop_reason: ${response.stop_reason}`);
  console.log(`    usage: input=${response.usage.input_tokens} output=${response.usage.output_tokens}`);

  const text = (response.content[0] as { type: string; text?: string }).text ?? "";
  console.log(`    response text length: ${text.length} chars`);

  if (response.stop_reason === "max_tokens") {
    console.warn(`⚠️  HIT MAX TOKENS — output likely truncated. Need to bump higher.`);
  }

  // ── 4. Parse the response ────────────────────────────────────────────────
  console.log(`[4] Parsing JSON response...`);
  let parsed: unknown;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    parsed = JSON.parse(cleaned);
    console.log(`    ✓ JSON parsed successfully`);
  } catch (err) {
    console.error(`    ✗ JSON parse FAILED: ${(err as Error).message}`);
    const fs = await import("node:fs");
    fs.writeFileSync("/tmp/sonnet-response.json", text);
    console.log(`    Full response written to /tmp/sonnet-response.json (${text.length} chars)`);
    console.log(`    --- first 300 chars ---`);
    console.log(text.slice(0, 300));
    console.log(`    --- last 300 chars ---`);
    console.log(text.slice(-300));
    await sql.end();
    process.exit(4);
  }

  // ── 5. Inspect the parsed tree ────────────────────────────────────────────
  const result = parsed as {
    geoTree: { root: { children: unknown[] }; leafCount: number };
    categoryTree: { root: { children: unknown[] }; leafCount: number };
    mapping: { entries: unknown[]; totalEntries: number };
  };

  console.log(`[5] Tree summary:`);
  console.log(`    geoTree.leafCount: ${result.geoTree.leafCount}`);
  console.log(`    geoTree.root.children: ${result.geoTree.root.children.length}`);
  console.log(`    categoryTree.leafCount: ${result.categoryTree.leafCount}`);
  console.log(`    categoryTree.root.children: ${result.categoryTree.root.children.length}`);
  console.log(`    mapping.totalEntries: ${result.mapping.totalEntries}`);
  console.log(`    mapping.entries.length: ${result.mapping.entries.length}`);

  if (result.geoTree.leafCount > 0) {
    console.log(`\n✅ SUCCESS — geo tree is populated. The 8000 → ${NEW_MAX_TOKENS} bump fixes the empty-tree fallback.`);
  } else {
    console.log(`\n❌ FAILED — geo tree still empty. Token budget is NOT the only issue.`);
  }

  // ── 6. Sample the geoTree contents ────────────────────────────────────────
  console.log(`\n[6] geoTree (first 1500 chars of pretty JSON):`);
  console.log(JSON.stringify(result.geoTree, null, 2).slice(0, 1500));

  console.log(`\n[7] categoryTree (first 1000 chars):`);
  console.log(JSON.stringify(result.categoryTree, null, 2).slice(0, 1000));

  await sql.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(99);
});
