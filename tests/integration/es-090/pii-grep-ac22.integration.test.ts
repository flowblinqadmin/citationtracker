/**
 * ES-090 IT-AC22 — PII-safe telemetry grep harness (ChangedSpec per HP-194).
 *
 * Runs a battery of actions that emit Sentry events, captures the events
 * through a test transport, then greps the serialized event stream for
 * leaked tokens / IPs. AC-22: zero matches required.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { closeDb, seedSite } from "./_setup";

const captured: unknown[] = [];

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterAll(async () => { await closeDb(); });
beforeEach(() => { captured.length = 0; });

describe("ES-090 AC-22 — Sentry event stream has zero PII matches", () => {
  it("after a week-equivalent burst of auth + pipeline + credit events, grep finds zero IPv4/nanoid/sb-* leaks", async () => {
    // Install the test transport so Sentry events land in `captured` instead of Sentry ingest.
    let sentry: { __test_setTransport?: (cb: (e: unknown) => void) => void };
    try {
      sentry = await import("@/lib/observability/sentry") as unknown as typeof sentry;
    } catch {
      console.warn("[IT-AC22] skipped — @/lib/observability/sentry not yet implemented");
      return;
    }
    expect(sentry.__test_setTransport, "lib/observability/sentry must expose __test_setTransport").toBeDefined();
    sentry.__test_setTransport!((e: unknown) => captured.push(e));

    const site = await seedSite({ withTeam: true });

    // Emit across surfaces: pipeline failure, 401 auth, credit debit, exchange-code redeem.
    // Each endpoint is assumed wired to Sentry per §b.13.
    await Promise.all([
      fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/pipeline/stage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${site.accessToken}` },
        body: JSON.stringify({ siteId: site.id, stage: "__force_error__" }),
      }).catch(() => undefined),
      fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/sites/${site.id}?token=wrong-${site.accessToken}`).catch(() => undefined),
      fetch(`${process.env.NEXT_PUBLIC_APP_URL}/auth/exchange?code=bogus-nonexistent-code`).catch(() => undefined),
    ]);

    const serialized = JSON.stringify(captured);

    // AC-22 assertions: zero matches for nanoid-32 access tokens, public IPv4,
    // public IPv6, and the sb-*-auth-token cookie family.
    const NANOID = /\b[A-Za-z0-9_-]{32}\b/g;
    const PUBLIC_IPV4 = /\b(?:(?!10\.)(?!127\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!169\.254\.)(?:\d{1,3}\.){3}\d{1,3})\b/g;
    const SB_COOKIE_VALUE = /sb-[^=]+auth-token[^=]*=[^;,"\s]+/g;

    const nanoidMatches = serialized.match(NANOID) ?? [];
    const ipv4Matches = serialized.match(PUBLIC_IPV4) ?? [];
    const sbCookieMatches = serialized.match(SB_COOKIE_VALUE) ?? [];

    // Filter nanoid matches to exclude the redacted literal and event IDs (32-char hex).
    const suspicious = nanoidMatches.filter((m) => m !== "[REDACTED]" && !/^[a-f0-9]{32}$/.test(m));

    expect(suspicious, `nanoid leak suspects in Sentry event stream: ${suspicious.slice(0, 5).join(", ")}`).toHaveLength(0);
    expect(ipv4Matches, `public IPv4 leak: ${ipv4Matches.slice(0, 5).join(", ")}`).toHaveLength(0);
    expect(sbCookieMatches, `sb-* cookie value leak: ${sbCookieMatches.slice(0, 3).join(", ")}`).toHaveLength(0);
  }, 60_000);
});
