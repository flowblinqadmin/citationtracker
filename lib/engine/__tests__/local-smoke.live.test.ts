// LOCAL LIVE SMOKE — real providers, real Firecrawl, LOCAL database only.
// Gated on LIVE_SMOKE=1 so it never runs in the normal suite (it makes real
// paid API calls). Run with:
//   LIVE_SMOKE=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres \
//   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... PERPLEXITY_API_KEY=... GEMINI_API_KEY=... \
//   FIRECRAWL_API_KEY=... npx vitest run lib/engine/__tests__/local-smoke.live.test.ts
//
// Zero prod contact: DATABASE_URL must point at the local docker Postgres.
import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import * as tdb from "@/lib/tracker-db";
import { executeTrackerRun } from "@/lib/engine/runner";
import { recomputeAndStoreRunMetrics } from "@/lib/engine/run-metrics";
import { verifyCitationUrl } from "@/lib/citation-verify";
import { citationRunCredits, debitForRun } from "@/lib/credits";
import { CREDIT_USD } from "@/lib/pricing";
import type { CitationCheckInput } from "@/lib/tracker-db";
import { sql, eq } from "drizzle-orm";

const live = process.env.LIVE_SMOKE === "1";

// A safety belt: refuse to run against anything that isn't obviously local.
const url = process.env.DATABASE_URL ?? "";
const isLocal = /127\.0\.0\.1|localhost/.test(url);

