import { describe, test, expect, vi, beforeEach } from "vitest";

// ── Mock Resend before importing the module under test ────────────────────────
// sendEscalationAlert calls Resend — we must mock it to avoid real HTTP calls
// and missing RESEND_API_KEY in the test environment.

const mockEmailsSend = vi.fn().mockResolvedValue({ id: "email-123" });

vi.mock("resend", () => {
  class Resend {
    emails = { send: mockEmailsSend };
  }
  return { Resend };
});

import {
  detectFrustration,
  shouldEscalate,
  sendEscalationAlert,
  sendSlackAlert,
  createLinearIssue,
  escalateToOps,
} from "../escalation";

// ── detectFrustration ─────────────────────────────────────────────────────────

describe("detectFrustration", () => {
  test("returns false for a neutral satisfied message", () => {
    expect(detectFrustration("Thank you, that was very helpful!")).toBe(false);
  });

  test("returns false for a plain product question", () => {
    expect(detectFrustration("How do I add structured data to my site?")).toBe(false);
  });

  test("detects 'useless'", () => {
    expect(detectFrustration("This is completely useless")).toBe(true);
  });

  test("detects 'worthless'", () => {
    expect(detectFrustration("Your tool is worthless")).toBe(true);
  });

  test("detects 'garbage'", () => {
    expect(detectFrustration("This audit is garbage")).toBe(true);
  });

  test("detects 'trash'", () => {
    expect(detectFrustration("Absolute trash, never using this again")).toBe(true);
  });

  test("detects 'terrible'", () => {
    expect(detectFrustration("The score is terrible and unexplained")).toBe(true);
  });

  test("detects 'horrible'", () => {
    expect(detectFrustration("Horrible experience with this platform")).toBe(true);
  });

  test("detects 'awful'", () => {
    expect(detectFrustration("Awful support, nobody helped me")).toBe(true);
  });

  test("detects 'waste of time'", () => {
    expect(detectFrustration("This is a complete waste of time")).toBe(true);
  });

  test("detects 'doesn't work'", () => {
    expect(detectFrustration("The download button doesn't work")).toBe(true);
  });

  test("detects 'not working'", () => {
    expect(detectFrustration("The export is not working again")).toBe(true);
  });

  test("detects 'broken'", () => {
    expect(detectFrustration("The dashboard is broken")).toBe(true);
  });

  test("detects 'buggy'", () => {
    expect(detectFrustration("This feature is so buggy")).toBe(true);
  });

  test("detects 'hate'", () => {
    expect(detectFrustration("I hate this interface")).toBe(true);
  });

  test("detects 'frustrated'", () => {
    expect(detectFrustration("I'm really frustrated with the results")).toBe(true);
  });

  test("detects 'annoyed'", () => {
    expect(detectFrustration("I'm annoyed that this keeps happening")).toBe(true);
  });

  test("detects 'scam'", () => {
    expect(detectFrustration("This looks like a scam")).toBe(true);
  });

  test("detects 'rip off'", () => {
    expect(detectFrustration("What a rip off for 10 dollars")).toBe(true);
  });

  test("detects 'fraud'", () => {
    expect(detectFrustration("Is this fraud? I was charged twice")).toBe(true);
  });

  test("detects 'worst'", () => {
    expect(detectFrustration("Worst audit tool I've ever used")).toBe(true);
  });

  test("detects 'sucks'", () => {
    expect(detectFrustration("This product sucks honestly")).toBe(true);
  });

  test("detects 'stupid'", () => {
    expect(detectFrustration("This stupid crawl failed again")).toBe(true);
  });

  test("detects 'ridiculous'", () => {
    expect(detectFrustration("It's ridiculous that this doesn't work")).toBe(true);
  });

  test("detects refund demand", () => {
    expect(detectFrustration("I want a refund for my credits")).toBe(true);
  });

  test("detects 'money back'", () => {
    expect(detectFrustration("I want my money back")).toBe(true);
  });

  test("detects cancel request", () => {
    expect(detectFrustration("Please cancel my subscription")).toBe(true);
  });

  test("detects 'delete my account'", () => {
    expect(detectFrustration("I want to delete my account now")).toBe(true);
  });

  test("detects 'talk to a human'", () => {
    expect(detectFrustration("I need to talk to a human please")).toBe(true);
  });

  test("detects 'real person'", () => {
    expect(detectFrustration("I want to speak with a real person")).toBe(true);
  });

  test("detects 'manager'", () => {
    expect(detectFrustration("Let me speak to a manager")).toBe(true);
  });

  test("detects 'supervisor'", () => {
    expect(detectFrustration("I demand to speak with a supervisor")).toBe(true);
  });

  test("detects 'complaint'", () => {
    expect(detectFrustration("I want to file a complaint about this")).toBe(true);
  });

  test("detects 'escalate'", () => {
    expect(detectFrustration("Please escalate this to your team")).toBe(true);
  });

  test("detects 'still not working'", () => {
    expect(detectFrustration("It's still not working even after trying")).toBe(true);
  });

  test("detects 'already told you'", () => {
    expect(detectFrustration("I already told you this three times")).toBe(true);
  });

  test("detects 'nothing helps'", () => {
    expect(detectFrustration("Nothing helps, I've tried everything")).toBe(true);
  });

  test("detects 'not helpful'", () => {
    expect(detectFrustration("The chatbot is not helpful at all")).toBe(true);
  });

  test("detects 'unhelpful'", () => {
    expect(detectFrustration("This response is completely unhelpful")).toBe(true);
  });

  test("detects 'pointless'", () => {
    expect(detectFrustration("This audit is pointless for my business")).toBe(true);
  });

  test("detects wtf (light profanity)", () => {
    expect(detectFrustration("wtf is wrong with this tool")).toBe(true);
  });

  test("detects damn", () => {
    expect(detectFrustration("damn, the crawl failed again")).toBe(true);
  });

  test("detects crap", () => {
    expect(detectFrustration("This is total crap")).toBe(true);
  });

  test("is case-insensitive — detects USELESS in uppercase", () => {
    expect(detectFrustration("This is USELESS to me")).toBe(true);
  });

  test("is case-insensitive — detects Refund with capital R", () => {
    expect(detectFrustration("I need a Refund")).toBe(true);
  });

  test("returns false for message that contains a word that partially matches but not as a whole word", () => {
    // "blueprint" contains "blue" but not "bs", "crap", "damn", etc. — no false positive
    expect(detectFrustration("I'm building a blueprint for my website")).toBe(false);
  });
});

