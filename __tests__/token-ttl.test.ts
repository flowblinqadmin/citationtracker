import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { TOKEN_TTL_MS } from "@/lib/constants/token-ttl";

// ─── Hoisted mocks (shared with chatbot route) ───────────────────────────────

const {
  mockDbSelect,
  mockDbInsert,
  mockCheckRateLimit,
  mockRetrieveKnowledge,
  mockShouldEscalate,
  mockSendEscalationAlert,
  mockStreamText,
  mockCreateUIMessageStream,
  mockCreateUIMessageStreamResponse,
  mockConvertToModelMessages,
  mockCreateOpenAI,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockRetrieveKnowledge: vi.fn(),
  mockShouldEscalate: vi.fn(),
  mockSendEscalationAlert: vi.fn(),
  mockStreamText: vi.fn(),
  mockCreateUIMessageStream: vi.fn(),
  mockCreateUIMessageStreamResponse: vi.fn(),
  mockConvertToModelMessages: vi.fn(),
  mockCreateOpenAI: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { select: mockDbSelect, insert: mockDbInsert },
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock("@/lib/chatbot/retrieve", () => ({ retrieveKnowledge: mockRetrieveKnowledge }));
vi.mock("@/lib/chatbot/escalation", () => ({
  shouldEscalate: mockShouldEscalate,
  sendEscalationAlert: mockSendEscalationAlert,
}));
vi.mock("ai", () => ({
  streamText: mockStreamText,
  createUIMessageStream: mockCreateUIMessageStream,
  createUIMessageStreamResponse: mockCreateUIMessageStreamResponse,
  convertToModelMessages: mockConvertToModelMessages,
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mockCreateOpenAI }));
vi.mock("nanoid", () => ({ nanoid: vi.fn(() => "test-id") }));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_c: unknown, _v: unknown) => ({ _eq: [_c, _v] })),
  desc: vi.fn((c: unknown) => ({ _desc: c })),
}));

// Import handlers AFTER mocks are registered
import { POST as chatbotPOST, GET as chatbotGET } from "@/app/api/chatbot/route";
import { GET as siteGET } from "@/app/api/sites/[id]/route";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SITE_ID = "site-ttl";
const TOKEN = "tok-ttl";
const ISSUED_AT = new Date("2026-01-01T00:00:00.000Z");
const EXPIRES_AT = new Date(ISSUED_AT.getTime() + TOKEN_TTL_MS);

function siteRow() {
  return {
    siteId: SITE_ID,
    id: SITE_ID,
    domain: "example.com",
    accessToken: TOKEN,
    tokenExpiresAt: EXPIRES_AT,
    teamId: "team-1",
    pillars: [],
    rankedRecommendations: [],
    overallScore: 70,
    executiveSummary: "ok",
    platformDetected: "WordPress",
  };
}

function mockSelectOnce(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  mockDbSelect.mockReturnValueOnce(chain);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: Date.now() + 60_000 });
  mockShouldEscalate.mockReturnValue(false);
  mockConvertToModelMessages.mockResolvedValue([]);
  mockCreateOpenAI.mockReturnValue(vi.fn().mockReturnValue({ modelId: "gpt-4o-mini" }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 1. Constant assertion ───────────────────────────────────────────────────

describe("TOKEN_TTL_MS", () => {
  test("is exactly 7 days — guards against accidental TTL drift", () => {
    expect(TOKEN_TTL_MS).toBe(7 * 86_400_000);
  });
});

// ─── 2. Chatbot POST: simulated time-travel past expiry ──────────────────────

describe("Token expiry — /api/chatbot POST", () => {
  test("returns 401 TOKEN_EXPIRED exactly 1ms after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(EXPIRES_AT.getTime() + 1));

    mockSelectOnce([siteRow()]);

    const req = new NextRequest(`http://localhost/api/chatbot?siteId=${SITE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await chatbotPOST(req);
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.code).toBe("TOKEN_EXPIRED");
  });

  test("returns 401 TOKEN_EXPIRED 8 days after issue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ISSUED_AT.getTime() + 8 * 86_400_000));

    mockSelectOnce([siteRow()]);

    const req = new NextRequest(`http://localhost/api/chatbot?siteId=${SITE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await chatbotPOST(req);
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.code).toBe("TOKEN_EXPIRED");
  });
});

// ─── 3. Chatbot GET: same time-travel guarantee ──────────────────────────────

describe("Token expiry — /api/chatbot GET", () => {
  test("returns 401 TOKEN_EXPIRED past TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(EXPIRES_AT.getTime() + 60_000));

    mockSelectOnce([siteRow()]);

    const req = new NextRequest(`http://localhost/api/chatbot?siteId=${SITE_ID}`, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const res = await chatbotGET(req);
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.code).toBe("TOKEN_EXPIRED");
  });
});

// ─── 4. Site GET: existing route — confirm parity ────────────────────────────

describe("Token expiry — /api/sites/[id] GET", () => {
  test("returns 401 TOKEN_EXPIRED past TTL (parity with chatbot)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(EXPIRES_AT.getTime() + 1));

    mockSelectOnce([siteRow()]);

    const req = new NextRequest(`http://localhost/api/sites/${SITE_ID}?token=${TOKEN}`);
    const ctx = { params: Promise.resolve({ id: SITE_ID }) };
    const res = await siteGET(req, ctx);
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.code).toBe("TOKEN_EXPIRED");
  });
});
