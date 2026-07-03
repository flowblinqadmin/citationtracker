/**
 * ES-090 IT15 — CSP report-only emits no console violations on 4 routes.
 *
 * Loads /, /sites/[id], /verify/[id], /dashboard with headless Chrome via
 * Playwright + collects CSP reports. Phase A: scaffold-only — implementation
 * runs against a live dev server. The pre-documented allow-list is acceptable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { seedSite, cleanupSite, closeDb } from "./_setup";

const created: string[] = [];
const ROUTES = ["/", "/dashboard"]; // /sites/[id] + /verify/[id] are seeded below.

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterAll(async () => {
  while (created.length) {
    const id = created.pop()!;
    try { await cleanupSite(id); } catch { /* ignore */ }
  }
  await closeDb();
});

interface PlaywrightLike {
  chromium: { launch: (opts?: { headless?: boolean }) => Promise<{ newPage: () => Promise<{
    on: (evt: string, handler: (msg: unknown) => void) => void;
    goto: (url: string) => Promise<unknown>;
    close: () => Promise<void>;
  }>; close: () => Promise<void> }> };
}

describe("ES-090 IT15 — CSP Report-Only emits no unexpected violations", () => {
  it("loads 4 routes; collected CSP reports match documented allow-list", async () => {
    let pw: PlaywrightLike;
    try {
      pw = (await import("playwright")) as unknown as PlaywrightLike;
    } catch {
      console.warn("[IT15] skipped — playwright not installed");
      return;
    }

    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    const targets = [
      ...ROUTES,
      `/sites/${site.id}?token=${site.accessToken}`,
      `/verify/${site.id}`,
    ];

    const browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage();
    const violations: unknown[] = [];
    page.on("console", (msg: unknown) => {
      const text = String((msg as { text?: () => string }).text?.() ?? "");
      if (/Content Security Policy|CSP/i.test(text)) violations.push(text);
    });

    for (const t of targets) {
      await page.goto(`${process.env.NEXT_PUBLIC_APP_URL}${t}`);
    }

    await page.close();
    await browser.close();

    // The pre-documented allow-list is empty in Phase A — any violation fails.
    expect(violations, `unexpected CSP violations: ${JSON.stringify(violations)}`).toHaveLength(0);
  }, 90_000);
});
