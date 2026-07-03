/**
 * ES-090 IT3 — XSS payload in LLM answer scrubbed before reaching the DOM.
 *
 * Phase A (RED): renders /sites/[id] with citation_responses.answer containing
 * a <img src=x onerror=alert(1)> payload. The post-§b.3 sanitizer must scrub
 * the onerror attr; main @ 70645cba does not.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { db, seedSite, cleanupSite, closeDb } from "./_setup";

const created: string[] = [];

beforeAll(() => {
  if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
});

afterEach(async () => {
  while (created.length) {
    const id = created.pop()!;
    try { await cleanupSite(id); } catch { /* ignore */ }
  }
});

afterAll(async () => { await closeDb(); });

describe("ES-090 IT3 — Stored XSS in LLM answer scrubbed", () => {
  it("renders /sites/[id] with payload in citation_responses.answer; no onerror in DOM", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    // Insert a citation response whose `answer` contains the canonical XSS payload.
    const { citationCheckResponses } = await import("@/lib/db/schema");
    const xss = '<img src="x" onerror="alert(1)">malicious';
    await db.insert(citationCheckResponses).values({
      id: `cr_${site.id}`,
      siteId: site.id,
      promptId: "pX",
      provider: "perplexity",
      answer: xss,
      mentioned: true,
      createdAt: new Date(),
    } as Record<string, unknown>);

    const html = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/sites/${site.id}?token=${site.accessToken}`).then((r) => r.text());

    expect(html, "rendered DOM must not contain onerror= after sanitization").not.toMatch(/onerror=/i);
    expect(html, "rendered DOM must not contain alert(1)").not.toContain("alert(1)");
    // The benign text body of the message should still be present.
    expect(html).toContain("malicious");
  }, 30_000);
});
