/**
 * Task B2 — Tests for rewritten sendAuditPurchaseDeliveryEmail:
 *   1. Payload contains `attachments` with the PDF.
 *   2. Payload does NOT contain a "Download Your Report" URL/text.
 *   3. Install CTA href matches the magicLink when provided.
 *   4. Falls back to dashboard URL when no magicLink.
 *   5. CTA copy references pillar count when topPillars provided.
 *   6. Falls back to "Open your dashboard" when topPillars is empty.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockResendSend } = vi.hoisted(() => ({
  mockResendSend: vi.fn().mockResolvedValue({ data: { id: "test-email-id" }, error: null }),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockResendSend };
  },
}));

vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: vi.fn(),
    send: vi.fn().mockResolvedValue([{ statusCode: 202 }, {}]),
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { sendAuditPurchaseDeliveryEmail } from "@/lib/email";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Task B2 — sendAuditPurchaseDeliveryEmail (PDF attach + install CTA)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
  });

  const fakePdf = {
    buffer: Buffer.from("fake-pdf-content"),
    filename: "audit-example.com.pdf",
  };

  it("includes attachments array with the PDF buffer and filename", async () => {
    await sendAuditPurchaseDeliveryEmail(
      "user@example.com",
      "example.com",
      fakePdf,
      { overallScore: 55 },
    );

    expect(mockResendSend).toHaveBeenCalledOnce();
    const callArgs = mockResendSend.mock.calls[0][0];
    expect(callArgs.attachments).toBeDefined();
    expect(callArgs.attachments).toHaveLength(1);
    expect(callArgs.attachments[0].filename).toBe("audit-example.com.pdf");
    expect(callArgs.attachments[0].content).toEqual(fakePdf.buffer);
  });

  it("does NOT contain 'Download Your Report' text in the HTML", async () => {
    await sendAuditPurchaseDeliveryEmail(
      "user@example.com",
      "example.com",
      fakePdf,
      { overallScore: 55 },
    );

    const callArgs = mockResendSend.mock.calls[0][0];
    expect(callArgs.html).not.toContain("Download Your Report");
  });

  it("install CTA href matches magicLink when provided", async () => {
    const magicLink = "https://geo.flowblinq.com/auth/v1/verify?token=abc123&type=magiclink";

    await sendAuditPurchaseDeliveryEmail(
      "user@example.com",
      "example.com",
      fakePdf,
      { overallScore: 60, magicLink },
    );

    const callArgs = mockResendSend.mock.calls[0][0];
    // Both the primary CTA and secondary link should reference the magic link
    expect(callArgs.html).toContain(magicLink);
  });

  it("falls back to dashboard URL when no magicLink", async () => {
    await sendAuditPurchaseDeliveryEmail(
      "user@example.com",
      "example.com",
      fakePdf,
      { overallScore: 40 },
    );

    const callArgs = mockResendSend.mock.calls[0][0];
    expect(callArgs.html).toContain("https://geo.flowblinq.com/dashboard");
    // Must NOT include a magic link placeholder
    expect(callArgs.html).not.toContain("magiclink");
  });

  it("CTA copy references pillar count when topPillars provided", async () => {
    await sendAuditPurchaseDeliveryEmail(
      "user@example.com",
      "example.com",
      fakePdf,
      { overallScore: 30, topPillars: ["structured_data", "metadata_freshness", "semantic_html"] },
    );

    const callArgs = mockResendSend.mock.calls[0][0];
    expect(callArgs.html).toContain("fix 3 issues automatically");
  });

  it("CTA copy falls back to 'Open your dashboard' when topPillars is empty", async () => {
    await sendAuditPurchaseDeliveryEmail(
      "user@example.com",
      "example.com",
      fakePdf,
      { overallScore: 70, topPillars: [] },
    );

    const callArgs = mockResendSend.mock.calls[0][0];
    expect(callArgs.html).toContain("Open your dashboard");
  });

  it("includes the 'What FlowBlinq fixes for you' feature callout with three rows", async () => {
    await sendAuditPurchaseDeliveryEmail(
      "user@example.com",
      "example.com",
      fakePdf,
      { overallScore: 50 },
    );

    const callArgs = mockResendSend.mock.calls[0][0];
    expect(callArgs.html).toContain("llms.txt");
    expect(callArgs.html).toContain("schema.org blocks");
    expect(callArgs.html).toContain("business.json");
  });
});