describe.skipIf(!live)("LOCAL live smoke (real providers, local DB)", () => {
  it("runs a brand end-to-end and prints responses, citations, sentiment, metrics", async () => {
    if (!isLocal) throw new Error(`DATABASE_URL is not local — refusing: ${url.slice(0, 30)}…`);

    const BRAND = (process.env.SMOKE_BRAND ?? "FlowBlinq").trim();
    const DOMAIN = (process.env.SMOKE_DOMAIN ?? "flowblinq.com").trim();
    const PROMPTS = (process.env.SMOKE_PROMPTS ??
      `What is ${BRAND} and what does it do?|Best agentic commerce platforms for brands?`)
      .split("|").map((p) => p.trim()).filter(Boolean);

    const TEAM = `tm_smoke_${Date.now()}`;
    const USER = "u_smoke";

    // ── Seed: team + org + brand + prompts (all LOCAL) ──────────────────────
    const START_BALANCE = 100;
    await db.insert(schema.teams).values({ id: TEAM, name: "Smoke", ownerUserId: USER, creditBalance: START_BALANCE });
    const brand = await tdb.createBrand(TEAM, "Smoke", { name: BRAND, domain: DOMAIN });
    for (let i = 0; i < PROMPTS.length; i++) {
      await tdb.createPrompt(TEAM, brand.id, { name: `P${i + 1}`, category: "brand", text: PROMPTS[i] });
    }

    const created = await tdb.createManualRunRow(TEAM, brand.id);
    if (created.kind !== "run") throw new Error(`run not created: ${created.kind}`);
    const runId = created.run.id;

    const log = (...a: unknown[]) => console.log(...a);
    log("\n════════════════════════════════════════════════════════════════");
    log(`  LIVE RUN — brand="${BRAND}" domain=${DOMAIN}  prompts=${PROMPTS.length}  platforms=4`);
    log(`  run=${runId}  team=${TEAM}  (local DB ${url.replace(/:[^:@]*@/, ":***@")})`);
    log("════════════════════════════════════════════════════════════════");

    // ── PRICING: 2 credits per prompt per model, Claude (anthropic) 4 ───────
    log("\n── PRICING (2/prompt/model, Claude 4, 1 credit = $0.10) ────");
    const ALL = ["openai", "perplexity", "google", "anthropic"] as const;
    for (const [np, plats] of [[1, ["openai"] as const], [1, ALL], [2, ALL], [10, ALL], [30, ALL]] as const) {
      const cr = citationRunCredits(np, plats);
      log(`  ${String(np).padStart(2)} prompt${np > 1 ? "s" : " "} × ${plats.length} model${plats.length > 1 ? "s" : " "} = ${String(cr).padStart(3)} credits  ($${(cr * CREDIT_USD).toFixed(2)})`);
    }

    // Real debit for THIS run through the actual billing path (full 4-model run).
    const cost = citationRunCredits(PROMPTS.length);
    const bal = () => db.select({ b: schema.teams.creditBalance }).from(schema.teams).where(eq(schema.teams.id, TEAM)).then((r) => r[0].b);
    const before = await bal();
    const debit = await debitForRun(TEAM, runId, cost);
    const after = await bal();
    log(`\n  THIS run: ${PROMPTS.length} prompts × 4 models = ${cost} credits ($${(cost * CREDIT_USD).toFixed(2)})`);
    log(`  balance:  ${before} → ${after}   (debited ${cost}, applied=${debit.applied})`);
    expect(after).toBe(before - cost);

    // ── Execute the REAL engine (no injected deps → real provider clients) ──
    const t0 = Date.now();
    const result = await executeTrackerRun(runId, brand.id, 0, Date.now() + 780_000);
    log(`\nengine status=${result.status}  processed=${result.processed}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    expect(result.status).toBe("complete");

    // ── Read back what was persisted ────────────────────────────────────────
    const responses = await db.select().from(schema.trackerResponses).where(eq(schema.trackerResponses.runId, runId));
    const citations = await db.select().from(schema.trackerCitations).where(eq(schema.trackerCitations.runId, runId));

    const PLABEL: Record<string, string> = { openai: "ChatGPT", perplexity: "Perplexity", google: "Gemini", anthropic: "Claude" };
    log("\n── RESPONSES ─────────────────────────────────────────────────────");
    for (const r of responses.filter((x) => x.attempt === 1 || !responses.some((y) => y.promptVersionId === x.promptVersionId && y.platform === x.platform && y.attempt < x.attempt))) {
      const mention = r.brandMentioned ? "✓ mentioned" : "· no mention";
      const sent = r.sentiment ? `  sentiment=${r.sentiment}` : "";
      const err = r.error ? `  ERROR=${r.error}` : "";
      const nCites = citations.filter((c) => c.responseId === r.id).length;
      log(`\n[${PLABEL[r.platform] ?? r.platform}]  ${mention}${sent}  cites=${nCites}${err}`);
      log("  " + (r.responseText ?? "").replace(/\s+/g, " ").slice(0, 220) + "…");
    }

    log("\n── CITATIONS (matched by domain) ─────────────────────────────────");
    for (const c of citations) {
      const tag = c.matchType === "exact" ? "EXACT" : c.matchType === "partial" ? "partial" : "third-party";
      const resolved = c.resolvedUrl && c.resolvedUrl !== c.rawUrl ? "  (resolved from redirect)" : "";
      log(`  [${PLABEL[c.platform ?? ""] ?? c.platform}] ${tag}  ${c.normalizedUrl}${resolved}`);
    }
    if (citations.length === 0) log("  (no citations returned)");

    // ── Metrics ─────────────────────────────────────────────────────────────
    const metrics = await recomputeAndStoreRunMetrics(runId);
    log("\n── METRICS ───────────────────────────────────────────────────────");
    log(`  brand mention rate : ${((metrics?.brandMentionRate ?? 0) * 100).toFixed(0)}%`);
    log(`  citation rate      : ${((metrics?.citationRate ?? 0) * 100).toFixed(0)}%`);
    log(`  total citations    : ${metrics?.totalCitations ?? 0}`);
    for (const p of metrics?.platformBreakdown ?? []) {
      log(`    ${(PLABEL[p.platform] ?? p.platform).padEnd(11)} mention=${(p.brandMentionRate * 100).toFixed(0)}%  cites=${p.totalCitations}`);
    }

    // ── Hallucination guard: verify EVERY unchecked citation + persist (this
    //    is exactly what /api/cron/verify-citations does) ────────────────────
    if (process.env.FIRECRAWL_API_KEY) {
      const unchecked = await tdb.listUncheckedTeamCitations(50);
      const checks: CitationCheckInput[] = [];
      const CONC = 5;
      for (let i = 0; i < unchecked.length; i += CONC) {
        const slice = unchecked.slice(i, i + CONC);
        const verdicts = await Promise.all(slice.map((c) => verifyCitationUrl(c.url, c.keywords).catch(() => ({ status: "unverifiable" as const }))));
        slice.forEach((c, j) => checks.push({
          citationId: c.citationId, runId: c.runId, clientId: c.clientId, url: c.url,
          status: verdicts[j].status,
          httpStatus: "httpStatus" in verdicts[j] ? verdicts[j].httpStatus : undefined,
          brandMatched: "brandMatched" in verdicts[j] ? verdicts[j].brandMatched : undefined,
          via: "via" in verdicts[j] ? verdicts[j].via : undefined,
        }));
      }
      await tdb.recordCitationChecks(checks);
      const tally = checks.reduce<Record<string, number>>((a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {});
      log("\n── HALLUCINATION GUARD (verified every citation) ─────────────────");
      log("  verdicts: " + JSON.stringify(tally));
    }

    // ── CE brand-domain citation stats — the numbers the UI actually shows ──
    const withStats = await tdb.listRunsWithStats(TEAM, brand.id);
    const s = withStats.find((r) => r.id === runId)?.citationStats;
    log("\n── CE CITATION STATS (brand-domain matching + guard) ─────────────");
    log(`  brand citations    : ${s?.brandCitations ?? 0}  (verified, guard-flagged excluded)`);
    log(`  brand citation rate: ${s?.brandCitationRate != null ? (s.brandCitationRate * 100).toFixed(0) + "%" : "—"}`);
    log(`  hallucinated (guard-flagged, dropped): ${s?.hallucinatedCitations ?? 0}`);

    const top = await tdb.getRunTopSources(TEAM, brand.id, runId, 10);
    log("  top cited pages (dead/no-mention already dropped):");
    for (const t of top) {
      log(`    ${(String(t.count) + "×").padEnd(3)} ${t.page.slice(0, 60).padEnd(60)} [${(t.platforms ?? []).map((p) => PLABEL[p ?? ""] ?? p).join(",")}]`);
    }

    log("\n════════════════════════════════════════════════════════════════\n");

    // ── Cleanup the smoke team so repeated runs stay clean ──────────────────
    await db.execute(sql`DELETE FROM tracker.orgs WHERE id = ${"team_" + TEAM}`);
    await db.delete(schema.teams).where(eq(schema.teams.id, TEAM));

    expect(responses.length).toBeGreaterThan(0);
  }, 800_000);
});
