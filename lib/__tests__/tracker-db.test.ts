// lib/tracker-db.ts is the ONLY module allowed to touch tracker.* tables.
// These tests prove team scoping: a foreign org (PCG-like, not team-prefixed)
// seeded alongside must be invisible and untouchable through every function.
import { describe, it, expect, beforeEach } from "vitest";
import * as tdb from "@/lib/tracker-db";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { sql, eq } from "drizzle-orm";

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)("tracker-db (Postgres)", () => {
  const TEAM = "tm_tracker_test";
  const FOREIGN_ORG = "org_pcg_like";
  let foreignClientId: string;

  beforeEach(async () => {
    // Wipe tracker tables + test team (FK cascades handle children).
    await db.execute(sql`DELETE FROM tracker.orgs`);
    await db.delete(schema.creditTransactions).where(eq(schema.creditTransactions.teamId, TEAM));
    await db.delete(schema.teams).where(eq(schema.teams.id, TEAM));
    await db.insert(schema.teams).values({ id: TEAM, name: "Tracker Test", ownerUserId: "u1", creditBalance: 100 });

    // Foreign org with a client — must never be reachable.
    await db.insert(schema.trackerOrgs).values({ id: FOREIGN_ORG, name: "PCG" });
    foreignClientId = "tc_foreign";
    await db.insert(schema.trackerClients).values({
      id: foreignClientId, orgId: FOREIGN_ORG, name: "Foreign Brand", domain: "foreign.com",
    });
  });

  describe("ensureOrgForTeam", () => {
    it("creates the org once and is idempotent", async () => {
      const a = await tdb.ensureOrgForTeam(TEAM, "Tracker Test");
      const b = await tdb.ensureOrgForTeam(TEAM, "Tracker Test");
      expect(a).toBe(`team_${TEAM}`);
      expect(b).toBe(a);
      const orgs = await db.select().from(schema.trackerOrgs).where(eq(schema.trackerOrgs.id, a));
      expect(orgs).toHaveLength(1);
    });

    it("is race-safe under concurrent creation", async () => {
      const ids = await Promise.all([
        tdb.ensureOrgForTeam(TEAM, "Tracker Test"),
        tdb.ensureOrgForTeam(TEAM, "Tracker Test"),
        tdb.ensureOrgForTeam(TEAM, "Tracker Test"),
      ]);
      expect(new Set(ids).size).toBe(1);
    });

    it("never creates tracker.members rows", async () => {
      await tdb.ensureOrgForTeam(TEAM, "Tracker Test");
      const members = await db.execute(sql`SELECT * FROM tracker.members`);
      expect((members as unknown as unknown[]).length).toBe(0);
    });
  });

  describe("brands", () => {
    it("creates and lists brands scoped to the team", async () => {
      const brand = await tdb.createBrand(TEAM, "Tracker Test", { name: "Acme", domain: "acme.com" });
      expect(brand.orgId).toBe(`team_${TEAM}`);
      const list = await tdb.listBrands(TEAM);
      expect(list.map((b) => b.id)).toEqual([brand.id]);
      // Foreign org's client is not in the list.
      expect(list.find((b) => b.id === foreignClientId)).toBeUndefined();
    });

    it("cross-org: get/update/delete of a foreign client returns null/false", async () => {
      expect(await tdb.getBrand(TEAM, foreignClientId)).toBeNull();
      expect(await tdb.updateBrand(TEAM, foreignClientId, { name: "Hacked" })).toBeNull();
      expect(await tdb.deleteBrand(TEAM, foreignClientId)).toBe(false);
      const [still] = await db.select().from(schema.trackerClients).where(eq(schema.trackerClients.id, foreignClientId));
      expect(still.name).toBe("Foreign Brand");
    });

    it("sets nextRunAt when frequency is weekly and clears it for manual", async () => {
      const brand = await tdb.createBrand(TEAM, "T", { name: "A", runFrequency: "weekly" });
      expect(brand.nextRunAt).not.toBeNull();
      const updated = await tdb.updateBrand(TEAM, brand.id, { runFrequency: "manual" });
      expect(updated!.nextRunAt).toBeNull();
    });
  });

  describe("prompts", () => {
    let clientId: string;
    beforeEach(async () => {
      const b = await tdb.createBrand(TEAM, "T", { name: "Acme" });
      clientId = b.id;
    });

    it("creates a prompt with version 1 and lists current text", async () => {
      const p = await tdb.createPrompt(TEAM, clientId, { name: "Brand check", category: "brand", text: "What is Acme?" });
      expect(p).toMatchObject({ name: "Brand check", version: 1, text: "What is Acme?" });
      const list = await tdb.listPrompts(TEAM, clientId);
      expect(list).toHaveLength(1);
      expect(list[0].text).toBe("What is Acme?");
    });

    it("editing text creates version 2 (immutable versions)", async () => {
      const p = await tdb.createPrompt(TEAM, clientId, { name: "P", category: "brand", text: "v1" });
      const updated = await tdb.updatePromptText(TEAM, clientId, p.promptId, "v2");
      expect(updated!.version).toBe(2);
      const versions = await db
        .select()
        .from(schema.trackerPromptVersions)
        .where(eq(schema.trackerPromptVersions.promptId, p.promptId));
      expect(versions.map((v) => v.text).sort()).toEqual(["v1", "v2"]);
    });

    it("rejects the 31st active prompt", async () => {
      for (let i = 0; i < 30; i++) {
        await tdb.createPrompt(TEAM, clientId, { name: `P${i}`, category: "brand", text: `t${i}` });
      }
      await expect(
        tdb.createPrompt(TEAM, clientId, { name: "P31", category: "brand", text: "over" }),
      ).rejects.toThrow(/30/);
    });

    it("rejects over-length prompt text (cost control)", async () => {
      await expect(
        tdb.createPrompt(TEAM, clientId, { name: "Long", category: "brand", text: "x".repeat(501) }),
      ).rejects.toThrow(/500/);
    });

    it("cross-org: cannot create/edit prompts on a foreign client", async () => {
      await expect(
        tdb.createPrompt(TEAM, foreignClientId, { name: "X", category: "brand", text: "t" }),
      ).rejects.toThrow(/not found/i);
      expect(await tdb.listPrompts(TEAM, foreignClientId)).toEqual([]);
    });

    it("archiving frees a slot under the cap", async () => {
      const p = await tdb.createPrompt(TEAM, clientId, { name: "P", category: "brand", text: "t" });
      expect(await tdb.archivePrompt(TEAM, clientId, p.promptId)).toBe(true);
      const list = await tdb.listPrompts(TEAM, clientId);
      expect(list).toEqual([]);
    });
  });

  describe("runs", () => {
    let clientId: string;
    beforeEach(async () => {
      const b = await tdb.createBrand(TEAM, "T", { name: "Acme" });
      clientId = b.id;
      await tdb.createPrompt(TEAM, clientId, { name: "P", category: "brand", text: "t" });
    });

    it("creates a manual run row with prompt count", async () => {
      const r = await tdb.createManualRunRow(TEAM, clientId);
      expect(r.kind).toBe("run");
      if (r.kind !== "run") throw new Error("unreachable");
      expect(r.run.kind).toBe("manual");
      expect(r.run.status).toBe("pending");
      expect(r.promptCount).toBe(1);
      expect(r.run.orgId).toBe(`team_${TEAM}`);
    });

    it("returns no_prompts when the brand has no active prompts", async () => {
      const b2 = await tdb.createBrand(TEAM, "T", { name: "Empty" });
      const r = await tdb.createManualRunRow(TEAM, b2.id);
      expect(r.kind).toBe("no_prompts");
    });

    it("returns the in-flight run instead of creating a second", async () => {
      const first = await tdb.createManualRunRow(TEAM, clientId);
      if (first.kind !== "run") throw new Error("setup");
      const second = await tdb.createManualRunRow(TEAM, clientId);
      expect(second.kind).toBe("in_flight");
      if (second.kind !== "in_flight") throw new Error("unreachable");
      expect(second.run.id).toBe(first.run.id);
    });

    it("cross-org: cannot create or list runs on a foreign client", async () => {
      const r = await tdb.createManualRunRow(TEAM, foreignClientId);
      expect(r.kind).toBe("not_found");
      expect(await tdb.listRuns(TEAM, foreignClientId)).toEqual([]);
    });

    describe("scoped runs", () => {
      let secondPromptId: string;
      beforeEach(async () => {
        const p = await tdb.createPrompt(TEAM, clientId, { name: "P2", category: "brand", text: "t2" });
        secondPromptId = p.promptId;
      });

      it("single prompt: stores its LATEST version id in scope, promptsTotal=1", async () => {
        await tdb.updatePromptText(TEAM, clientId, secondPromptId, "t2 v2");
        const r = await tdb.createManualRunRow(TEAM, clientId, { promptIds: [secondPromptId] });
        if (r.kind !== "run") throw new Error(`expected run, got ${r.kind}`);
        expect(r.promptCount).toBe(1);
        expect(r.platformCount).toBe(3);
        expect(r.run.promptsTotal).toBe(1);
        expect(r.run.scope?.promptVersionIds).toHaveLength(1);
        const prompts = await tdb.listPrompts(TEAM, clientId);
        expect(prompts.find((p) => p.promptId === secondPromptId)?.version).toBe(2);
      });

      it("single platform: scope stores it and platformCount=1", async () => {
        const r = await tdb.createManualRunRow(TEAM, clientId, { platforms: ["google"] });
        if (r.kind !== "run") throw new Error(`expected run, got ${r.kind}`);
        expect(r.platformCount).toBe(1);
        expect(r.promptCount).toBe(2);
        expect(r.run.scope?.platforms).toEqual(["google"]);
        expect(r.run.scope?.promptVersionIds).toBeUndefined();
      });

      it("no scope input → scope stays NULL (full run, geo behavior unchanged)", async () => {
        const r = await tdb.createManualRunRow(TEAM, clientId);
        if (r.kind !== "run") throw new Error(`expected run, got ${r.kind}`);
        expect(r.run.scope).toBeNull();
      });

      it("all platforms selected normalizes to no platform filter", async () => {
        const r = await tdb.createManualRunRow(TEAM, clientId, { platforms: ["google", "openai", "perplexity", "google"] });
        if (r.kind !== "run") throw new Error(`expected run, got ${r.kind}`);
        expect(r.platformCount).toBe(3);
        expect(r.run.scope).toBeNull();
      });

      it("rejects unknown platforms", async () => {
        const r = await tdb.createManualRunRow(TEAM, clientId, { platforms: ["bing" as never] });
        expect(r.kind).toBe("invalid_scope");
      });

      it("rejects prompt ids that are not this brand's active prompts", async () => {
        const r = await tdb.createManualRunRow(TEAM, clientId, { promptIds: ["tp_nope"] });
        expect(r.kind).toBe("invalid_scope");
        await tdb.archivePrompt(TEAM, clientId, secondPromptId);
        const r2 = await tdb.createManualRunRow(TEAM, clientId, { promptIds: [secondPromptId] });
        expect(r2.kind).toBe("invalid_scope");
      });
    });
  });
});

