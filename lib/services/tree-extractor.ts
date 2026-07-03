/**
 * Tree Extraction Service — ES-053 / C2+C3
 *
 * Extracts geographic and category trees from crawl data via LLM.
 * Primary: Claude Sonnet 4 → Fallback: OpenAI (gpt-5.4 reasoning model) → Last resort: empty trees.
 *
 * ES-086 (2026-04-09): Field-name + budget + timeout + retry-policy + schema-validation
 * fix. See `geo/docs/specs/engineering/ES-086-tree-extractor-llm-call-broken.md` for the
 * full surface (30 ACs across 11 implementation areas).
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { CrawlData, CrawledPage, DiscoveryData, PageType } from "@/lib/services/geo-crawler";
import type { SiteArchitecture } from "@/lib/services/crawl-prioritizer";
import type {
  GeoTree, CategoryTree, GeoCategoryMapping, TreeExtractionResult,
  GeoNode, CategoryNode,
} from "@/lib/types/trees";
import { sanitizeForPrompt } from "@/lib/utils/sanitize-for-prompt";

// ── Constants ────────────────────────────────────────────────────────────────

// Bumped 200 → 150 on 2026-04-10 (Issue M) after observing Sonnet truncating
// its JSON response at position ~60K on Manipal-class inventories. A 150-page
// budget paired with selectInventoryPages() per-type quotas keeps the expected
// tree output under Sonnet's 32K max_tokens ceiling while still giving the
// extractor full structural coverage of the site.
const MAX_INVENTORY_PAGES = 150;
// ES-086 AC-12: bumped from 35_000 to 200_000. Real Manipal-class extractions
// take 150-200s end-to-end (see TS-086 §2.1 + §2.2 diagnostic sweeps). The
// previous 35s comment ("3 attempts × 35s = 105s max, under Vercel 120s limit")
// is removed because (a) the per-call cap was firing before any LLM could
// complete and (b) the citation-check route now has maxDuration=600 (AC-20).
export const EXTRACTION_TIMEOUT_MS = 200_000;
const GEO_LEAF_CAP = 500;
// Bumped 100 → 150 on 2026-04-09 after live Manipal exercise showed legitimate
// healthcare taxonomies produce 106-109 category leaves (26 top-level specialties
// × city sub-trees). TS-086 §2.1 set the cap at the exact observed value of the
// validated run (100), leaving zero headroom. 150 accommodates real-world
// variance without capping excessive LLM hallucinations.
const CATEGORY_LEAF_CAP = 150;
const MAPPING_ENTRY_CAP = 1000;

// Issue M (2026-04-10): per-type quotas for inventory selection. Replaces the
// legacy "structural first, then slice" approach which could drop blog/docs/
// case-studies entirely on large sites. Budgets sum to 154 (slight over-cap)
// so under-filled buckets roll leftover forward. Order below determines
// allocation priority — earlier entries claim their quota first.
const INVENTORY_QUOTA: { type: PageType; quota: number }[] = [
  { type: "homepage",     quota: 3 },
  { type: "about",        quota: 8 },
  { type: "contact",      quota: 5 },
  { type: "pricing",      quota: 5 },
  { type: "services",     quota: 50 },
  { type: "team",         quota: 30 },
  { type: "blog",         quota: 15 },
  { type: "docs",         quota: 10 },
  { type: "faq",          quota: 5 },
  { type: "case-studies", quota: 10 },
  { type: "legal",        quota: 3 },
  { type: "other",        quota: 10 },
];

/**
 * Compute the number of path segments for a URL, treating malformed URLs as
 * depth 99 (sorted to the end). Used as the primary sort key for "shallow
 * first" inventory selection so that landing pages like `/bangalore/` beat
 * deep leaves like `/bangalore/specialities/cardiology/sub-topic/`.
 */
export function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 99;
  }
}

/**
 * Issue N (2026-04-10): Split-sample a shallow-first sorted bucket into
 * "first half shallow + second half deep" so each pageType contributes BOTH
 * landing-level and detail-level pages to the tree-extractor inventory.
 *
 * Motivation: under pure shallow-first (Issue M), Manipal's team bucket gave
 * the tree extractor 30 doctor-LIST pages (shallow category landings) and
 * zero individual doctor profiles (deep pages). The author_authority pillar
 * dropped -24 because the LLM correctly noted "no named authors on any of
 * the 30 team pages sampled". Split-sample gives 15 shallow landings (for
 * tree structure) + 15 deep profiles (for author signal) inside the same
 * 30-page quota.
 *
 * Behavior:
 *   - If bucket.length <= quota, return the whole bucket
 *   - If quota <= 1, return the shallowest page only (no room to split)
 *   - Otherwise: ceil(quota/2) shallowest + floor(quota/2) deepest
 *
 * Determinism: input must already be sorted (pathDepth ASC, url ASC).
 */
