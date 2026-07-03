import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  sendInternalPipelineHealthAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((..._a: unknown[]) => ({ _op: "eq" })),
  and: vi.fn((..._a: unknown[]) => ({ _op: "and" })),
  gte: vi.fn((..._a: unknown[]) => ({ _op: "gte" })),
  lt: vi.fn((..._a: unknown[]) => ({ _op: "lt" })),
  sql: Object.assign(
    vi.fn(((..._a: unknown[]) => ({ _op: "sql" })) as unknown as (...args: unknown[]) => unknown),
    { raw: vi.fn((..._a: unknown[]) => ({ _op: "sql-raw" })) },
  ),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { runPipelineHealthChecks } from "@/lib/services/pipeline-health";
import { db } from "@/lib/db";
import { sendInternalPipelineHealthAlert } from "@/lib/email";

// ── Helpers ─────────────────────────────────────────────────────────────────

interface MockFetchCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(handler: (call: MockFetchCall) => { ok: boolean; status: number; body?: string }) {
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const res = handler({ url: typeof url === "string" ? url : url.toString(), init });
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.body ?? "",
      json: async () => ({}),
    } as unknown as Response;
  }) as typeof fetch;
}

// shouldAlert uses db.insert(...).onConflictDoUpdate(...).returning(...). To
// control alert dedupe in tests, queue per-key responses: each call to
// db.insert (in order) returns a chain whose returning() resolves to the
// next queued value.
function queueAlertGates(returns: Array<Array<{ key: string }>>) {
  const queue = [...returns];
  vi.mocked(db.insert).mockImplementation(() => {
    const result = queue.shift() ?? [];
    return {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue(result),
    } as unknown as ReturnType<typeof db.insert>;
  });
}

// db.select() chain returning a given rows array on .limit() / .where()
function mockSelectOnce(rows: unknown[]) {
  const tail = vi.fn().mockResolvedValue(rows);
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: tail,
  };
  // Both .where().limit() and .orderBy().limit() patterns end at limit.
  // For the .from().orderBy() flow used by all-quiet "latest" lookup we
  // need .where to short-circuit; make limit resolve directly.
  vi.mocked(db.select).mockReturnValueOnce(chain as unknown as ReturnType<typeof db.select>);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("runPipelineHealthChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "ant-test";
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g-test";
  });

  it("healthy state — no alerts fired", async () => {
    mockFetch(() => ({ ok: true, status: 200 }));
    // No stuck sites
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [] } as never);
    // All-quiet: recent score exists → not quiet
    mockSelectOnce([{ createdAt: new Date() }]);

    const result = await runPipelineHealthChecks();

    expect(result.providersFailed).toEqual([]);
    expect(result.stuckSites).toEqual([]);
    expect(result.allQuiet).toBe(false);
    expect(result.alertsSent).toBe(0);
    expect(sendInternalPipelineHealthAlert).not.toHaveBeenCalled();
  });

  it("fires critical alert when Perplexity returns 401", async () => {
    mockFetch(({ url }) => {
      if (url.includes("perplexity")) return { ok: false, status: 401, body: "Invalid API key" };
      return { ok: true, status: 200 };
    });
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [] } as never);
    mockSelectOnce([{ createdAt: new Date() }]);
    queueAlertGates([[{ key: "provider:perplexity" }]]); // alert fires

    const result = await runPipelineHealthChecks();

    expect(result.providersFailed).toEqual(["perplexity"]);
    expect(result.alertsSent).toBe(1);
    expect(sendInternalPipelineHealthAlert).toHaveBeenCalledOnce();
    const call = vi.mocked(sendInternalPipelineHealthAlert).mock.calls[0][0];
    expect(call.severity).toBe("critical");
    expect(call.category).toBe("provider");
    expect(call.summary).toContain("perplexity");
    expect(call.summary).toContain("401");
  });

  it("suppresses provider alert when shouldAlert dedupe returns empty", async () => {
    mockFetch(({ url }) => {
      if (url.includes("perplexity")) return { ok: false, status: 401 };
      return { ok: true, status: 200 };
    });
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [] } as never);
    mockSelectOnce([{ createdAt: new Date() }]);
    queueAlertGates([[]]); // dedupe says "still in cooldown"

    const result = await runPipelineHealthChecks();

    expect(result.providersFailed).toEqual(["perplexity"]);
    expect(result.alertsSent).toBe(0);
    expect(result.alertsSuppressed).toBe(1);
    expect(sendInternalPipelineHealthAlert).not.toHaveBeenCalled();
  });

  it("fires one warn alert per stuck site", async () => {
    mockFetch(() => ({ ok: true, status: 200 }));
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [
        { site_id: "site-A", domain: "headlesshippies.com", created_at: new Date(Date.now() - 60 * 60 * 1000) },
        { site_id: "site-B", domain: "quanutrition.com", created_at: new Date(Date.now() - 90 * 60 * 1000) },
      ],
    } as never);
    mockSelectOnce([{ createdAt: new Date() }]);
    queueAlertGates([
      [{ key: "audit-stuck:site-A" }],
      [{ key: "audit-stuck:site-B" }],
    ]);

    const result = await runPipelineHealthChecks();

    expect(result.stuckSites).toHaveLength(2);
    expect(result.alertsSent).toBe(2);
    expect(sendInternalPipelineHealthAlert).toHaveBeenCalledTimes(2);
    const summaries = vi.mocked(sendInternalPipelineHealthAlert).mock.calls.map((c) => c[0].summary);
    expect(summaries.some((s) => s.includes("headlesshippies.com"))).toBe(true);
    expect(summaries.some((s) => s.includes("quanutrition.com"))).toBe(true);
    expect(vi.mocked(sendInternalPipelineHealthAlert).mock.calls.every((c) => c[0].category === "audit-stuck")).toBe(true);
  });

  it("fires all-quiet critical when no recent scores exist", async () => {
    mockFetch(() => ({ ok: true, status: 200 }));
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [] } as never);
    // First select() = recent-window probe (empty), second = latest-ever lookup
    mockSelectOnce([]);
    mockSelectOnce([{ createdAt: new Date("2026-05-03T14:47:38Z"), domain: "flowblinq.com" }]);
    queueAlertGates([[{ key: "all-quiet" }]]);

    const result = await runPipelineHealthChecks();

    expect(result.allQuiet).toBe(true);
    expect(result.alertsSent).toBe(1);
    const call = vi.mocked(sendInternalPipelineHealthAlert).mock.calls[0][0];
    expect(call.category).toBe("all-quiet");
    expect(call.severity).toBe("critical");
    expect(call.summary).toContain("flowblinq.com");
  });

  it("missing PERPLEXITY_API_KEY env reports as failure (would have caught the empty Vercel var)", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    mockFetch(() => ({ ok: true, status: 200 }));
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [] } as never);
    mockSelectOnce([{ createdAt: new Date() }]);
    queueAlertGates([[{ key: "provider:perplexity" }]]);

    const result = await runPipelineHealthChecks();
    expect(result.providersFailed).toContain("perplexity");
    expect(result.alertsSent).toBe(1);
  });
});
