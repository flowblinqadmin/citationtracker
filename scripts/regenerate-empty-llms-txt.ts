// OPERATOR-ONLY — do not invoke from application code.
//
// ES-082 §b.8 — regenerate `geo_sites.generated_llms_txt` for rows where the
// silent fall-through bug persisted an empty string. Reads only sites with a
// healthy `generated_llms_full_txt` (length >= 1000), runs Direction B prompt
// against gpt-5.4-mini, validates + sanitizes, and writes back via an
// idempotent UPDATE that re-checks `length(generated_llms_txt) = 0`.
//
// Default mode is DRY-RUN per AC-12 — pass `commit: true` to actually persist.
//
// Usage (CLI):
//   tsx geo/scripts/regenerate-empty-llms-txt.ts                 # dry-run all eligible
//   tsx geo/scripts/regenerate-empty-llms-txt.ts --site <id>     # one site
//   tsx geo/scripts/regenerate-empty-llms-txt.ts --site <id> --commit
//   tsx geo/scripts/regenerate-empty-llms-txt.ts --owner <email>
//   tsx geo/scripts/regenerate-empty-llms-txt.ts --max 10        # cap rows
//
// Programmatic (the unit test contract):
//   import { main } from "./regenerate-empty-llms-txt";
//   const summary = await main({ commit: false, site: "..." });