// ── shouldEscalate ────────────────────────────────────────────────────────────

describe("shouldEscalate", () => {
  test("returns false for empty message list", () => {
    expect(shouldEscalate([])).toBe(false);
  });

  test("returns false for single neutral user message", () => {
    expect(shouldEscalate([
      { role: "user", text: "How do I improve my GEO score?" },
    ])).toBe(false);
  });

  test("returns false for single frustrated user message (below threshold of 2)", () => {
    expect(shouldEscalate([
      { role: "user", text: "This is completely useless" },
    ])).toBe(false);
  });

  test("returns true when two user messages are frustrated", () => {
    expect(shouldEscalate([
      { role: "user", text: "This is useless" },
      { role: "assistant", text: "I understand, let me help..." },
      { role: "user", text: "I want a refund, nothing works" },
    ])).toBe(true);
  });

  test("returns true for exactly 2 frustrated user messages (at threshold)", () => {
    expect(shouldEscalate([
      { role: "user", text: "This is garbage" },
      { role: "user", text: "I want to delete my account" },
    ])).toBe(true);
  });

  test("returns false when only assistant messages are frustrated (not user)", () => {
    // Only user messages count
    expect(shouldEscalate([
      { role: "assistant", text: "I hate to say this is broken" },
      { role: "assistant", text: "This tool is useless for you" },
      { role: "user", text: "How do I download my report?" },
    ])).toBe(false);
  });

  test("returns true for 3+ frustrated user messages", () => {
    expect(shouldEscalate([
      { role: "user", text: "This is useless" },
      { role: "assistant", text: "Sorry to hear that..." },
      { role: "user", text: "I want my money back" },
      { role: "assistant", text: "I can help..." },
      { role: "user", text: "Talk to a real person please" },
    ])).toBe(true);
  });

  test("returns false when frustrated messages are only from assistant role", () => {
    expect(shouldEscalate([
      { role: "assistant", text: "This is terrible for you" },
      { role: "assistant", text: "I hate this situation too" },
    ])).toBe(false);
  });

  test("counts only user messages toward frustration threshold", () => {
    // 1 frustrated user + 1 frustrated assistant = still false (threshold is 2 user messages)
    expect(shouldEscalate([
      { role: "user", text: "This is garbage" },
      { role: "assistant", text: "Awful situation, sorry" },
    ])).toBe(false);
  });

  test("each frustrated user message increments counter independently", () => {
    // 4 frustrated user messages well above threshold
    const messages = [
      { role: "user", text: "useless tool" },
      { role: "user", text: "I want a refund" },
      { role: "user", text: "talk to human" },
      { role: "user", text: "cancel my account" },
    ];
    expect(shouldEscalate(messages)).toBe(true);
  });

  test("neutral conversation mixed with frustrated does not trigger if only 1 frustrated", () => {
    expect(shouldEscalate([
      { role: "user", text: "How do I check my score?" },
      { role: "assistant", text: "Navigate to the results page." },
      { role: "user", text: "This is completely useless" },
      { role: "assistant", text: "I'm sorry about that..." },
      { role: "user", text: "Okay thanks for trying" },
    ])).toBe(false);
  });
});

