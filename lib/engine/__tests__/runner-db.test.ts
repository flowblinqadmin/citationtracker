// Full engine integration against real Postgres: executeTrackerRun with
// injected RunnerDeps (no network). Covers persistence, grounding + sentiment
// + 4-platform gating for team orgs (and 3-platform NULL-prompt PCG runs),
// re-run-once, resume idempotency, cursor pause, scope filtering, errored
// providers (R04), and stored metrics.
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import * as tdb from "@/lib/tracker-db";
import { sql, eq } from "drizzle-orm";
import {
  executeTrackerRun,
  GROUNDED_CITATION_SYSTEM_PROMPT,
  type RunnerDeps,
} from "@/lib/engine/runner";
import type { ProviderQueryResult } from "@/lib/engine/providers";
import type { TrackerPlatform } from "@/lib/types/tracker";

const dbUrl = process.env.TEST_DATABASE_URL;

const PLATFORMS: TrackerPlatform[] = ["perplexity", "openai", "google", "anthropic"];
const FAR_DEADLINE = () => Date.now() + 60_000;

interface RecordedCall {
  platform: TrackerPlatform;
  prompt: string;
  opts?: { systemPrompt?: string | null; maxTokens?: number };
}

/** Deps whose every provider returns `result` (or throws) and records calls. */
function makeDeps(
  result: (platform: TrackerPlatform, prompt: string) => ProviderQueryResult | Error,
  overrides: Partial<RunnerDeps> = {},
): { deps: RunnerDeps; calls: RecordedCall[]; sentimentCalls: string[] } {
  const calls: RecordedCall[] = [];
  const sentimentCalls: string[] = [];
  const queryFns = Object.fromEntries(
    PLATFORMS.map((platform) => [
      platform,
      async (prompt: string, opts?: { systemPrompt?: string | null; maxTokens?: number }) => {
        calls.push({ platform, prompt, opts });
        const r = result(platform, prompt);
        if (r instanceof Error) throw r;
        return r;
      },
    ]),
  );
  const deps: RunnerDeps = {
    queryFns,
    resolveRedirectsFn: async (url: string) => url,
    classifySentimentFn: async (brand: string) => {
      sentimentCalls.push(brand);
      return "positive" as const;
    },
    ...overrides,
  };
  return { deps, calls, sentimentCalls };
}