function splitSampleBucket(sortedBucket: CrawledPage[], quota: number): CrawledPage[] {
  if (sortedBucket.length <= quota) return sortedBucket.slice();
  if (quota <= 1) return sortedBucket.slice(0, quota);
  const shallowTake = Math.ceil(quota / 2);
  const deepTake = quota - shallowTake;
  const shallow = sortedBucket.slice(0, shallowTake);
  const deep = sortedBucket.slice(sortedBucket.length - deepTake);
  return [...shallow, ...deep];
}

/**
 * Issue M (2026-04-10): Per-type quota inventory selection replacing the
 * legacy "structural first, then slice" pattern. Solves two problems:
 *
 *   1. Large structural buckets (e.g., Manipal's 121 services + 94 team
 *      pages) used to completely crowd out blog/docs/faq coverage when cap
 *      was applied. The new quota system guarantees minimum coverage per
 *      page type.
 *
 *   2. Within-bucket ordering was insertion-order (crawl chunk fan-in),
 *      which arbitrarily dropped shallow landing pages in favor of deep
 *      sub-pages. The new shallow-first sort prefers semantically important
 *      top-level pages for tree extraction.
 *
 * Algorithm:
 *   1. Group pages by pageType
 *   2. Sort each bucket by (pathDepth ASC, url ASC) — shallow & deterministic
 *   3. Allocate in INVENTORY_QUOTA priority order, rolling leftover forward
 *   4. If budget remains after all buckets, fill with remaining pages
 *      (shallow-first, cross-bucket)
 *   5. Hard-cap at `limit`
 */
export function selectInventoryPages(
  pages: CrawledPage[],
  limit: number
): CrawledPage[] {
  // Step 1 + 2: group by type, sort each bucket shallow-first.
  // Note: we always sort even when pages.length <= limit so callers get
  // a consistent shallow-first ordering in the output — the per-type
  // quota pass is skipped in that case since no pages need to be dropped.
  const buckets = new Map<PageType, CrawledPage[]>();
  for (const page of pages) {
    const list = buckets.get(page.pageType) ?? [];
    list.push(page);
    buckets.set(page.pageType, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => {
      const da = pathDepth(a.url);
      const db = pathDepth(b.url);
      if (da !== db) return da - db;
      return a.url.localeCompare(b.url);
    });
  }

  // Fast path: if nothing needs to be dropped, return all pages sorted
  // shallow-first (preserves the test invariant that output order is
  // deterministic and shallow-first regardless of input count).
  if (pages.length <= limit) {
    const all: CrawledPage[] = [];
    for (const bucket of buckets.values()) all.push(...bucket);
    all.sort((a, b) => {
      const da = pathDepth(a.url);
      const db = pathDepth(b.url);
      if (da !== db) return da - db;
      return a.url.localeCompare(b.url);
    });
    return all;
  }

  // Step 3: allocate per-type quotas with rollover.
  // Issue N (2026-04-10): introduced splitSampleBucket (50/50 shallow+deep)
  // for all buckets to recover author_authority from deep team/author pages.
  // Issue P (2026-04-10): restricted split-sample to the `team` bucket only
  // after observing that the unconditional split cost faq_coverage -16,
  // cta_structure -15, content_freshness -10, offering_clarity -10, and
  // competitive_positioning -8 on Manipal — those pillars score landing-level
  // content (FAQ schema stacks, CTAs, offerings, dates, vs-comparison pages)
  // which lives on SHALLOW landing URLs, not deep leaves. Only `team` actually
  // benefits from deep pages (individual doctor profiles carry named authors
  // + credentials). All other buckets stay pure shallow-first, which gives
  // the tree extractor landing pages the structural pillars need.
  const selected: CrawledPage[] = [];
  const picked = new Set<string>(); // track by URL to prevent dupes
  let remaining = limit;
  for (const { type, quota } of INVENTORY_QUOTA) {
    if (remaining <= 0) break;
    const bucket = buckets.get(type) ?? [];
    const effectiveQuota = Math.min(quota, bucket.length, remaining);
    const sampled = type === "team"
      ? splitSampleBucket(bucket, effectiveQuota)
      : bucket.slice(0, effectiveQuota);
    for (const page of sampled) {
      selected.push(page);
      picked.add(page.url);
    }
    remaining -= sampled.length;
  }

  // Step 4: fill any remaining budget from leftover pages (shallow-first across all types)
  if (remaining > 0) {
    const leftover: CrawledPage[] = [];
    for (const bucket of buckets.values()) {
      for (const p of bucket) {
        if (!picked.has(p.url)) leftover.push(p);
      }
    }
    leftover.sort((a, b) => {
      const da = pathDepth(a.url);
      const db = pathDepth(b.url);
      if (da !== db) return da - db;
      return a.url.localeCompare(b.url);
    });
    for (let i = 0; i < leftover.length && remaining > 0; i++) {
      selected.push(leftover[i]);
      remaining--;
    }
  }

  // Step 5: hard-cap (defensive — should already be at or below limit)
  return selected.slice(0, limit);
}