describe.skipIf(!dbUrl)("responses & history (Postgres)", () => {
  const TEAM = "tm_resp_test";
  let clientId: string;
  let promptId: string;
  let runId: string;

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM tracker.orgs`);
    await db.delete(schema.teams).where(eq(schema.teams.id, TEAM));
    await db.insert(schema.teams).values({ id: TEAM, name: "Resp", ownerUserId: "u", creditBalance: 10 });
    const b = await tdb.createBrand(TEAM, "Resp", { name: "Acme" });
    clientId = b.id;
    const p = await tdb.createPrompt(TEAM, clientId, { name: "P", category: "brand", text: "What is Acme?" });
    promptId = p.promptId;

    const created = await tdb.createManualRunRow(TEAM, clientId);
    if (created.kind !== "run") throw new Error("setup");
    runId = created.run.id;
    // Simulate geo's worker persisting a response for the run.
    const [version] = await db
      .select()
      .from(schema.trackerPromptVersions)
      .where(eq(schema.trackerPromptVersions.promptId, promptId));
    await db.insert(schema.trackerResponses).values({
      id: "resp_1", runId, clientId, promptVersionId: version.id,
      platform: "openai", model: "gpt-5.4-mini", attempt: 1,
      responseText: "Acme is a company.", citedUrls: ["https://acme.com"], brandMentioned: true,
    });
  });

  it("lists a run's replies joined with prompt name/text", async () => {
    const rows = await tdb.listRunResponses(TEAM, clientId, runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      promptName: "P",
      promptText: "What is Acme?",
      platform: "openai",
      responseText: "Acme is a company.",
      brandMentioned: true,
    });
  });

  it("lists a prompt's reply history across runs", async () => {
    const rows = await tdb.listPromptHistory(TEAM, clientId, promptId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "openai", period: expect.stringMatching(/^\d{4}-\d{2}$/) });
  });

  it("cross-org: foreign run/prompt returns empty", async () => {
    expect(await tdb.listRunResponses(TEAM, foreignClientIdFor(), runId)).toEqual([]);
    expect(await tdb.listRunResponses("tm_other_team", clientId, runId)).toEqual([]);
    expect(await tdb.listPromptHistory("tm_other_team", clientId, promptId)).toEqual([]);
  });

  function foreignClientIdFor(): string {
    return "tc_nonexistent";
  }

  describe("brand citation stats", () => {
    beforeEach(async () => {
      // Brand gets a domain + a competitor; seed citations for the run:
      // 2 brand-domain (one exact, one subdomain), 1 competitor, 1 third-party.
      await tdb.updateBrand(TEAM, clientId, {
        domain: "acme.com",
        competitors: [{ name: "Rival", domain: "rival.com" }],
      });
      const [version] = await db
        .select()
        .from(schema.trackerPromptVersions)
        .where(eq(schema.trackerPromptVersions.promptId, promptId));
      // Second response (another platform) with no brand citation.
      await db.insert(schema.trackerResponses).values({
        id: "resp_2", runId, clientId, promptVersionId: version.id,
        platform: "google", attempt: 1, responseText: "…", citedUrls: [], brandMentioned: false,
      });
      // citations have no FK to runs (they survive geo's response purge), so
      // they don't cascade with the org wipe — ids must be unique per test run.
      const cite = (suffix: string, domain: string, platform: "openai" | "google") =>
        db.insert(schema.trackerCitations).values({
          id: `${runId}_${suffix}`, runId, clientId, promptVersionId: version.id, platform,
          rawUrl: `https://${domain}/x`, normalizedUrl: `${domain}/x`, domain,
          matchType: "unmatched",
        });
      await cite("cit_1", "acme.com", "openai");
      await cite("cit_2", "docs.acme.com", "openai");
      await cite("cit_3", "rival.com", "google");
      await cite("cit_4", "wikipedia.org", "google");
    });

    it("counts totals, brand-domain (incl. subdomains), competitors, and per-reply rate", async () => {
      const runs = await tdb.listRunsWithStats(TEAM, clientId);
      const run = runs.find((r) => r.id === runId)!;
      expect(run.citationStats).toEqual({
        totalCitations: 4,
        brandCitations: 2,
        competitorCitations: 1,
        // 1 of 2 answered (promptVersion × platform) pairs has a brand citation
        brandCitationRate: 0.5,
      });
    });

    it("rate is null when the brand has no domain", async () => {
      await tdb.updateBrand(TEAM, clientId, { domain: "" });
      const runs = await tdb.listRunsWithStats(TEAM, clientId);
      const run = runs.find((r) => r.id === runId)!;
      expect(run.citationStats.brandCitationRate).toBeNull();
      expect(run.citationStats.brandCitations).toBe(0);
      expect(run.citationStats.totalCitations).toBe(4);
    });

    it("lists a run's top cited domains", async () => {
      const top = await tdb.getRunTopDomains(TEAM, clientId, runId);
      expect(top[0]).toEqual({ domain: "acme.com", count: 1, brand: true });
      expect(top).toHaveLength(4);
      expect(top.find((d) => d.domain === "docs.acme.com")?.brand).toBe(true);
      expect(top.find((d) => d.domain === "wikipedia.org")?.brand).toBe(false);
    });

    it("cross-org: stats and domains are empty for a foreign team", async () => {
      expect(await tdb.listRunsWithStats("tm_other_team", clientId)).toEqual([]);
      expect(await tdb.getRunTopDomains("tm_other_team", clientId, runId)).toEqual([]);
    });
  });
});
