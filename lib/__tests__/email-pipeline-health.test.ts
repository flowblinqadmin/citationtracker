import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { sendInternalPipelineHealthAlert } from "@/lib/email";

describe("sendInternalPipelineHealthAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
  });

  it("sends to hello@flowblinq.com with severity + category in subject", async () => {
    await sendInternalPipelineHealthAlert({
      severity: "critical",
      category: "provider",
      summary: "perplexity API failing (401)",
      details: [["Provider", "perplexity"], ["Status", "401"]],
    });

    expect(mockResendSend).toHaveBeenCalledOnce();
    const call = mockResendSend.mock.calls[0][0];
    expect(call.to).toContain("hello@flowblinq.com");
    expect(call.subject).toContain("provider");
    expect(call.subject).toContain("perplexity API failing");
    expect(call.subject).toMatch(/🚨|CRITICAL|critical/);
  });

  it("uses warn icon for warn severity", async () => {
    await sendInternalPipelineHealthAlert({
      severity: "warn",
      category: "audit-stuck",
      summary: "example.com — crawl done, citation phase never ran",
      details: [["Site ID", "abc"], ["Domain", "example.com"]],
    });
    const call = mockResendSend.mock.calls[0][0];
    expect(call.subject).toContain("⚠️");
    expect(call.html).toContain("WARN");
  });

  it("renders details as key/value rows in HTML", async () => {
    await sendInternalPipelineHealthAlert({
      severity: "critical",
      category: "all-quiet",
      summary: "No citation scores in 18 days",
      details: [
        ["Threshold", "6h"],
        ["Last score at", "2026-05-03T14:47:38Z"],
        ["Last scored domain", "flowblinq.com"],
      ],
    });
    const html = mockResendSend.mock.calls[0][0].html;
    expect(html).toContain("Threshold");
    expect(html).toContain("6h");
    expect(html).toContain("Last score at");
    expect(html).toContain("2026-05-03T14:47:38Z");
    expect(html).toContain("flowblinq.com");
  });

  it("escapes HTML in details to prevent injection", async () => {
    await sendInternalPipelineHealthAlert({
      severity: "warn",
      category: "provider",
      summary: "test",
      details: [["Error", "<script>alert(1)</script>"]],
    });
    const html = mockResendSend.mock.calls[0][0].html;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("does not throw if Resend rejects", async () => {
    mockResendSend.mockRejectedValueOnce(new Error("network failure"));
    await expect(
      sendInternalPipelineHealthAlert({
        severity: "critical",
        category: "provider",
        summary: "test",
        details: [],
      }),
    ).resolves.toBeUndefined();
  });
});
