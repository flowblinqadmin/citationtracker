import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks (vi.hoisted ensures the fns exist when vi.mock factories run) ─────

const { mockGetUser, mockAppendFile } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockAppendFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_c: unknown, _v: unknown) => ({ _eq: [_c, _v] })),
  asc: vi.fn((_c: unknown) => ({ _asc: _c })),
}));

vi.mock("fs", () => ({
  promises: { appendFile: mockAppendFile },
}));

import { POST } from "./route";
import { db } from "@/lib/db";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown, contentLength?: number): NextRequest {
  const json = JSON.stringify(body);
  return new NextRequest(
    new Request("http://localhost/api/admin/cleo/golden", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(contentLength ?? Buffer.byteLength(json)),
      },
      body: json,
    }),
  );
}

function mockSelectResolving(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>);
  return chain;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/admin/cleo/golden", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VERCEL_ENV;
    mockGetUser.mockResolvedValue({ data: { user: { email: "ar@flowblinq.com" } } });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 503 in production (FS is read-only on Vercel)", async () => {
    process.env.VERCEL_ENV = "production";
    const res = await POST(makeRequest({ conversationId: "c1", expectedAnswer: "x" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("DISABLED_IN_PROD");
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it("returns 404 when caller is unauthenticated (no leak of route existence)", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(makeRequest({ conversationId: "c1", expectedAnswer: "x" }));
    expect(res.status).toBe(404);
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it("returns 404 when caller is authenticated but not an admin email", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { email: "stranger@example.com" } } });
    const res = await POST(makeRequest({ conversationId: "c1", expectedAnswer: "x" }));
    expect(res.status).toBe(404);
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it("rejects payloads larger than 64 KB (DoS guard)", async () => {
    const res = await POST(makeRequest({ conversationId: "c1", expectedAnswer: "x" }, 70_000));
    expect(res.status).toBe(413);
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it("returns 400 when conversationId is missing", async () => {
    const res = await POST(makeRequest({ expectedAnswer: "x" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when expectedAnswer is missing", async () => {
    const res = await POST(makeRequest({ conversationId: "c1" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when conversationId has no matching DB rows", async () => {
    mockSelectResolving([]);
    const res = await POST(makeRequest({ conversationId: "c1", expectedAnswer: "x" }));
    expect(res.status).toBe(404);
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it("appends a JSONL line when admin posts a valid conversationId", async () => {
    // First select: chatbotLogs rows
    const chain1 = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([
        {
          id: "log-1",
          conversationId: "c1",
          siteId: null,
          query: "What is my schema score?",
          response: "It's 67.",
          viewContext: { page: "results" },
          createdAt: new Date(),
        },
      ]),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain1 as unknown as ReturnType<typeof db.select>);

    const res = await POST(
      makeRequest({
        conversationId: "c1",
        expectedAnswer: "Schema score derives from JSON-LD coverage.",
        mustContain: ["JSON-LD"],
        mustNotContain: ["I don't know"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^curated-c1-/);

    expect(mockAppendFile).toHaveBeenCalledOnce();
    const [path, line] = mockAppendFile.mock.calls[0];
    expect(String(path)).toMatch(/eval\/failures\/curated\.jsonl$/);
    const parsed = JSON.parse(String(line).trim());
    expect(parsed.query).toBe("What is my schema score?");
    expect(parsed.expectedAnswer).toBe("Schema score derives from JSON-LD coverage.");
    expect(parsed.mustContain).toEqual(["JSON-LD"]);
    expect(parsed.mustNotContain).toEqual(["I don't know"]);
    expect(parsed.sourceLogId).toBe("c1");
    expect(parsed.category).toBe("curated-from-prod");
  });

  it("escapes embedded newlines in expectedAnswer (JSONL safety)", async () => {
    const chain1 = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([
        { id: "l", conversationId: "c1", siteId: null, query: "q", response: "r", viewContext: null, createdAt: new Date() },
      ]),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain1 as unknown as ReturnType<typeof db.select>);

    await POST(
      makeRequest({
        conversationId: "c1",
        expectedAnswer: "line one\nline two\nline three",
      }),
    );
    const [, line] = mockAppendFile.mock.calls[0];
    // The raw appended line must be a single JSONL row — embedded \n must be escaped.
    const raw = String(line);
    const newlineCount = (raw.match(/\n/g) ?? []).length;
    expect(newlineCount).toBe(1); // only the trailing line terminator
  });
});