// ── sendEscalationAlert ───────────────────────────────────────────────────────

describe("sendEscalationAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "re_test_key";
  });

  const baseOpts = {
    domain: "example.com",
    siteId: "site-abc123",
    userEmail: "user@example.com",
    conversationHistory: [
      { role: "user", text: "This is useless" },
      { role: "assistant", text: "I'm sorry to hear that." },
      { role: "user", text: "I want a refund" },
    ],
    triggerMessage: "I want a refund",
  };

  test("calls resend emails.send with correct recipient", async () => {
    await sendEscalationAlert(baseOpts);
    expect(mockEmailsSend).toHaveBeenCalledOnce();
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.to).toBe("hello@flowblinq.ai");
  });

  test("email subject includes the domain", async () => {
    await sendEscalationAlert(baseOpts);
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.subject).toContain("example.com");
  });

  test("email HTML body contains domain", async () => {
    await sendEscalationAlert(baseOpts);
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.html).toContain("example.com");
  });

  test("email HTML body contains siteId", async () => {
    await sendEscalationAlert(baseOpts);
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.html).toContain("site-abc123");
  });

  test("email HTML body contains trigger message", async () => {
    await sendEscalationAlert(baseOpts);
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.html).toContain("I want a refund");
  });

  test("email HTML body contains user email when provided", async () => {
    await sendEscalationAlert(baseOpts);
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.html).toContain("user@example.com");
  });

  test("email HTML body does not include email row when userEmail is null", async () => {
    await sendEscalationAlert({ ...baseOpts, userEmail: null });
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.html).not.toContain("User Email:");
  });

  test("email HTML body includes conversation history", async () => {
    await sendEscalationAlert(baseOpts);
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.html).toContain("This is useless");
    expect(call.html).toContain("I want a refund");
  });

  test("does not throw when resend fails (fire-and-forget safety)", async () => {
    mockEmailsSend.mockRejectedValueOnce(new Error("Resend API error"));
    // Should not throw — errors are caught internally
    await expect(sendEscalationAlert(baseOpts)).resolves.toBeUndefined();
  });

  test("HTML-escapes special chars in domain to prevent injection", async () => {
    await sendEscalationAlert({
      ...baseOpts,
      domain: "<script>alert(1)</script>",
      triggerMessage: "test",
    });
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.html).not.toContain("<script>");
    expect(call.html).toContain("&lt;script&gt;");
  });

  test("HTML-escapes special chars in trigger message", async () => {
    await sendEscalationAlert({
      ...baseOpts,
      triggerMessage: 'I said "hello" & <goodbye>',
    });
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.html).not.toContain("<goodbye>");
    expect(call.html).toContain("&lt;goodbye&gt;");
    expect(call.html).toContain("&amp;");
    expect(call.html).toContain("&quot;");
  });

  test("from address uses FlowBlinq sender identity", async () => {
    await sendEscalationAlert(baseOpts);
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.from).toContain("flowblinq");
  });

  test("email includes a link to the site", async () => {
    await sendEscalationAlert(baseOpts);
    const call = mockEmailsSend.mock.calls[0][0];
    expect(call.html).toContain("site-abc123");
    expect(call.html).toContain("href=");
  });
});

// ── sendSlackAlert ────────────────────────────────────────────────────────────