import OpenAI from "openai";
import { and, eq, isNull, or, sql, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";

// ── Public types ────────────────────────────────────────────────────────────

export interface RegenerateOpts {
  commit?: boolean;
  site?: string;
  domain?: string;
  owner?: string;
  max?: number;
}

export interface RegenerateSummary {
  mode: "dry-run" | "commit";
  eligible: number;
  regenerated: number;
  skipped: number;
  failed: number;
}

// ── Internal validation ─────────────────────────────────────────────────────

class LlmsValidationError extends Error {
  constructor(reason: string) {
    super(`[regenerate-empty-llms-txt] llms validation failed: ${reason}`);
    this.name = "LlmsValidationError";
  }
}

function sanitizeLlmsContent(raw: string): string {
  let value = raw.trim();
  // Strip leading code-fence (```markdown / ```)
  value = value.replace(/^```(?:markdown|md|text)?\s*\n/i, "");
  // Strip trailing code-fence
  value = value.replace(/\n```\s*$/i, "");
  return value.trim();
}

function validateLlmsContent(content: string): void {
  if (content.length < 200) throw new LlmsValidationError("too short");
  if (!/^# .+/m.test(content)) throw new LlmsValidationError("missing H1");
  if (!/^> .+/m.test(content)) throw new LlmsValidationError("missing blockquote");
  if (!/^## .+/m.test(content)) throw new LlmsValidationError("no sections");
}

// ── OpenAI helpers ──────────────────────────────────────────────────────────
//
// HP-185: REGENERATE_SYSTEM_PROMPT and buildRegeneratePrompt are VERBATIM
// copies of TS-082 §8.2. The §8.2 shape is empirically validated to produce
// 0 reasoning tokens against the Manipal hot-fix experiment (TS-082 §8.6 —
// completion_tokens 1362, reasoning_tokens 0, finish_reason "stop", 6452
// chars output). Any deviation reintroduces the reasoning-burn risk that
// TS-082 was designed to prevent. Do NOT edit lightly.

const REGENERATE_SYSTEM_PROMPT = `You generate llms.txt files following the llmstxt.org specification. An llms.txt
file is a structured document that helps AI systems understand what a business
is, what it offers, and how to accurately describe it.

The llmstxt.org format requires:
- Line 1: # [Company Name] (H1 heading with exact company name)
- Line 2-3: > [One-sentence summary] (blockquote, answer-first: what the company
  does and for whom)
- Sections use ## headings, content is plain markdown

Use ONLY information found in the provided source document. DO NOT invent phone
numbers, emails, team names, or URLs not in the source. DO NOT use the words
"journey", "empower", "leverage", or "holistic". Return ONLY the file content —
no code fences, no explanations.`;

function buildRegeneratePrompt(domain: string, fullText: string): string {
  return `Below is the full llms-full.txt document for ${domain}. Produce a CONDENSED
llms.txt version following the llmstxt.org spec.

REQUIREMENTS:
1. Keep the same H1 (# {Brand Name from source}) and the same blockquote (> ...)
   on lines 1-3.
2. Keep these sections in this order: ## About, ## Products/Services,
   ## Key Concepts, ## Contact.
3. ## About — 2 paragraphs maximum, distilled from the full About section.
4. ## Products/Services — keep as a bulleted list of service categories with
   one short description line each. Drop the nested bullet points.
5. ## Key Concepts — define 5-8 domain-specific terms. Each definition MUST
   start with "is" or "refers to".
6. ## Contact — only real emails and URLs found in the source. Do not invent.
7. Target length: 1500-3000 words. The full version is ~16K bytes; the short
   version should be roughly 1/4 of that.
8. Do NOT include the FAQ section verbatim. If FAQs are referenced, mention
   they are available and link to relevant URLs.

SOURCE DOCUMENT:
${fullText}

Return ONLY the condensed llms.txt content. No code fences. No explanations.`;
}

async function generateShortFromFull(
  client: OpenAI,
  domain: string,
  fullText: string,
): Promise<string> {
  const res = await client.chat.completions.create({
    model: "gpt-5.4-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: REGENERATE_SYSTEM_PROMPT },
      { role: "user", content: buildRegeneratePrompt(domain, fullText) },
    ],
    max_completion_tokens: 6000,
  });
  return res.choices[0]?.message?.content ?? "";
}

// ── Selection ───────────────────────────────────────────────────────────────

interface EligibleRow {
  id: string;
  domain: string;
  slug: string;
  generated_llms_full_txt: string;
  generated_llms_txt: string | null;
}

function buildWhereClause(opts: RegenerateOpts) {
  // Empty string OR null both qualify as "needs regeneration".
  const emptyOrNull = or(
    isNull(geoSites.generatedLlmsTxt),
    eq(geoSites.generatedLlmsTxt, ""),
  );
  const filters = [
    emptyOrNull,
    sql`length(${geoSites.generatedLlmsFullTxt}) >= 1000`,
  ];
  if (opts.site) filters.push(eq(geoSites.id, opts.site));
  if (opts.domain) filters.push(eq(geoSites.domain, opts.domain));
  if (opts.owner) filters.push(eq(geoSites.ownerEmail, opts.owner));
  return and(...filters);
}

async function fetchEligible(opts: RegenerateOpts): Promise<EligibleRow[]> {
  const limit = opts.max ?? 1000;
  const where = buildWhereClause(opts);

  // Drizzle chain — the test mocks every step. The actual columns selected
  // are coerced to the EligibleRow shape.
  const rows = await db
    .select()
    .from(geoSites)
    .where(where)
    .orderBy(desc(geoSites.updatedAt))
    .limit(limit);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id ?? ""),
    domain: String(r.domain ?? ""),
    slug: String(r.slug ?? r.id ?? ""),
    generated_llms_full_txt: String(
      r.generated_llms_full_txt ?? r.generatedLlmsFullTxt ?? "",
    ),
    generated_llms_txt:
      (r.generated_llms_txt as string | null | undefined) ??
      (r.generatedLlmsTxt as string | null | undefined) ??
      null,
  }));
}

// ── Per-row processor ───────────────────────────────────────────────────────

interface ProcessOutcome {
  status: "regenerated" | "skipped" | "failed";
  reason?: string;
}

async function processRow(
  client: OpenAI,
  row: EligibleRow,
  commit: boolean,
): Promise<ProcessOutcome> {
  // Sanity gate — ES-082 §b.8 / TS-082 §8.1
  if (!row.generated_llms_full_txt || row.generated_llms_full_txt.length < 1000) {
    console.warn(`[skip] sanity-gate ${row.id} (${row.domain}) — full_text length ${row.generated_llms_full_txt?.length ?? 0} < 1000`);
    return { status: "skipped", reason: "sanity-gate" };
  }

  let raw: string;
  try {
    raw = await generateShortFromFull(client, row.domain, row.generated_llms_full_txt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[failed] ${row.id} (${row.domain}) — OpenAI error: ${msg}`);
    return { status: "failed", reason: msg };
  }

  const sanitized = sanitizeLlmsContent(raw);

  try {
    validateLlmsContent(sanitized);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[failed] ${row.id} (${row.domain}) — ${msg}`);
    return { status: "failed", reason: msg };
  }

  if (!commit) {
    console.warn(`[dry-run] ${row.id} (${row.domain}) → would write ${sanitized.length} chars`);
    return { status: "regenerated", reason: "dry-run" };
  }

  // Idempotent UPDATE — re-checks length(generated_llms_txt) = 0 inside the
  // WHERE clause so a parallel writer between SELECT and UPDATE doesn't get
  // overwritten. RETURNING id lets us detect the no-op case.
  const updated = await db
    .update(geoSites)
    .set({
      generatedLlmsTxt: sanitized,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(geoSites.id, row.id),
        eq(geoSites.domain, row.domain),
        or(
          isNull(geoSites.generatedLlmsTxt),
          eq(geoSites.generatedLlmsTxt, ""),
        ),
      ),
    )
    .returning({ id: geoSites.id });

  const rows = updated as unknown as Array<{ id?: string }>;
  if (!rows || rows.length === 0) {
    console.warn(`[skip] ${row.id} (${row.domain}) — already has content (idempotency guard)`);
    return { status: "skipped", reason: "already-fixed-race" };
  }

  console.warn(`[ok] ${row.id} (${row.domain}) → ${sanitized.length} chars`);
  return { status: "regenerated" };
}

