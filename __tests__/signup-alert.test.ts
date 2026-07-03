/**
 * Internal signup alert — fires when a customer triggers OTP on a fresh site.
 *
 * Regression cover for the gap that allowed real customers (e.g. ryan@codewithfabric.com,
 * priyankarawat@gmail.com on 2026-04-18) to start an audit with no notification reaching
 * the founder inbox. The previous notification only fired on the optional DNS TXT
 * verify-domain step, which most users skip.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-site-id") }));

vi.mock("@/lib/email", () => ({
  generateVerificationCode: vi.fn().mockReturnValue("123456"),
  hashCode: vi.fn().mockReturnValue("hashed-code"),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendLowCreditsEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalSignupAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 5, resetAt: Date.now() + 60000 }),
}));

vi.mock("@/lib/qstash", () => ({ enqueueStage: vi.fn().mockResolvedValue(undefined) }));

import { POST as postSites } from "@/app/api/sites/route";
import { db } from "@/lib/db";
import { sendInternalSignupAlert } from "@/lib/email";

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
  };
}

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
}

function makePostRequest(body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return new NextRequest(
    new Request("http://localhost/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    }),
  );
}

describe("sendInternalSignupAlert wiring on POST /api/sites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => makeSelectChain([]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
  });

  it("fires the signup alert when a brand-new single-audit triggers OTP", async () => {
    const res = await postSites(
      makePostRequest({ url: "https://acme.io", email: "newcustomer@example.com" }),
    );

    expect(res.status).toBe(201);
    expect(sendInternalSignupAlert).toHaveBeenCalledTimes(1);
    expect(sendInternalSignupAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        customerEmail: "newcustomer@example.com",
        domain: expect.stringContaining("acme.io"),
        siteId: expect.any(String),
        source: "single",
      }),
    );
  });

  it("does NOT re-fire the signup alert when an existing unverified site re-requests OTP", async () => {
    // Simulate an existing site so the route takes the "resend" branch instead of insert
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain([
        {
          id: "existing-id",
          domain: "acme.io",
          ownerEmail: "newcustomer@example.com",
          emailVerified: false,
          pipelineStatus: "pending",
          accessToken: null,
        },
      ]),
    );

    const res = await postSites(
      makePostRequest({ url: "https://acme.io", email: "newcustomer@example.com" }),
    );

    expect(res.status).toBe(200);
    expect(sendInternalSignupAlert).not.toHaveBeenCalled();
  });
});