describe("sendSlackAlert", () => {
  const baseOpts = {
    domain: "example.com",
    siteId: "site-abc123",
    userEmail: "user@example.com",
    conversationHistory: [
      { role: "user", text: "This is useless" },
      { role: "assistant", text: "I'm sorry to hear that." },
      { role: "user", text: "I want a refund" },
    ],
    triggerMessage: "I want a refund",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.SLACK_CLEO_WEBHOOK_URL;
  });

  test("returns no-op when SLACK_CLEO_WEBHOOK_URL is unset", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));
    await sendSlackAlert(baseOpts);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("posts to webhook URL with payload containing domain/siteId/trigger", async () => {
    process.env.SLACK_CLEO_WEBHOOK_URL = "https://hooks.slack.test/abc";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));
    await sendSlackAlert(baseOpts);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.test/abc");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("example.com");
    expect(serialized).toContain("site-abc123");
    expect(serialized).toContain("I want a refund");
    expect(serialized).toContain("This is useless");
  });

  test("escapes Slack mrkdwn special chars in domain", async () => {
    process.env.SLACK_CLEO_WEBHOOK_URL = "https://hooks.slack.test/abc";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));
    await sendSlackAlert({ ...baseOpts, domain: "<bad>&co" });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("<bad>");
    expect(serialized).toContain("&lt;bad&gt;");
    expect(serialized).toContain("&amp;co");
  });

  test("does not throw on fetch failure", async () => {
    process.env.SLACK_CLEO_WEBHOOK_URL = "https://hooks.slack.test/abc";
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("network"));
    await expect(sendSlackAlert(baseOpts)).resolves.toBeUndefined();
  });

  test("truncates transcript to last 12 messages (not unbounded)", async () => {
    process.env.SLACK_CLEO_WEBHOOK_URL = "https://hooks.slack.test/abc";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));
    const longHistory = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `MSG_${i}`,
    }));
    await sendSlackAlert({ ...baseOpts, conversationHistory: longHistory });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const serialized = JSON.stringify(body);
    // First 8 messages must be dropped (history slice keeps last 12)
    expect(serialized).not.toContain("MSG_0");
    expect(serialized).not.toContain("MSG_7");
    // Last 12 must be present
    expect(serialized).toContain("MSG_8");
    expect(serialized).toContain("MSG_19");
  });

  test("strips backticks in transcript to prevent mrkdwn code-block escape", async () => {
    process.env.SLACK_CLEO_WEBHOOK_URL = "https://hooks.slack.test/abc";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));
    await sendSlackAlert({
      ...baseOpts,
      conversationHistory: [
        { role: "user", text: "look at ```fake-code-block``` here" },
      ],
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const serialized = JSON.stringify(body);
    // The user's backticks must NOT appear inside the recent-conversation block
    // (otherwise they break out of the wrapping code block)
    expect(serialized).not.toContain("```fake-code-block```");
  });
});

// ── createLinearIssue ────────────────────────────────────────────────────────

describe("createLinearIssue", () => {
  const baseOpts = {
    domain: "example.com",
    siteId: "site-abc123",
    userEmail: null,
    conversationHistory: [
      { role: "user", text: "useless" },
      { role: "assistant", text: "sorry" },
    ],
    triggerMessage: "useless",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_TEAM_ID;
  });

  test("returns no-op when LINEAR_API_KEY unset", async () => {
    process.env.LINEAR_TEAM_ID = "team-1";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));
    await createLinearIssue(baseOpts);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns no-op when LINEAR_TEAM_ID unset", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));
    await createLinearIssue(baseOpts);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("posts GraphQL mutation with team id and Authorization header", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.LINEAR_TEAM_ID = "team-xyz";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}"));
    await createLinearIssue(baseOpts);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init.headers as Record<string, string>).Authorization).toBe("lin_api_test");
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("issueCreate");
    expect(body.variables.input.teamId).toBe("team-xyz");
    expect(body.variables.input.title).toContain("example.com");
    expect(body.variables.input.description).toContain("site-abc123");
  });

  test("does not throw on fetch failure", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.LINEAR_TEAM_ID = "team-xyz";
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("network"));
    await expect(createLinearIssue(baseOpts)).resolves.toBeUndefined();
  });
});

// ── escalateToOps ────────────────────────────────────────────────────────────

describe("escalateToOps", () => {
  const baseOpts = {
    domain: "example.com",
    siteId: "site-abc123",
    userEmail: "user@example.com",
    conversationHistory: [
      { role: "user", text: "useless" },
      { role: "user", text: "refund" },
    ],
    triggerMessage: "refund",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.SLACK_CLEO_WEBHOOK_URL = "https://hooks.slack.test/abc";
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.LINEAR_TEAM_ID = "team-xyz";
    mockEmailsSend.mockResolvedValue({ id: "email-123" });
  });

  test("invokes email + Slack + Linear in parallel", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));
    await escalateToOps(baseOpts);
    expect(mockEmailsSend).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://hooks.slack.test/abc");
    expect(urls).toContain("https://api.linear.app/graphql");
  });

  test("one channel failing does not block the others", async () => {
    // Slack fails, but Resend + Linear should still complete.
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (typeof url === "string" && url.includes("slack")) {
        throw new Error("slack down");
      }
      return new Response("ok");
    });
    await expect(escalateToOps(baseOpts)).resolves.toBeUndefined();
    expect(mockEmailsSend).toHaveBeenCalledOnce();
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://hooks.slack.test/abc");
    expect(urls).toContain("https://api.linear.app/graphql");
  });

  test("when all ops channels are unset, only email runs and no fetches fire", async () => {
    delete process.env.SLACK_CLEO_WEBHOOK_URL;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_TEAM_ID;
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));
    await escalateToOps(baseOpts);
    expect(mockEmailsSend).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