// ── Main entry ──────────────────────────────────────────────────────────────

export async function main(opts: RegenerateOpts): Promise<RegenerateSummary> {
  const commit = opts.commit === true;
  const mode: RegenerateSummary["mode"] = commit ? "commit" : "dry-run";

  // Production: credentials come from .env.local via process.env.OPENAI_API_KEY
  // — never inlined. Tests mock the OpenAI constructor at the module boundary,
  // so an empty key is harmless. The real SDK throws on the first .create()
  // call when the key is missing; that error is caught per-row in processRow.
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });

  const eligible = await fetchEligible(opts);
  console.warn(
    `[regenerate-empty-llms-txt] mode=${mode} eligible=${eligible.length} ` +
    `${opts.site ? `site=${opts.site} ` : ""}` +
    `${opts.domain ? `domain=${opts.domain} ` : ""}` +
    `${opts.owner ? `owner=${opts.owner} ` : ""}` +
    `${opts.max != null ? `max=${opts.max}` : ""}`,
  );

  let regenerated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of eligible) {
    try {
      const outcome = await processRow(client, row, commit);
      if (outcome.status === "regenerated") regenerated++;
      else if (outcome.status === "skipped") skipped++;
      else failed++;
    } catch (err) {
      // Defensive — processRow already catches its own errors, but this
      // ensures one bad row never aborts the loop.
      failed++;
      console.error(`[failed] ${row.id} (${row.domain}) — unexpected:`, err);
    }
  }

  const summary: RegenerateSummary = { mode, eligible: eligible.length, regenerated, skipped, failed };
  console.warn(JSON.stringify({
    event: "regenerate_llms_txt_summary",
    ...summary,
  }));
  return summary;
}

// ── CLI entry ───────────────────────────────────────────────────────────────

function parseCli(argv: string[]): RegenerateOpts {
  const opts: RegenerateOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--commit") opts.commit = true;
    else if (a === "--site") opts.site = argv[++i];
    else if (a === "--domain") opts.domain = argv[++i];
    else if (a === "--owner") opts.owner = argv[++i];
    else if (a === "--max") opts.max = parseInt(argv[++i] ?? "0", 10);
    else if (a === "--help" || a === "-h") {
      console.warn(
        "Usage: tsx scripts/regenerate-empty-llms-txt.ts [--site <id>] [--domain <d>] [--owner <email>] [--max <n>] [--commit]",
      );
      process.exit(0);
    }
  }
  return opts;
}

// Only run when invoked directly (not when imported by tests). Detect via
// process.argv[1] resolving to this file. Avoids accidental execution in test
// environments and IDE imports.
if (typeof process !== "undefined" && process.argv[1]?.endsWith("regenerate-empty-llms-txt.ts")) {
  main(parseCli(process.argv.slice(2)))
    .then((s) => {
      console.warn(
        `─── regenerate-empty-llms-txt summary ───\n` +
        `  Eligible:    ${s.eligible}\n` +
        `  Regenerated: ${s.regenerated}\n` +
        `  Skipped:     ${s.skipped}\n` +
        `  Failed:      ${s.failed}\n` +
        `  Mode:        ${s.mode}`,
      );
      process.exit(s.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("[regenerate-empty-llms-txt] FATAL:", err);
      process.exit(1);
    });
}
