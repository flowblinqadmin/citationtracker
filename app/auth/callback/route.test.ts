import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock next/headers cookies() before the route is loaded
// ---------------------------------------------------------------------------
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @supabase/ssr createServerClient
// ---------------------------------------------------------------------------
const mockExchangeCodeForSession = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn().mockImplementation(() => ({
    auth: {
      exchangeCodeForSession: mockExchangeCodeForSession,
    },
  })),
}));

// ---------------------------------------------------------------------------
// Mock ensureTeamForUser
// ---------------------------------------------------------------------------
const mockEnsureTeamForUser = vi.fn();

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: (...args: unknown[]) => mockEnsureTeamForUser(...args),
}));

import { GET } from "./route";
import { cookies } from "next/headers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_COOKIE_STORE = {
  getAll: vi.fn().mockReturnValue([]),
  set: vi.fn(),
};

const MOCK_USER = {
  id: "supabase-user-uuid",
  email: "alice@example.com",
};

const MOCK_SESSION = {
  user: MOCK_USER,
  access_token: "jwt-token",
};

function makeRequest(params: Record<string, string> = {}, overrides: { headers?: Record<string, string> } = {}): Request {
  const url = new URL("http://localhost/auth/callback");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new Request(url.toString(), {
    headers: overrides.headers ?? {},
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /auth/callback — early error redirects (no DB, no Supabase)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cookies).mockResolvedValue(MOCK_COOKIE_STORE as never);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  it("redirects to /auth/login?error=auth-code-error when 'error' param is present", async () => {
    const req = makeRequest({ error: "access_denied", error_description: "User denied access" });
    const res = await GET(req);

    expect(res.status).toBe(307); // NextResponse.redirect default
    const location = res.headers.get("location")!;
    expect(location).toContain("/auth/login");
    expect(location).toContain("error=auth-code-error");
  });

  it("includes error_description in the redirect when provided", async () => {
    const req = makeRequest({ error: "access_denied", error_description: "User denied access" });
    const res = await GET(req);

    const location = res.headers.get("location")!;
    expect(location).toContain("error_description");
  });

  it("redirects to /auth/login?error=auth-code-error when 'code' param is absent", async () => {
    const req = makeRequest({}); // no code, no error
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/auth/login");
    expect(location).toContain("error=auth-code-error");
  });
});

describe("GET /auth/callback — Supabase exchange errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cookies).mockResolvedValue(MOCK_COOKIE_STORE as never);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  it("redirects to /auth/login when exchangeCodeForSession returns an error", async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: null,
      error: { message: "invalid code" },
    });

    const req = makeRequest({ code: "bad-code" });
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("error=auth-code-error");
  });

  it("redirects to /auth/login when exchange succeeds but session is null", async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const req = makeRequest({ code: "ok-code" });
    const res = await GET(req);

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("error=auth-code-error");
  });
});

describe("GET /auth/callback — team provisioning via ensureTeamForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cookies).mockResolvedValue(MOCK_COOKIE_STORE as never);
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: MOCK_SESSION },
      error: null,
    });
    mockEnsureTeamForUser.mockResolvedValue({ teamId: "team-new", isNewTeam: true });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  it("calls ensureTeamForUser with userId and email on successful login", async () => {
    await GET(makeRequest({ code: "valid-code" }));

    expect(mockEnsureTeamForUser).toHaveBeenCalledWith("supabase-user-uuid", "alice@example.com");
  });

  it("redirects to /dashboard on successful first login", async () => {
    const res = await GET(makeRequest({ code: "valid-code" }));

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/dashboard");
    expect(location).not.toContain("error");
  });

  it("redirects to /dashboard even on subsequent logins (existing team)", async () => {
    mockEnsureTeamForUser.mockResolvedValue({ teamId: "team-existing", isNewTeam: false });

    const res = await GET(makeRequest({ code: "valid-code" }));
    const location = res.headers.get("location")!;
    expect(location).toContain("/dashboard");
  });

  it("skips ensureTeamForUser when user has no email", async () => {
    const noEmailSession = {
      user: { id: "user-no-email", email: undefined },
      access_token: "tok",
    };
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: noEmailSession },
      error: null,
    });

    await GET(makeRequest({ code: "valid-code" }));

    expect(mockEnsureTeamForUser).not.toHaveBeenCalled();
  });

  it("continues to dashboard even if ensureTeamForUser throws (non-fatal)", async () => {
    mockEnsureTeamForUser.mockRejectedValue(new Error("DB timeout"));

    const res = await GET(makeRequest({ code: "valid-code" }));

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/dashboard");
    expect(location).not.toContain("error");
  });
});

describe("GET /auth/callback — redirect URL construction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cookies).mockResolvedValue(MOCK_COOKIE_STORE as never);
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: MOCK_SESSION },
      error: null,
    });
    mockEnsureTeamForUser.mockResolvedValue({ teamId: "team-1", isNewTeam: false });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  });

  it("uses NEXT_PUBLIC_APP_URL in production (ignores x-forwarded-host)", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.myapp.com";

    const req = makeRequest({ code: "code" }, { headers: { "x-forwarded-host": "other-host.com" } });
    const res = await GET(req);

    const location = res.headers.get("location")!;
    expect(location).toContain("geo.myapp.com");
    expect(location).toContain("/dashboard");
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("uses origin in development (ignores x-forwarded-host)", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";

    const req = makeRequest({ code: "code" }, { headers: { "x-forwarded-host": "other-host.com" } });
    const res = await GET(req);

    const location = res.headers.get("location")!;
    expect(location).toContain("localhost");
  });
});
