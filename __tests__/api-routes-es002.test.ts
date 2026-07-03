/**
 * API Routes — ES-002 Config Import & Crawl Depth Tests
 *
 * Tests that route handlers import constants from @/lib/config
 * instead of using hardcoded values. Uses non-default config values
 * in mocks to ensure handlers actually reference the config module.
 *
 * Test cases 14-19 from ES-002 spec:
 *   14. Anonymous free crawl passes FREE_MAX_PAGES to startCrawl
 *   15. Paid crawl passes PAID_MAX_PAGES to startCrawl
 *   16. Recrawl cron passes PAID_MAX_PAGES to startCrawl
 *   17. Checkout uses CREDITS_PRICE_CENTS from config
 *   18. Webhook uses CREDITS_PER_PACK from config
 *   19. Auth callback uses SIGNUP_BONUS_CREDITS from config
 *
 * These tests are written BEFORE implementation (test-first).
 * They will FAIL until the config imports are wired into each handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks (available inside vi.mock factories) ─────────────────────

const {
  mockStartCrawl,
  mockEnqueueStage,
  mockCheckoutCreate,
  mockConstructEvent,
  mockExchangeCode,
  mockResolveCrawlBudget,
} = vi.hoisted(() => ({
  mockStartCrawl: vi.fn().mockResolvedValue(undefined),
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
  mockCheckoutCreate: vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/test" }),
  mockConstructEvent: vi.fn(),
  mockExchangeCode: vi.fn(),
  mockResolveCrawlBudget: vi.fn(),
}));

// ─── Mocks — hoisted before all imports ──────────────────────────────────────

// Config with NON-DEFAULT values — ensures handlers actually use config imports
vi.mock("@/lib/config", () => ({
  FREE_MAX_PAGES: 15,           // default 20
  PAID_MAX_PAGES: 75,           // default 100
  SIGNUP_BONUS_CREDITS: 50,     // default 20
  CREDITS_PER_PACK: 200,        // default 100
  CREDITS_PRICE_CENTS: 2500,    // default 1000
  CREDITS_PRICE_USD: 25,        // default 10
  PAGES_PER_CREDIT: 5,
  ABSOLUTE_MAX_PAGES: 75,
  bulkCreditsRequired: (n: number) => Math.ceil(n / 5),
  FREE_REGENERATIONS: 0,
  SUBSCRIPTION_TIERS: {
    free:    { name: "Free",    price: 0,  pages: 15,   maxFrequency: "manual" },
    starter: { name: "Starter", price: 10, pages: 500,  maxFrequency: "monthly" },
    growth:  { name: "Growth",  price: 20, pages: 1500, maxFrequency: "weekly" },
    pro:     { name: "Pro",     price: 30, pages: 3000, maxFrequency: "daily" },
  },
  STRIPE_PRICE_IDS: {
    monthly: { starter: "price_starter", growth: "price_growth", pro: "price_pro" },
    annual: { starter: "price_starter_annual", growth: "price_growth_annual", pro: "price_pro_annual" },
  },
  CRAWL_FREQUENCIES: ["manual", "daily", "weekly", "monthly"],
  CRAWL_FREQUENCY_RANK: { manual: 0, monthly: 1, weekly: 2, daily: 3 },
  isFrequencyAllowedForTier: (tier: "free"|"starter"|"growth"|"pro", freq: "manual"|"monthly"|"weekly"|"daily") => {
    const rank: Record<string, number> = { manual: 0, monthly: 1, weekly: 2, daily: 3 };
    const max: Record<string, string> = { free: "manual", starter: "monthly", growth: "weekly", pro: "daily" };
    return rank[freq] <= rank[max[tier]];
  },
  clampFrequencyToTier: (tier: "free"|"starter"|"growth"|"pro", freq: "manual"|"monthly"|"weekly"|"daily") => {
    const rank: Record<string, number> = { manual: 0, monthly: 1, weekly: 2, daily: 3 };
    const max: Record<string, "manual"|"monthly"|"weekly"|"daily"> = { free: "manual", starter: "monthly", growth: "weekly", pro: "daily" };
    return rank[freq] > rank[max[tier]] ? max[tier] : freq;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _eq: [_col, _val] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  ne: vi.fn((_col: unknown, _val: unknown) => ({ _ne: [_col, _val] })),
  lt: vi.fn((_col: unknown, _val: unknown) => ({ _lt: [_col, _val] })),
  isNull: vi.fn((_col: unknown) => ({ _isNull: _col })),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: { strings, values } }),
}));

vi.mock("@/lib/pipeline/runner", () => ({
  startCrawl: mockStartCrawl,
  completePipeline: vi.fn().mockResolvedValue("complete"),
}));

vi.mock("@/lib/services/page-accounting", () => ({
  resolveCrawlBudget: mockResolveCrawlBudget,
  // ES-B7: regenerate + first-audit fast-path now share this helper. Stub
  // mirrors the prior regenerate-era pure credit calc capped at the mocked
  // PAID_MAX_PAGES (75) so existing test-15 still sees maxPages=75. Active
  // subscribers with subscription headroom take the subscription branch;
  // everyone else falls back to credits.
  resolveFirstAuditMaxPages: vi.fn((team: { creditBalance: number; monthlyPageAllowance?: number; monthlyPagesUsed?: number; subscriptionTier?: string; subscriptionStatus?: string }) => {
    const remaining = Math.max(0, (team.monthlyPageAllowance ?? 0) - (team.monthlyPagesUsed ?? 0));
    const active = !!team.subscriptionTier && team.subscriptionTier !== "free" && team.subscriptionStatus === "active";
    if (active && remaining > 0) {
      const m = Math.min(remaining, 75);
      return { maxPages: m, subscriptionPages: m, creditsToReserve: 0, source: "subscription", denied: false };
    }
    const fromCredits = Math.min((team.creditBalance ?? 0) * 5, 75);
    if (fromCredits <= 0) return { maxPages: 0, subscriptionPages: 0, creditsToReserve: 0, source: "denied", denied: true };
    return { maxPages: fromCredits, subscriptionPages: 0, creditsToReserve: Math.ceil(fromCredits / 5), source: "credits", denied: false };
  }),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: mockEnqueueStage,
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("mock-id"),
}));

// Mock next/server — override after() to execute callbacks synchronously
vi.mock("next/server", async () => {
  const actual = await vi.importActual("next/server");
  return {
    ...actual,
    after: vi.fn((fn: () => void) => {
      fn();
    }),
  };
});

// Mock Stripe — must use function() (not arrow) because Stripe is invoked with `new`
vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      checkout: { sessions: { create: mockCheckoutCreate } },
      webhooks: { constructEvent: mockConstructEvent },
    };
  }),
}));

// Mock Supabase authenticated client (for checkout)
vi.mock("@/lib/supabase/authenticated-client", () => ({
  getAuthenticatedUser: vi.fn().mockResolvedValue({
    id: "user-test-1",
    email: "test@example.com",
    token: "jwt-token",
  }),
}));

// Mock @supabase/ssr (for auth callback)
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn().mockReturnValue({
    auth: {
      exchangeCodeForSession: mockExchangeCode,
    },
  }),
}));

// Mock next/headers (for auth callback and checkout)
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    getAll: vi.fn().mockReturnValue([]),
    set: vi.fn(),
  }),
  headers: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue(null),
  }),
}));

// Mock email
vi.mock("@/lib/email", () => ({
  sendCompletionEmail: vi.fn().mockResolvedValue(undefined),
  sendLowCreditsEmail: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { db } from "@/lib/db";

// ─── DB Mock Helpers ─────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
  };
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
}

function makeInsertChain() {
  return {
    values: vi.fn().mockResolvedValue([]),
  };
}

// ─── Crawl Depth Tests ──────────────────────────────────────────────────────

describe("Crawl Depth — regenerate route uses config constants", () => {
  const SITE_ID = "site-test-1";
  const TOKEN = "test-token";

  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  // ── Test 14: Anonymous free crawl passes FREE_MAX_PAGES ──

  it("anonymous free crawl passes FREE_MAX_PAGES (15) to startCrawl", async () => {
    const { POST } = await import("@/app/api/sites/[id]/regenerate/route");

    // Site: no team, pipeline not complete (eligible for free crawl)
    const site = {
      id: SITE_ID,
      domain: "example.com",
      teamId: null,
      accessToken: TOKEN,
      tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),      pipelineStatus: "pending",
    };

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([site])
    );

    const req = new NextRequest(
      new Request(`http://localhost/api/sites/${SITE_ID}/regenerate?token=${TOKEN}`, {
        method: "POST",
      })
    );

    const res = await POST(req, { params: Promise.resolve({ id: SITE_ID }) });

    expect(res.status).toBe(202);
    // Must use FREE_MAX_PAGES from config (mocked to 15), not hardcoded 20
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE_ID, domain: "example.com", stage: "discover", maxPages: 15 })
    );
  });

  // ── Test 15: Paid crawl passes PAID_MAX_PAGES ──

  it("paid crawl passes PAID_MAX_PAGES (75) to startCrawl", async () => {
    const { POST } = await import("@/app/api/sites/[id]/regenerate/route");

    const site = {
      id: SITE_ID,
      domain: "example.com",
      teamId: "team-1",
      accessToken: TOKEN,
      tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),      pipelineStatus: "complete",
    };

    const team = {
      id: "team-1",
      creditBalance: 100,
    };

    let selectCallCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return makeSelectChain([site]);
      return makeSelectChain([team]);
    });

    // Mock transaction for credit deduction
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        const teamData = [{ creditBalance: 100 }];
        const whereResult = Object.assign(Promise.resolve(teamData), {
          for: vi.fn().mockResolvedValue(teamData),
        });
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnValue(whereResult),
          }),
          update: vi.fn().mockReturnValue(makeUpdateChain()),
          insert: vi.fn().mockReturnValue(makeInsertChain()),
        };
        await fn(tx);
      }
    );

    const req = new NextRequest(
      new Request(`http://localhost/api/sites/${SITE_ID}/regenerate?token=${TOKEN}`, {
        method: "POST",
      })
    );

    const res = await POST(req, { params: Promise.resolve({ id: SITE_ID }) });

    expect(res.status).toBe(202);
    // Must use PAID_MAX_PAGES from config (mocked to 75), not hardcoded 100
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE_ID, domain: "example.com", stage: "discover", maxPages: 75 })
    );
  });

  // ── Test 16: Recrawl cron derives page budget from tier + enqueues durably ──

  it("recrawl cron derives page budget from tier via resolveFirstAuditMaxPages and enqueues discover durably", async () => {
    // C3: lib/cron-auth.ts requires ≥32 chars; set BEFORE importing the
    // route so the module-load assertion in cron-auth passes.
    const TEST_SECRET = "test-cron-secret-padded-to-32+chars-aaaaa";
    process.env.CRON_SECRET = TEST_SECRET;

    const { GET } = await import("@/app/api/cron/recrawl/route");

    // The route does a JOIN query: db.select().from().innerJoin().where().limit()
    const sitesWithTeams = [
      {
        siteId: "site-a", domain: "alpha.com", ownerEmail: "a@alpha.com",
        crawlFrequency: "weekly", teamId: "team-1",
        subscriptionTier: "growth", subscriptionStatus: "active",
        monthlyPageAllowance: 1500, monthlyPagesUsed: 0, creditBalance: 50,
      },
      {
        siteId: "site-b", domain: "beta.com", ownerEmail: "b@beta.com",
        crawlFrequency: "monthly", teamId: "team-2",
        subscriptionTier: "starter", subscriptionStatus: "active",
        monthlyPageAllowance: 500, monthlyPagesUsed: 0, creditBalance: 10,
      },
    ];

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(sitesWithTeams),
          }),
        }),
      }),
    });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    // Passthrough reservation transaction.
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          update: vi.fn().mockReturnValue(makeUpdateChain()),
          insert: vi.fn().mockReturnValue(makeInsertChain()),
          delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        };
        await fn(tx);
      }
    );

    const req = new NextRequest(
      new Request("http://localhost/api/cron/recrawl", {
        method: "GET",
        headers: { authorization: `Bearer ${TEST_SECRET}` },
      })
    );

    const res = await GET(req);
    expect(res.status).toBe(200);

    // Durable kickoff via enqueueStage (NOT after()/startCrawl). Budget comes from
    // the tier resolver (mocked cap 75), not the removed min(tier.pages,100).
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-a", domain: "alpha.com", stage: "discover", maxPages: 75 })
    );
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-b", domain: "beta.com", stage: "discover", maxPages: 75 })
    );
    expect(mockStartCrawl).not.toHaveBeenCalled();
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });
});

// ─── Config Import Tests ────────────────────────────────────────────────────

describe("Config imports — checkout uses CREDITS_PRICE_CENTS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 17: Checkout uses CREDITS_PRICE_CENTS from config ──

  it("creates Stripe session with CREDITS_PRICE_CENTS (2500) and CREDITS_PER_PACK (200) from config", async () => {
    const { POST } = await import("@/app/api/checkout/route");

    // Mock db.select for team membership lookup
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([{ teamId: "team-1" }])
    );

    const req = new NextRequest(
      new Request("http://localhost/api/checkout", { method: "POST" })
    );

    await POST(req);

    // Stripe session must use config values, not hardcoded 1000 / "100 GEO Credits"
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              unit_amount: 2500, // CREDITS_PRICE_CENTS from config (not 1000)
              product_data: expect.objectContaining({
                name: expect.stringContaining("200"), // CREDITS_PER_PACK from config (not 100)
              }),
            }),
          }),
        ],
      })
    );
  });
});

describe("Config imports — webhook uses CREDITS_PER_PACK", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 18: Webhook uses CREDITS_PER_PACK from config ──

  it("adds CREDITS_PER_PACK (200) credits on checkout.session.completed", async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/route");

    process.env.STRIPE_SECRET_KEY = "sk_test_key";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

    // Mock Stripe constructEvent to return a valid checkout.session.completed event
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_session",
          metadata: { teamId: "team-1", userId: "user-1" },
        },
      },
    });

    // Mock db.select for MED-2 idempotency check (outside transaction)
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([]));

    // Track what creditsAdded value is used in the transaction
    let capturedCreditsAdded: number | undefined;
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        let selectCount = 0;
        const tx = {
          select: vi.fn().mockImplementation(() => {
            selectCount++;
            // 1: teamMembers, 2: teams balance
            const data =
              selectCount === 1 ? [{ id: "user-1" }]
              : [{ creditBalance: 50 }];
            const whereResult = Object.assign(Promise.resolve(data), {
              for: vi.fn().mockResolvedValue(data),
            });
            return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnValue(whereResult) };
          }),
          update: vi.fn().mockReturnValue(makeUpdateChain()),
          insert: vi.fn().mockImplementation(() => ({
            values: vi.fn().mockImplementation((data: { creditsChanged: number }) => {
              capturedCreditsAdded = data.creditsChanged;
              return Promise.resolve([]);
            }),
          })),
        };
        await fn(tx);
      }
    );

    const req = new NextRequest(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: {
          "stripe-signature": "t=123,v1=abc",
          "content-type": "text/plain",
        },
        body: "{}",
      })
    );

    const res = await POST(req);
    expect(res.status).toBe(200);

    // Credits added should be CREDITS_PER_PACK from config (200), not hardcoded 100
    expect(capturedCreditsAdded).toBe(200);
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});

describe("Config imports — auth callback uses SIGNUP_BONUS_CREDITS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 19: Auth callback uses SIGNUP_BONUS_CREDITS from config ──

  it("creates team with SIGNUP_BONUS_CREDITS (50) on first login", async () => {
    const { GET } = await import("@/app/auth/callback/route");

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

    // Mock Supabase exchangeCodeForSession
    mockExchangeCode.mockResolvedValue({
      data: {
        session: {
          user: {
            id: "user-new-1",
            email: "newuser@example.com",
            user_metadata: {},
          },
        },
      },
      error: null,
    });

    // Mock DB: no existing team member, no orphan sites
    let insertCallCount = 0;
    let capturedCreditBalance: number | undefined;

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([]) // No existing membership, no orphan sites
    );

    (db.insert as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      values: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        insertCallCount++;
        // Capture the team creation (first insert is the team)
        if (insertCallCount === 1 && data.creditBalance !== undefined) {
          capturedCreditBalance = data.creditBalance as number;
        }
        // Capture credit transaction (third insert)
        if (insertCallCount === 3 && data.creditsChanged !== undefined) {
          // Also verify the credit transaction amount
          expect(data.creditsChanged).toBe(50); // SIGNUP_BONUS_CREDITS
          expect(data.balanceAfter).toBe(50);
        }
        return Promise.resolve([]);
      }),
    }));

    const req = new Request(
      "http://localhost/auth/callback?code=test-code",
      { method: "GET" }
    );

    const res = await GET(req);

    // Should redirect (302/307) to dashboard
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);

    // Team must be created with SIGNUP_BONUS_CREDITS from config (50), not hardcoded 20
    expect(capturedCreditBalance).toBe(50);
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });
});
