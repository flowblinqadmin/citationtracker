/**
 * ES-090 IT10 + IT17 — completion-email exchange code + raw-token absence.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { seedSite, cleanupSite, closeDb } from "./_setup";

const created: string[] = [];
const sendgridCapture: Array<Record<string, unknown>> = [];

beforeAll(() => {
  if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  // Capture SendGrid payloads via the mailer module's test hook.
  vi.doMock("@/lib/email", async (orig) => {
    const real = await (orig as () => Promise<Record<string, unknown>>)();
    return {
      ...real,
      __test_capturedPayloads: sendgridCapture,
      sendCompletionEmail: async (...args: unknown[]) => {
        sendgridCapture.push({ args });
      },
    };
  });
});

afterEach(async () => {
  while (created.length) {
    const id = created.pop()!;
    try { await cleanupSite(id); } catch { /* ignore */ }
  }
});

afterAll(async () => { await closeDb(); });

describe("ES-090 IT10 — completion email link uses exchange code", () => {
  it("triggering assemble fires email with /auth/exchange?code=…; redeem sets cookie", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    // Trigger the assemble stage via the QStash callback path. This relies on
    // the in-process route handler — Phase A asserts only the email payload.
    const stage = await import("@/app/api/pipeline/stage/route");
    type Trigger = (siteId: string) => Promise<void>;
    const trigger = (stage as unknown as { __test_triggerAssemble?: Trigger }).__test_triggerAssemble;
    expect(trigger, "stage route must export __test_triggerAssemble for ES-090 IT10").toBeDefined();

    sendgridCapture.length = 0;
    await trigger!(site.id);

    expect(sendgridCapture.length).toBeGreaterThan(0);
    const payload = sendgridCapture[0]!.args as unknown[];
    const codeArg = payload[3] as string;
    expect(codeArg).not.toBe(site.accessToken);

    // Redeem the code via /auth/exchange — expect 30x redirect with Set-Cookie.
    const redeemRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/auth/exchange?code=${codeArg}`, {
      redirect: "manual",
    });
    expect([302, 303, 307, 308]).toContain(redeemRes.status);
    expect(redeemRes.headers.get("set-cookie") ?? "").toMatch(/flowblinq_site_token=/);
  }, 60_000);
});

describe("ES-090 IT17 — raw accessToken absent from outbound completion email", () => {
  it("SendGrid payload contains no occurrence of the raw site accessToken", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    const stage = await import("@/app/api/pipeline/stage/route?it17");
    type Trigger = (siteId: string) => Promise<void>;
    const trigger = (stage as unknown as { __test_triggerAssemble?: Trigger }).__test_triggerAssemble;
    expect(trigger).toBeDefined();

    sendgridCapture.length = 0;
    await trigger!(site.id);

    const serialized = JSON.stringify(sendgridCapture);
    expect(serialized).not.toContain(site.accessToken);
  }, 60_000);
});