describe.skipIf(!dbUrl)("executeTrackerRun (Postgres)", () => {
  const TEAM = "tm_runner";
  let clientId: string;

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM tracker.orgs`);
    await db.delete(schema.teams).where(eq(schema.teams.id, TEAM));
    await db.insert(schema.teams).values({ id: TEAM, name: "Runner", ownerUserId: "u_r", creditBalance: 100 });
    const brand = await tdb.createBrand(TEAM, "Runner", { name: "Acme", domain: "acme.com" });
    clientId = brand.id;
    await tdb.createPrompt(TEAM, clientId, { name: "P1", category: "brand", text: "What is Acme?" });
    await tdb.createPrompt(TEAM, clientId, { name: "P2", category: "category", text: "Best tools?" });
  });

  async function createRun(scope?: { promptIds?: string[]; platforms?: TrackerPlatform[] }) {
    let scopeInput;
    if (scope?.promptIds || scope?.platforms) scopeInput = scope;
    const created = await tdb.createManualRunRow(TEAM, clientId, scopeInput);
    if (created.kind !== "run") throw new Error(`run not created: ${created.kind}`);
    return created.run;
  }

  const responsesOf = (runId: string) =>
    db.select().from(schema.trackerResponses).where(eq(schema.trackerResponses.runId, runId));
  const citationsOf = (runId: string) =>
    db.select().from(schema.trackerCitations).where(eq(schema.trackerCitations.runId, runId));
  const runRow = async (runId: string) =>
    (await db.select().from(schema.trackerRuns).where(eq(schema.trackerRuns.id, runId)))[0];

  it("executes a full team run: 4 platforms, grounded prompts, sentiment, citations, metrics", async () => {
    const { deps, calls, sentimentCalls } = makeDeps(() => ({
      text: "Acme is a great tool — see acme.com.",
      responseTimeMs: 3,
      citedUrls: ["https://reviews.example/acme-review"],
    }));
    const run = await createRun();

    const result = await executeTrackerRun(run.id, clientId, 0, FAR_DEADLINE(), undefined, deps);
    expect(result.status).toBe("complete");

    // 2 prompts × 4 platforms, one attempt each (citations came back first try).
    const responses = await responsesOf(run.id);
    expect(responses).toHaveLength(8);
    expect(new Set(responses.map((r) => r.platform))).toEqual(new Set(PLATFORMS));
    expect(responses.every((r) => r.attempt === 1)).toBe(true);

    // Team org ⇒ every query carried the anti-hallucination system prompt.
    expect(calls).toHaveLength(8);
    expect(calls.every((c) => c.opts?.systemPrompt === GROUNDED_CITATION_SYSTEM_PROMPT)).toBe(true);

    // Brand mentioned everywhere ⇒ sentiment classified per response, stored.
    expect(responses.every((r) => r.brandMentioned)).toBe(true);
    expect(responses.every((r) => r.sentiment === "positive")).toBe(true);
    expect(sentimentCalls).toHaveLength(8);
    expect(sentimentCalls.every((b) => b === "Acme")).toBe(true);

    // Citations persisted, matched (no articles ⇒ unmatched), same-URL ⇒ resolvedUrl null.
    const citations = await citationsOf(run.id);
    expect(citations).toHaveLength(8);
    expect(citations.every((c) => c.matchType === "unmatched")).toBe(true);
    expect(citations.every((c) => c.resolvedUrl === null)).toBe(true);
    expect(citations.every((c) => c.domain === "reviews.example")).toBe(true);

    // Run row: complete, models stamped, metrics computed over 4 platforms.
    const row = await runRow(run.id);
    expect(row.status).toBe("complete");
    expect(Object.keys(row.modelsUsed ?? {}).sort()).toEqual([...PLATFORMS].sort());
    expect(row.metrics?.promptsTotal).toBe(2);
    expect(row.metrics?.brandMentionRate).toBe(1);
    expect(row.metrics?.platformBreakdown).toHaveLength(4);
  });

  it("re-runs a zero-citation prompt exactly once and is idempotent on re-invocation", async () => {
    const { deps } = makeDeps(() => ({ text: "Acme exists.", responseTimeMs: 1, citedUrls: [] }));
    const run = await createRun();

    await executeTrackerRun(run.id, clientId, 0, FAR_DEADLINE(), undefined, deps);
    const responses = await responsesOf(run.id);
    // Both attempts stored for every (prompt × platform) pair.
    expect(responses).toHaveLength(16);
    expect(responses.filter((r) => r.attempt === 2)).toHaveLength(8);

    // Second invocation (QStash re-delivery / stale recovery on a completed
    // run) is skipped outright.
    const again = await executeTrackerRun(run.id, clientId, 0, FAR_DEADLINE(), undefined, deps);
    expect(again.status).toBe("skipped");
    expect(await responsesOf(run.id)).toHaveLength(16);
  });

  it("R17: resuming a run whose pair has attempt-1 persisted with 0 citations runs only attempt 2", async () => {
    const { deps, calls } = makeDeps(() => ({ text: "Acme exists.", responseTimeMs: 1, citedUrls: [] }));
    const run = await createRun({ promptIds: undefined, platforms: ["openai"] });

    // Simulate a crash after attempt-1: insert the attempt-1 rows manually.
    const versions = await db.execute(sql`
      SELECT pv.id FROM tracker.prompt_versions pv
      JOIN tracker.prompts p ON p.id = pv.prompt_id WHERE p.client_id = ${clientId}
    `) as unknown as Array<{ id: string }>;
    for (const v of versions) {
      await db.execute(sql`
        INSERT INTO tracker.responses (id, run_id, client_id, prompt_version_id, platform, attempt, response_text, cited_urls, brand_mentioned)
        VALUES (${"trr_pre_" + v.id}, ${run.id}, ${clientId}, ${v.id}, 'openai', 1, 'Acme exists.', '[]', true)
      `);
    }

    await executeTrackerRun(run.id, clientId, 0, FAR_DEADLINE(), undefined, deps);
    const responses = await responsesOf(run.id);
    expect(responses).toHaveLength(4); // 2 pre-seeded attempt-1 + 2 fresh attempt-2
    expect(responses.filter((r) => r.attempt === 2)).toHaveLength(2);
    expect(calls).toHaveLength(2); // never re-ran attempt 1
  });

  it("pauses at the deadline with a cursor and resumes to completion", async () => {
    const { deps } = makeDeps(() => ({
      text: "Acme.", responseTimeMs: 1, citedUrls: ["https://x.example/a"],
    }));
    const run = await createRun();

    // now() already past the deadline ⇒ immediate pause, nothing processed.
    const paused = await executeTrackerRun(run.id, clientId, 0, 1_000, () => 2_000, deps);
    expect(paused.status).toBe("paused");
    expect(paused.processed).toBe(0);
    expect(await responsesOf(run.id)).toHaveLength(0);
    expect((await runRow(run.id)).status).toBe("running");

    // Resume from the cursor with headroom ⇒ completes.
    const done = await executeTrackerRun(run.id, clientId, paused.cursor, FAR_DEADLINE(), undefined, deps);
    expect(done.status).toBe("complete");
    expect(await responsesOf(run.id)).toHaveLength(8);
  });

  it("honors run scope: one prompt × one platform executes exactly one work item", async () => {
    const prompts = await tdb.listPrompts(TEAM, clientId);
    const { deps, calls } = makeDeps(() => ({
      text: "Acme.", responseTimeMs: 1, citedUrls: ["https://x.example/a"],
    }));
    const run = await createRun({ promptIds: [prompts[0].promptId], platforms: ["google"] });

    await executeTrackerRun(run.id, clientId, 0, FAR_DEADLINE(), undefined, deps);
    const responses = await responsesOf(run.id);
    expect(responses).toHaveLength(1);
    expect(responses[0].platform).toBe("google");
    expect(calls).toHaveLength(1);
    expect((await runRow(run.id)).metrics?.promptsTotal).toBe(1);
  });

  it("PCG org runs: 3 platforms, NULL system prompt, no sentiment classification", async () => {
    await db.execute(sql`INSERT INTO tracker.orgs (id, name) VALUES ('org_pcg', 'PCG')`);
    await db.execute(sql`
      INSERT INTO tracker.clients (id, org_id, name, domain, status, run_frequency)
      VALUES ('tc_pcg_r', 'org_pcg', 'PCG Co', 'pcgco.com', 'active', 'manual')
    `);
    await db.execute(sql`INSERT INTO tracker.prompts (id, client_id, name, category) VALUES ('tp_pcg_r', 'tc_pcg_r', 'P', 'brand')`);
    await db.execute(sql`INSERT INTO tracker.prompt_versions (id, prompt_id, version, text) VALUES ('tpv_pcg_r', 'tp_pcg_r', 1, 'What is PCG Co?')`);
    await db.execute(sql`
      INSERT INTO tracker.runs (id, client_id, org_id, period, kind, status, prompts_total)
      VALUES ('tr_pcg_r', 'tc_pcg_r', 'org_pcg', '2026-07', 'manual', 'pending', 1)
    `);

    const { deps, calls, sentimentCalls } = makeDeps(() => ({
      text: "PCG Co is mentioned — pcgco.com.",
      responseTimeMs: 1,
      citedUrls: ["https://news.example/pcg"],
    }));
    await executeTrackerRun("tr_pcg_r", "tc_pcg_r", 0, FAR_DEADLINE(), undefined, deps);

    const responses = await responsesOf("tr_pcg_r");
    expect(responses).toHaveLength(3);
    expect(new Set(responses.map((r) => r.platform))).toEqual(new Set(["perplexity", "openai", "google"]));
    // Measurement runs are unsteered and never classified.
    expect(calls.every((c) => c.opts?.systemPrompt === null)).toBe(true);
    expect(sentimentCalls).toHaveLength(0);
    expect(responses.every((r) => r.sentiment === null)).toBe(true);
  });

  it("R04: errored providers store the error, skip re-run + sentiment, and stay out of metrics denominators", async () => {
    const { deps, sentimentCalls } = makeDeps((platform) =>
      platform === "openai"
        ? new Error("boom 500")
        : { text: "Acme is great.", responseTimeMs: 1, citedUrls: ["https://x.example/a"] },
    );
    const run = await createRun();

    const result = await executeTrackerRun(run.id, clientId, 0, FAR_DEADLINE(), undefined, deps);
    expect(result.status).toBe("complete");

    const responses = await responsesOf(run.id);
    const errored = responses.filter((r) => r.error);
    // 2 prompts × openai, single attempt each (errors don't re-run)...
    expect(errored).toHaveLength(2);
    expect(errored.every((r) => r.platform === "openai" && r.attempt === 1)).toBe(true);
    expect(errored.every((r) => r.sentiment === null)).toBe(true);
    // ...and sentiment ran only for the 6 successful responses.
    expect(sentimentCalls).toHaveLength(6);

    // Metrics: successful responses all mentioned the brand ⇒ rate stays 1
    // (errored rows excluded from the denominator, not counted as misses).
    expect((await runRow(run.id)).metrics?.brandMentionRate).toBe(1);
  });

  it("resolves redirect URLs before matching and records raw + resolved", async () => {
    const { deps } = makeDeps(() => ({
      text: "Acme.",
      responseTimeMs: 1,
      citedUrls: ["https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc123"],
    }), {
      resolveRedirectsFn: async () => "https://real.example/acme-article",
    });
    const run = await createRun({ platforms: ["google"] });

    await executeTrackerRun(run.id, clientId, 0, FAR_DEADLINE(), undefined, deps);
    const citations = await citationsOf(run.id);
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0].rawUrl).toContain("vertexaisearch");
    expect(citations[0].resolvedUrl).toBe("https://real.example/acme-article");
    expect(citations[0].normalizedUrl).toBe("real.example/acme-article");
    expect(citations[0].domain).toBe("real.example");
  });
});
