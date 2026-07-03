/**
 * UT-18 — auth.users provisioning in runSeed (AC-24 / HP-264).
 *
 * Mocks @supabase/supabase-js admin client AND the `postgres` driver so the
 * whole runSeed path executes without touching a real DB. Verifies the five
 * AC-24 contract points from dispatch corr fe21fb82.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TEST_USER_ID, TEST_USER_EMAIL } from "@/e2e/fixtures/ids";

const adminListUsers = vi.fn();
const adminDeleteUser = vi.fn();
const adminCreateUser = vi.fn();
const createClientMock = vi.fn(() => ({
  auth: { admin: { listUsers: adminListUsers, deleteUser: adminDeleteUser, createUser: adminCreateUser } },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: createClientMock }));

// Stub `postgres` so the pg side of runSeed completes without a real connection.
// Every tx tagged-template call resolves to an empty array — iterable, so
// destructuring like `const [row] = await tx\`SELECT …\`` yields `undefined`
// without throwing. Non-SELECT statements don't access the result shape, so
// the same return works for DELETE/INSERT/UPDATE.
function makePostgresStub() {
  const tx: any = new Proxy(() => Promise.resolve([]), {
    apply: () => Promise.resolve([]),
  });
  const sql: any = new Proxy(() => Promise.resolve([]), {
    apply: () => Promise.resolve([]),
  });
  sql.begin = async (cb: (tx: any) => Promise<unknown>) => cb(tx);
  sql.end = async () => {};
  return sql;
}
vi.mock("postgres", () => ({
  default: () => makePostgresStub(),
}));

const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const FAKE_KEY = "fake-service-role-key-SHOULD-NEVER-APPEAR-IN-LOGS";

const originalEnv: NodeJS.ProcessEnv = { ...process.env };
let exitSpy: any;
let logSpy: any;
let errorSpy: any;
let warnSpy: any;

function emittedText(): string {
  const chunks: string[] = [];
  for (const spy of [logSpy, errorSpy, warnSpy]) {
    for (const call of spy?.mock?.calls ?? []) {
      for (const arg of call) chunks.push(typeof arg === "string" ? arg : JSON.stringify(arg));
    }
  }
  return chunks.join("\n");
}

describe("UT-18: runSeed auth.users provisioning (AC-24, HP-264)", () => {
  beforeEach(() => {
    vi.resetModules();
    adminListUsers.mockReset();
    adminDeleteUser.mockReset();
    adminCreateUser.mockReset();
    createClientMock.mockClear();
    process.env = {
      ...originalEnv,
      DATABASE_URL: LOCAL_DB,
      NODE_ENV: "test",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    };
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code ?? 0}__`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it("(1) prior email-matched row → deleteUser(priorId) + createUser(TEST_USER_ID)", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE_KEY;
    adminListUsers.mockResolvedValueOnce({
      data: { users: [{ id: "random-uuid-v4-prior", email: TEST_USER_EMAIL }] },
      error: null,
    });
    adminDeleteUser.mockResolvedValueOnce({ error: null });
    adminCreateUser.mockResolvedValueOnce({ error: null });

    const { runSeed } = await import("@/scripts/e2e/seed");
    await runSeed();

    expect(adminListUsers).toHaveBeenCalledWith({ perPage: 1000 });
    expect(adminDeleteUser).toHaveBeenCalledWith("random-uuid-v4-prior");
    expect(adminCreateUser).toHaveBeenCalledWith({
      id: TEST_USER_ID,
      email: TEST_USER_EMAIL,
      email_confirm: true,
    });
  });

  it("(2) no prior email match → deleteUser NOT called; createUser called with deterministic args", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE_KEY;
    adminListUsers.mockResolvedValueOnce({
      data: { users: [{ id: "other-id", email: "someone-else@example.com" }] },
      error: null,
    });
    adminCreateUser.mockResolvedValueOnce({ error: null });

    const { runSeed } = await import("@/scripts/e2e/seed");
    await runSeed();

    expect(adminDeleteUser).not.toHaveBeenCalled();
    expect(adminCreateUser).toHaveBeenCalledWith({
      id: TEST_USER_ID,
      email: TEST_USER_EMAIL,
      email_confirm: true,
    });
  });

  it("(3) SUPABASE_SERVICE_ROLE_KEY missing → process.exit(2) BEFORE admin client instantiated", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { runSeed } = await import("@/scripts/e2e/seed");
    await expect(runSeed()).rejects.toThrow(/__EXIT_2__/);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(adminListUsers).not.toHaveBeenCalled();
    expect(adminCreateUser).not.toHaveBeenCalled();
  });

  it("(4) admin error rethrown with '[seed] auth.admin.<op> failed:' shape", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE_KEY;
    adminListUsers.mockResolvedValueOnce({
      data: { users: [] },
      error: null,
    });
    adminCreateUser.mockResolvedValueOnce({ error: { message: "email already registered" } });

    const { runSeed } = await import("@/scripts/e2e/seed");
    await expect(runSeed()).rejects.toThrow(
      /\[seed\] auth\.admin\.createUser.*failed: email already registered/,
    );
  });

  it("(5) no SERVICE_ROLE_KEY value leaks into any console output (AC-24 bullet 6)", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE_KEY;
    adminListUsers.mockResolvedValueOnce({ data: { users: [] }, error: null });
    adminCreateUser.mockResolvedValueOnce({ error: null });

    const { runSeed } = await import("@/scripts/e2e/seed");
    await runSeed();

    const text = emittedText();
    expect(text).not.toContain(FAKE_KEY);
  });

  it("(6) non-local NEXT_PUBLIC_SUPABASE_URL → assertLocalSupabaseUrl rejects with exit(2) BEFORE admin client instantiated", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://prod.supabase.co";

    const { runSeed } = await import("@/scripts/e2e/seed");
    await expect(runSeed()).rejects.toThrow(/__EXIT_2__/);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(adminListUsers).not.toHaveBeenCalled();
  });
});