// ── System Prompt ────────────────────────────────────────────────────────────

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

// ── Page Inventory ──────────────────────────────────────────────────────────

/**
 * Build the page inventory string from crawl data for the LLM prompt.
 * Includes: URL, pageType, title, H1, headings list.
 * Capped at 200 pages (structural pages prioritized).
 */
export function buildPageInventory(
  crawlData: CrawlData,
  siteArchitecture?: SiteArchitecture
): string {
  const pages = crawlData.pages;
  if (pages.length === 0) return "No pages crawled.";

  // Issue M (2026-04-10): selectInventoryPages applies per-type quotas and
  // shallow-first ordering. Replaces the legacy "structural first, then slice"
  // which dropped blog/docs/case-studies entirely on large structural-heavy
  // crawls (Manipal's 121 services + 94 team pages crowded out all 33 blog
  // posts under the old algorithm, starving the category_tree of topical signal).
  const selected = selectInventoryPages(pages, MAX_INVENTORY_PAGES);

  return selected
    .map((page) => {
      const headingsList = page.headings
        .map((h) => `${"#".repeat(h.level)} ${sanitizeForPrompt(h.text, 200)}`)
        .join(", ");
      return [
        `URL: ${page.url}`,
        `Type: ${page.pageType}`,
        `Title: ${sanitizeForPrompt(page.title, 200)}`,
        `H1: ${sanitizeForPrompt(page.h1, 200)}`,
        headingsList ? `Headings: ${headingsList}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .join("\n");
}

// ── Validation ──────────────────────────────────────────────────────────────

function collectGeoIds(node: GeoNode, visited = new Set<string>()): Set<string> {
  if (node.id && visited.has(node.id)) {
    console.warn(`[extract-trees] cycle detected in geoTree at node "${node.id}"`);
    return visited;
  }
  if (node.id) visited.add(node.id);
  for (const child of node.children ?? []) {
    collectGeoIds(child, visited);
  }
  return visited;
}

function collectCategoryIds(node: CategoryNode, visited = new Set<string>()): Set<string> {
  if (node.id && visited.has(node.id)) {
    console.warn(`[extract-trees] cycle detected in categoryTree at node "${node.id}"`);
    return visited;
  }
  if (node.id) visited.add(node.id);
  for (const child of node.children ?? []) {
    collectCategoryIds(child, visited);
  }
  return visited;
}

function validateNode(node: any, path: string, errors: string[], visited = new Set<string>()): void {
  if (!node || typeof node !== "object") {
    errors.push(`${path}: not an object`);
    return;
  }
  if (!node.id || typeof node.id !== "string") {
    errors.push(`${path}: missing or empty id`);
  } else if (visited.has(node.id)) {
    errors.push(`${path}: cycle detected (duplicate id "${node.id}")`);
    return;
  } else {
    visited.add(node.id);
  }
  if (!node.name || typeof node.name !== "string") {
    errors.push(`${path}: missing or empty name`);
  }
  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      validateNode(node.children[i], `${path}.children[${i}]`, errors, visited);
    }
  }
}

/**
 * Validate extracted trees.
 */
export function validateTrees(result: TreeExtractionResult): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate geo tree structure
  if (!result.geoTree?.root) {
    errors.push("geoTree: missing root");
  } else {
    validateNode(result.geoTree.root, "geoTree.root", errors);
  }

  // Validate category tree structure
  if (!result.categoryTree?.root) {
    errors.push("categoryTree: missing root");
  } else {
    validateNode(result.categoryTree.root, "categoryTree.root", errors);
  }

  // Size limits
  if ((result.geoTree?.leafCount ?? 0) > GEO_LEAF_CAP) {
    errors.push(`geoTree: leafCount ${result.geoTree.leafCount} exceeds cap of ${GEO_LEAF_CAP}`);
  }
  if ((result.categoryTree?.leafCount ?? 0) > CATEGORY_LEAF_CAP) {
    errors.push(`categoryTree: leafCount ${result.categoryTree.leafCount} exceeds cap of ${CATEGORY_LEAF_CAP}`);
  }
  if ((result.mapping?.totalEntries ?? 0) > MAPPING_ENTRY_CAP) {
    errors.push(`mapping: totalEntries ${result.mapping.totalEntries} exceeds cap of ${MAPPING_ENTRY_CAP}`);
  }

  // Validate mapping references
  if (result.mapping?.entries?.length > 0 && result.geoTree?.root && result.categoryTree?.root) {
    const geoIds = collectGeoIds(result.geoTree.root);
    const catIds = collectCategoryIds(result.categoryTree.root);

    for (const entry of result.mapping.entries) {
      if (!geoIds.has(entry.geoId)) {
        errors.push(`mapping: orphan geoId "${entry.geoId}" not found in geoTree`);
      }
      if (!catIds.has(entry.categoryId)) {
        errors.push(`mapping: orphan categoryId "${entry.categoryId}" not found in categoryTree`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── LLM Extraction ──────────────────────────────────────────────────────────

function buildUserPrompt(
  crawlData: CrawlData,
  discoveryData: DiscoveryData,
  domain: string,
  industry?: string
): string {
  const inventory = buildPageInventory(crawlData);

  let prompt = `<page_inventory>\n${inventory}\n</page_inventory>\n\n`;
  prompt += `<domain>${domain}</domain>\n`;
  prompt += `<industry>${industry || "Unknown"}</industry>\n`;

  return prompt;
}

function parseJsonResponse(text: string): unknown {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(cleaned);
}

// ── ES-086 AC-17/18 — Hand-rolled schema validator + typed error class ──────
//
// The validator + error class are file-local. There's exactly one producer
// (`validateExtractionResponse`) and one consumer (the catch-block dispatch
// table at the call site of `extractTrees`). NOT exported from the module's
// public surface; tests import via the `__test_internals` export at the
// bottom of the file.

/**
 * Thrown when the LLM response parses to JSON but fails the structural
 * schema check (missing required fields, wrong types, etc.). The catch
 * block at the call site classifies this via the AC-19 dispatch table
 * and decides whether to retry at temp 0.3.
 */
export class TreeExtractorSchemaError extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = "TreeExtractorSchemaError";
    this.field = field;
  }
}

/**
 * ES-086 AC-17 — validates that an LLM-returned object matches the
 * TreeExtractionResult shape. Hand-rolled to avoid pulling in zod for one
 * call site. Throws TreeExtractorSchemaError on the first failure with a
 * path-style field marker.
 *
 * Asserts the production code can read every field downstream:
 *   - geoTree.leafCount (number)
 *   - geoTree.root: { children: GeoNode[] }
 *   - categoryTree.leafCount (number)
 *   - categoryTree.root: { children: CategoryNode[] }
 *   - mapping.entries: GeoCategoryEntry[]
 */
export function validateExtractionResponse(parsed: unknown): asserts parsed is TreeExtractionResult {
  if (!parsed || typeof parsed !== "object") {
    throw new TreeExtractorSchemaError("response is not an object", "root");
  }
  const obj = parsed as Record<string, unknown>;

  // ── geoTree ──
  if (!obj.geoTree || typeof obj.geoTree !== "object") {
    throw new TreeExtractorSchemaError("geoTree missing or not an object", "geoTree");
  }
  const geoTree = obj.geoTree as Record<string, unknown>;
  if (typeof geoTree.leafCount !== "number") {
    throw new TreeExtractorSchemaError("geoTree.leafCount is not a number", "geoTree.leafCount");
  }
  if (!geoTree.root || typeof geoTree.root !== "object") {
    throw new TreeExtractorSchemaError("geoTree.root missing or not an object", "geoTree.root");
  }
  const geoRoot = geoTree.root as Record<string, unknown>;
  if (!Array.isArray(geoRoot.children)) {
    throw new TreeExtractorSchemaError("geoTree.root.children is not an array", "geoTree.root.children");
  }

  // ── categoryTree ──
  if (!obj.categoryTree || typeof obj.categoryTree !== "object") {
    throw new TreeExtractorSchemaError("categoryTree missing or not an object", "categoryTree");
  }
  const catTree = obj.categoryTree as Record<string, unknown>;
  if (typeof catTree.leafCount !== "number") {
    throw new TreeExtractorSchemaError("categoryTree.leafCount is not a number", "categoryTree.leafCount");
  }
  if (!catTree.root || typeof catTree.root !== "object") {
    throw new TreeExtractorSchemaError("categoryTree.root missing or not an object", "categoryTree.root");
  }
  const catRoot = catTree.root as Record<string, unknown>;
  if (!Array.isArray(catRoot.children)) {
    throw new TreeExtractorSchemaError("categoryTree.root.children is not an array", "categoryTree.root.children");
  }

  // ── mapping ──
  if (!obj.mapping || typeof obj.mapping !== "object") {
    throw new TreeExtractorSchemaError("mapping missing or not an object", "mapping");
  }
  const mapping = obj.mapping as Record<string, unknown>;
  if (!Array.isArray(mapping.entries)) {
    throw new TreeExtractorSchemaError("mapping.entries is not an array", "mapping.entries");
  }
}

// ── ES-086 AC-19 — Catch-block error dispatch table ─────────────────────────

export type SonnetErrorClass =
  | { kind: "timeout" }                                                      // skip retry, fall to OpenAI
  | { kind: "schema" }                                                       // retry at temp 0.3
  | { kind: "overload" }                                                     // skip retry, fall to OpenAI
  | { kind: "auth_or_config" }                                               // fail fast, no fallback
  | { kind: "network" }                                                      // retry at temp 0.3 once
  | { kind: "other"; errType: string; errMsg: string; errStatus?: number };  // fall to OpenAI

/**
 * ES-086 AC-19 — classify a Sonnet attempt error into one of six dispatch
 * categories. The caller decides whether to retry at temperature 0.3, fall
 * through to the OpenAI fallback, or fail fast (auth/config errors must
 * NOT be retried — they're not transient).
 */
export function classifySonnetError(err: unknown): SonnetErrorClass {
  if (!(err instanceof Error)) {
    return { kind: "other", errType: "non-error", errMsg: String(err) };
  }

  // Timeout sentinel from the Promise.race wrapper inside callSonnet
  if (err.message === "Sonnet timeout") return { kind: "timeout" };

  // Schema validation failure
  if (err instanceof TreeExtractorSchemaError) return { kind: "schema" };

  // Anthropic SDK error with HTTP status (status field is on the SDK error type)
  const errStatus = (err as { status?: number }).status;
  if (errStatus === 503 || errStatus === 529) return { kind: "overload" };
  if (errStatus === 400 || errStatus === 401 || errStatus === 403) return { kind: "auth_or_config" };

  // Network errors (Node.js error codes)
  const errCode = (err as { code?: string }).code;
  if (errCode === "ECONNRESET" || errCode === "EAI_AGAIN" || errCode === "ETIMEDOUT" || errCode === "EPIPE") {
    return { kind: "network" };
  }

  return {
    kind: "other",
    errType: err.name,
    errMsg: err.message,
    errStatus,
  };
}

function countGeoLeaves(node: GeoNode): number {
  if (node.level === "city" || node.children.length === 0) {
    return node.level === "global" && node.children.length === 0 ? 0 : 1;
  }
  return node.children.reduce((sum, child) => sum + countGeoLeaves(child), 0);
}

function countCategoryLeaves(node: CategoryNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((sum, child) => sum + countCategoryLeaves(child), 0);
}

function ensureTimestampsAndCounts(result: TreeExtractionResult): TreeExtractionResult {
  const now = new Date().toISOString();
  if (!result.geoTree.extractedAt) result.geoTree.extractedAt = now;
  if (!result.categoryTree.extractedAt) result.categoryTree.extractedAt = now;
  if (!result.mapping.extractedAt) result.mapping.extractedAt = now;

  // Compute actual counts from tree structure (override LLM-reported values)
  result.geoTree.leafCount = countGeoLeaves(result.geoTree.root);
  result.categoryTree.leafCount = countCategoryLeaves(result.categoryTree.root);
  result.mapping.totalEntries = result.mapping.entries?.length ?? 0;

  return result;
}

async function callSonnet(userPrompt: string, temperature: number): Promise<TreeExtractionResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic();
  const response = await Promise.race([
    client.messages.create({
      model: "claude-sonnet-4-6",
      // ES-086 AC-1 + AC-4: Anthropic Messages API uses `max_tokens`
      // (was `max_completion_tokens`, which the API rejects with HTTP 400
      // "max_tokens: Field required"). Budget 8000 → 20000 per ES-086.
      //
      // Issue M (2026-04-10) bumped 20000 → 32000 as a safety margin after
      // observing Sonnet truncate its output on Manipal's 222-page inventory.
      // Issue N (2026-04-10) reverted 32000 → 20000 after discovering
      // Anthropic's API hard-rejects non-streaming calls with max_tokens
      // above ~21K with: "Streaming is required for operations that may
      // take longer than 10 minutes". With Issue M's 150-page inventory cap
      // AND selectInventoryPages() quota discipline, the expected tree output
      // is ~12-15K tokens — well under the 20K ceiling that prompted the
      // Issue M bump in the first place. 20K gives enough headroom without
      // tripping Anthropic's streaming requirement. per the
      // empirical Sonnet diagnostic sweep (TS-086 §2.1 — Manipal needs ~17,774
      // output tokens).
      max_tokens: 20000,
      temperature,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Sonnet timeout")), EXTRACTION_TIMEOUT_MS)
    ),
  ]);

  const text = (response as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) return null;

  const parsed = parseJsonResponse(text);
  validateExtractionResponse(parsed); // ES-086 AC-17 — throws TreeExtractorSchemaError on bad shape
  return ensureTimestampsAndCounts(parsed);
}

// ES-086 AC-21: renamed to `callOpenAi`. The function calls OpenAI's gpt-5.4
// reasoning model — the prior name was a stale label that predated the model id.
// `max_completion_tokens` STAYS (canonical OpenAI reasoning-model field —
// asymmetric vs Sonnet's `max_tokens`).
async function callOpenAi(userPrompt: string): Promise<TreeExtractionResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const client = new OpenAI({ apiKey });
  const response = await Promise.race([
    client.chat.completions.create({
      model: "gpt-5.4",
      // ES-086 AC-2 + AC-5: STAYS `max_completion_tokens` (canonical OpenAI
      // reasoning-model field — DO NOT change to max_tokens). Budget bumped
      // 8000 → 20000 per the gpt-5.4 OQ-1 diagnostic sweep (TS-086 §2.2 —
      // Manipal needs ~10,555 output tokens with reasoning_tokens === 0).
      max_completion_tokens: 20000,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("OpenAI timeout")), EXTRACTION_TIMEOUT_MS)
    ),
  ]);

  const text = (response as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
  if (!text) return null;

  const parsed = parseJsonResponse(text);
  validateExtractionResponse(parsed); // ES-086 AC-17 — throws TreeExtractorSchemaError on bad shape
  return ensureTimestampsAndCounts(parsed);
}

// ── Hallucination Guardrails ─────────────────────────────────────────────────

/** Collect all leaf nodes from a GeoTree (level === "city" or childless non-global). */
function collectGeoLeafNodes(node: GeoNode, leaves: GeoNode[] = []): GeoNode[] {
  const isLeaf = node.level === "city" || (node.children.length === 0 && node.level !== "global");
  if (isLeaf) {
    leaves.push(node);
  } else {
    for (const child of node.children) collectGeoLeafNodes(child, leaves);
  }
  return leaves;
}

/** Collect all leaf nodes from a CategoryTree (no children). */
function collectCategoryLeafNodes(node: CategoryNode, leaves: CategoryNode[] = []): CategoryNode[] {
  if (node.children.length === 0 && node.level > 0) {
    leaves.push(node);
  } else {
    for (const child of node.children) collectCategoryLeafNodes(child, leaves);
  }
  return leaves;
}

/** Remove nodes by id set, prune childless parents recursively. Returns true if node should be kept. */
function pruneGeoNode(node: GeoNode, removeIds: Set<string>): boolean {
  if (removeIds.has(node.id)) return false;
  const hadChildren = node.children.length > 0;
  node.children = node.children.filter((c) => pruneGeoNode(c, removeIds));
  // Prune non-global internal nodes that became childless after pruning (not original leaves)
  if (hadChildren && node.level !== "global" && node.children.length === 0) return false;
  return true;
}

function pruneCategoryNode(node: CategoryNode, removeIds: Set<string>): boolean {
  if (removeIds.has(node.id)) return false;
  const hadChildren = node.children.length > 0;
  node.children = node.children.filter((c) => pruneCategoryNode(c, removeIds));
  // Prune non-root internal nodes that became childless after pruning (not original leaves)
  if (hadChildren && node.level > 0 && node.children.length === 0) return false;
  return true;
}

/**
 * Runs after tree extraction. Removes nodes with no evidence in the actual crawl data.
 * If ungrounded nodes are found, first asks the LLM to correct them, then prunes the rest.
 */
export async function pruneUngroundedNodes(
  result: TreeExtractionResult,
  crawlData: CrawlData
): Promise<{ prunedGeoNodes: number; prunedCategoryNodes: number; prunedMappingEntries: number }> {
  // 1. Build crawl URL set and content keyword set
  const crawlUrls = new Set(crawlData.pages.map((p) => p.url));
  const contentKeywords = new Set<string>();
  for (const page of crawlData.pages) {
    const texts = [page.title, page.h1, ...page.headings.map((h) => h.text)];
    for (const t of texts) {
      for (const word of t.toLowerCase().split(/\W+/).filter((w) => w.length > 3)) {
        contentKeywords.add(word);
      }
    }
  }

  // Also build a set of URL path suffixes for matching relative evidence paths
  const crawlUrlPaths = new Set<string>();
  for (const url of crawlUrls) {
    try { crawlUrlPaths.add(new URL(url).pathname); } catch { /* skip invalid URLs */ }
  }

  // Materialize the crawl-URL list ONCE for the suffix fallback. Previously
  // `[...crawlUrls]` was rebuilt on every evidence-URL evaluation — an O(pages)
  // allocation per check, run O(nodes × evidence) times. The exact-match Set
  // probes above stay O(1); only the rare suffix residual hits this list.
  const crawlUrlList = [...crawlUrls];

  // 2. Identify ungrounded leaf nodes
  const isGrounded = (node: GeoNode | CategoryNode): boolean => {
    // Check exact URL match or relative path match (LLM sometimes returns paths not full URLs)
    const hasEvidenceUrl = node.evidence.some((url) =>
      crawlUrls.has(url) || crawlUrlPaths.has(url) || crawlUrlList.some((cu) => cu.endsWith(url))
    );
    const nameWords = node.name.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const nameInContent = nameWords.length > 0 && nameWords.some((w) => contentKeywords.has(w));
    return hasEvidenceUrl || nameInContent;
  };

  const ungroundedGeo = collectGeoLeafNodes(result.geoTree.root).filter((n) => !isGrounded(n));
  const ungroundedCat = collectCategoryLeafNodes(result.categoryTree.root).filter((n) => !isGrounded(n));
  const ungroundedAll = [...ungroundedGeo, ...ungroundedCat];

  // 3. LLM correction pass (only if ungrounded nodes exist)
  const llmKeepUrls = new Map<string, string[]>(); // nodeId → corrected evidence URLs
  const llmRemoveIds = new Set<string>();

  if (ungroundedAll.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const client = new Anthropic();
        const nodeList = ungroundedAll.map((n) => `- id: "${n.id}", name: "${n.name}"`).join("\n");
        const urlSample = crawlUrlList.slice(0, 50).join("\n");
        const correctionPrompt = `These tree nodes have no supporting evidence in the crawl data:\n${nodeList}\n\nAvailable crawl URLs:\n${urlSample}\n\nFor each node, either:\n- Provide a URL from the list that supports it\n- Or confirm it should be removed\n\nReturn JSON: { "keep": [{ "id": "...", "evidence": ["url"] }], "remove": ["id1", "id2"] }`;

        const response = await Promise.race([
          client.messages.create({
            model: "claude-sonnet-4-6",
            // ES-086 AC-3 + AC-6: Anthropic Messages API uses `max_tokens`
            // (was `max_completion_tokens`). Budget STAYS at 2000 — the
            // correction call only emits a small JSON keep/remove list.
            max_tokens: 2000,
            temperature: 0,
            messages: [{ role: "user", content: correctionPrompt }],
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("correction timeout")), EXTRACTION_TIMEOUT_MS)
          ),
        ]);

        const text = (response as any).content?.[0]?.text ?? "";
        const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()) as {
          keep: { id: string; evidence: string[] }[];
          remove: string[];
        };

        for (const item of parsed.keep ?? []) {
          // Only accept URLs that actually exist in crawl data
          const validUrls = item.evidence.filter((url) => crawlUrls.has(url));
          if (validUrls.length > 0) llmKeepUrls.set(item.id, validUrls);
          else llmRemoveIds.add(item.id);
        }
        for (const id of parsed.remove ?? []) llmRemoveIds.add(id);
      } catch {
        // Correction call failed — fall through to deterministic prune of all ungrounded nodes
        for (const n of ungroundedAll) llmRemoveIds.add(n.id);
      }
    } else {
      for (const n of ungroundedAll) llmRemoveIds.add(n.id);
    }
  }

  // 4. Deterministic prune — remove nodes not saved by LLM correction
  const finalRemoveIds = new Set<string>();
  for (const n of ungroundedAll) {
    if (!llmKeepUrls.has(n.id)) finalRemoveIds.add(n.id);
  }

  const geoBefore = countGeoLeaves(result.geoTree.root);
  const catBefore = countCategoryLeaves(result.categoryTree.root);
  const mappingBefore = result.mapping.entries.length;

  pruneGeoNode(result.geoTree.root, finalRemoveIds);
  pruneCategoryNode(result.categoryTree.root, finalRemoveIds);

  // Remove mapping entries referencing pruned nodes
  const remainingGeoIds = collectGeoIds(result.geoTree.root);
  const remainingCatIds = collectCategoryIds(result.categoryTree.root);
  result.mapping.entries = result.mapping.entries.filter(
    (e) => remainingGeoIds.has(e.geoId) && remainingCatIds.has(e.categoryId)
  );

  // 5. Recompute counts
  result.geoTree.leafCount = countGeoLeaves(result.geoTree.root);
  result.categoryTree.leafCount = countCategoryLeaves(result.categoryTree.root);
  result.mapping.totalEntries = result.mapping.entries.length;

  const prunedGeoNodes = geoBefore - result.geoTree.leafCount;
  const prunedCategoryNodes = catBefore - result.categoryTree.leafCount;
  const prunedMappingEntries = mappingBefore - result.mapping.totalEntries;

  if (prunedGeoNodes > 0 || prunedCategoryNodes > 0 || prunedMappingEntries > 0) {
    console.info(
      `[tree-extractor] Pruned ${prunedGeoNodes} geo nodes, ${prunedCategoryNodes} category nodes, ${prunedMappingEntries} mapping entries`
    );
  }

  return { prunedGeoNodes, prunedCategoryNodes, prunedMappingEntries };
}

// ── Main Extraction ──────────────────────────────────────────────────────────

/**
 * Extract geo tree, category tree, and mapping from crawl data via LLM.
 * Primary: Claude Sonnet 4 → Fallback: OpenAI (gpt-5.4) → Last resort: empty trees.
 *
 * ES-086 AC-19: catch-block dispatch table determines whether attempt 1 fails
 * over to a temp-0.3 retry, skips straight to the OpenAI fallback, or fails
 * fast (auth/config errors are not transient — retrying would burn budget).
 */
/**
 * Discriminated outcome of {@link extractTrees} (FIND-023). A successfully
 * extracted tree — even one that is legitimately empty for a digital/SaaS
 * business — is `{ ok: true }`. Only the final fallback after ALL LLM attempts
 * fail is `{ ok: false }`, so callers can fail the audit loudly instead of
 * shipping a hollow, structurally-empty tree as a fake success.
 */
export type ExtractTreesOutcome =
  | { ok: true; trees: TreeExtractionResult }
  | { ok: false; reason: "all_providers_failed" };

export async function extractTrees(
  crawlData: CrawlData,
  discoveryData: DiscoveryData,
  domain: string,
  industry?: string
): Promise<ExtractTreesOutcome> {
  const userPrompt = buildUserPrompt(crawlData, discoveryData, domain, industry);

  // Attempt 1: Sonnet temperature=0. Per AC-19 dispatch:
  //   - timeout / overload   → skip retry, fall to OpenAI
  //   - schema / network     → retry at temp 0.3
  //   - auth_or_config       → fail fast, throw out of extractTrees
  //   - other                → fall to OpenAI
  let attempt1Classified: SonnetErrorClass | null = null;
  try {
    const result = await callSonnet(userPrompt, 0);
    if (result) {
      const validation = validateTrees(result);
      if (validation.valid) {
        console.info(`[extract-trees] ${domain}: trees extracted via Sonnet`);
        await pruneUngroundedNodes(result, crawlData);
        return { ok: true, trees: result };
      }
      console.warn(`[extract-trees] ${domain}: Sonnet validation failed (attempt 1): ${validation.errors.join(", ")}`);
    }
  } catch (err) {
    attempt1Classified = classifySonnetError(err);
    console.warn(JSON.stringify({
      event: "extract_trees_sonnet_attempt1_failed",
      domain,
      attempt: 1,
      classified: attempt1Classified.kind,
      errMsg: (err as Error).message ?? String(err),
    }));
    if (attempt1Classified.kind === "auth_or_config") {
      // Per AC-19 row 4: fail fast, no fallback. Auth/config errors are not
      // transient — retrying would burn budget on the same failure mode.
      throw err;
    }
  }

  // Attempt 2: Sonnet temperature=0.3 (retry) — only if attempt 1 was schema/
  // network/other-validation. Skipped on timeout/overload (AC-19 short-circuit).
  const skipAttempt2 = attempt1Classified !== null
    && (attempt1Classified.kind === "timeout" || attempt1Classified.kind === "overload");
  if (!skipAttempt2) {
    try {
      const result = await callSonnet(userPrompt, 0.3);
      if (result) {
        const validation = validateTrees(result);
        if (validation.valid) {
          console.info(`[extract-trees] ${domain}: trees extracted via Sonnet (retry)`);
          await pruneUngroundedNodes(result, crawlData);
          return { ok: true, trees: result };
        }
        console.warn(`[extract-trees] ${domain}: Sonnet validation failed (attempt 2): ${validation.errors.join(", ")}`);
      }
    } catch (err) {
      const attempt2Classified = classifySonnetError(err);
      console.warn(JSON.stringify({
        event: "extract_trees_sonnet_attempt2_failed",
        domain,
        attempt: 2,
        classified: attempt2Classified.kind,
        errMsg: (err as Error).message ?? String(err),
      }));
      if (attempt2Classified.kind === "auth_or_config") {
        throw err;
      }
    }
  }

  // Attempt 3: OpenAI (gpt-5.4) fallback
  try {
    const result = await callOpenAi(userPrompt);
    if (result) {
      const validation = validateTrees(result);
      if (validation.valid) {
        console.info(`[extract-trees] ${domain}: trees extracted via OpenAI`);
        await pruneUngroundedNodes(result, crawlData);
        return { ok: true, trees: result };
      }
      console.warn(`[extract-trees] ${domain}: OpenAI validation failed: ${validation.errors.join(", ")}`);
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "extract_trees_openai_failed",
      domain,
      errMsg: (err as Error).message ?? String(err),
      errStatus: (err as { status?: number }).status,
    }));
  }

  // FIND-023: all LLM providers failed. Instead of shipping a hollow,
  // structurally-empty tree as a fake success (which sailed through the pipeline
  // and delivered a hollow audit), signal a discriminated failure so the caller
  // fails the audit loudly (markFailed + refund).
  console.warn(`[extract-trees] ${domain}: tree extraction failed — all providers exhausted`);
  return { ok: false, reason: "all_providers_failed" };
}

// ── ES-086 AC-17 / AC-19 — test internals ───────────────────────────────────
//
// Exposes the file-local helpers (validateExtractionResponse, classifySonnetError,
// TreeExtractorSchemaError, EXTRACTION_TIMEOUT_MS) for unit testing without
// adding them to the public surface. Tests import via this namespace; production
// code uses the named functions inside the module.
export const __test_internals = {
  validateExtractionResponse,
  classifySonnetError,
  TreeExtractorSchemaError,
  EXTRACTION_TIMEOUT_MS,
};
