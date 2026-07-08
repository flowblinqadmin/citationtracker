// Worker route auth matrix + dispatch semantics. The runner itself is covered
// by lib/engine tests; here the runner is mocked and we assert the route's
// contract: who gets in, what happens on pause/fatal, and that QStash
// signature verification pins the exact public worker URL.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const executeMock = vi.fn();
const failRunMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/engine/runner", () => ({
  executeTrackerRun: (...args: unknown[]) => executeMock(...args),
  failRun: (...args: unknown[]) => failRunMock(...args),
}));

const enqueueMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/engine/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/engine/enqueue")>();
  return {
    ...actual,
    enqueueTrackerJob: (...args: unknown[]) => enqueueMock(...args),
  };
});

const runOrgIdMock = vi.fn();
vi.mock("@/lib/tracker-db", () => ({
  runOrgId: (...args: unknown[]) => runOrgIdMock(...args),
}));

const receiverVerifyMock = vi.fn();
vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify = receiverVerifyMock;
  },
}));

import { POST } from "@/app/api/cron/tracker-worker/route";

const SECRET = "cron-secret-0123456789abcdef0123456789abcdef";

function call(body: string, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://x/api/cron/tracker-worker", { method: "POST", body, headers }),
  );
}

const goodPayload = JSON.stringify({ runId: "tr_1", clientId: "tc_1", cursor: 0 });

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  process.env.QSTASH_CURRENT_SIGNING_KEY = "sig_current";
  process.env.QSTASH_NEXT_SIGNING_KEY = "sig_next";
  executeMock.mockReset().mockResolvedValue({ status: "complete", cursor: 3, processed: 3 });
  failRunMock.mockClear();
  enqueueMock.mockClear().mockResolvedValue(undefined);
  runOrgIdMock.mockReset().mockResolvedValue("team_acme"); // team run by default
  receiverVerifyMock.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/cron/tracker-worker — auth", () => {
  it("401 with no credentials", async () => {
    const res = await call(goodPayload);
    expect(res.status).toBe(401);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("401 with a wrong Bearer token", async () => {
    const res = await call(goodPayload, { authorization: `Bearer ${"x".repeat(SECRET.length)}` });
    expect(res.status).toBe(401);
  });

  it("accepts Bearer CRON_SECRET", async () => {
    const res = await call(goodPayload, { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "complete" });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [runId, clientId, cursor, deadline] = executeMock.mock.calls[0];
    expect([runId, clientId, cursor]).toEqual(["tr_1", "tc_1", 0]);
    expect(deadline).toBeGreaterThan(Date.now());
  });

  it("accepts a valid QStash signature, verified against the exact public worker URL", async () => {
    const res = await call(goodPayload, { "upstash-signature": "sig123" });
    expect(res.status).toBe(200);
    expect(receiverVerifyMock).toHaveBeenCalledWith({
      signature: "sig123",
      body: goodPayload,
      url: "https://citationtracker.vercel.app/citations/api/cron/tracker-worker",
    });
  });

  it("401 when signature verification throws", async () => {
    receiverVerifyMock.mockRejectedValue(new Error("bad sig"));
    const res = await call(goodPayload, { "upstash-signature": "forged" });
    expect(res.status).toBe(401);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("401 for a signed request when signing keys are not configured (fail closed)", async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    const res = await call(goodPayload, { "upstash-signature": "sig123" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/cron/tracker-worker — dispatch", () => {
  const auth = { authorization: `Bearer ${SECRET}` };

  it("400 on unparseable JSON", async () => {
    const res = await call("not-json", auth);
    expect(res.status).toBe(400);
  });

  it("400 when runId/clientId are missing", async () => {
    const res = await call(JSON.stringify({ cursor: 2 }), auth);
    expect(res.status).toBe(400);
  });

  it("re-enqueues with the returned cursor when the run pauses", async () => {
    executeMock.mockResolvedValue({ status: "paused", cursor: 40, processed: 40 });
    const res = await call(goodPayload, auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "paused", cursor: 40 });
    expect(enqueueMock).toHaveBeenCalledWith({ runId: "tr_1", clientId: "tc_1", cursor: 40 });
  });

  it("does not re-enqueue on completion", async () => {
    await call(goodPayload, auth);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("fatal error → failRun + HTTP 200 {ok:false} (QStash must not retry)", async () => {
    executeMock.mockRejectedValue(new Error("provider exploded"));
    const res = await call(goodPayload, auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "provider exploded" });
    expect(failRunMock).toHaveBeenCalledWith("tr_1", "provider exploded");
  });

  // F4: a self-resume enqueue failure must NOT fail a paused, resumable run —
  // execution succeeded, the run is still 'running' with work persisted, and
  // stale recovery will re-enqueue it. failRun would strand work + wrongly refund.
  it("paused-run re-enqueue failure leaves the run recoverable (no failRun)", async () => {
    executeMock.mockResolvedValue({ status: "paused", cursor: 40, processed: 40 });
    enqueueMock.mockRejectedValue(new Error("QStash 500"));
    const res = await call(goodPayload, auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: "paused", cursor: 40, resumeDeferred: true });
    expect(failRunMock).not.toHaveBeenCalled();
  });

  // F7: the tenancy guard at the execution boundary.
  it("refuses a non-team (PCG) run without executing it", async () => {
    runOrgIdMock.mockResolvedValue("org_pcg");
    const res = await call(goodPayload, auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, error: "non-team run refused" });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("executes when the run's org is a team org", async () => {
    runOrgIdMock.mockResolvedValue("team_acme");
    const res = await call(goodPayload, auth);
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("lets a missing run (null org) through to the runner's skip path", async () => {
    runOrgIdMock.mockResolvedValue(null);
    executeMock.mockResolvedValue({ status: "skipped", cursor: 0, processed: 0 });
    const res = await call(goodPayload, auth);
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

// F8: the fake-provider seam must never fabricate data in a deployed env. deps
// is the 6th arg to executeTrackerRun; faked deps carry queryFns, real = {}.
describe("POST /api/cron/tracker-worker — E2E seam guard", () => {
  const auth = { authorization: `Bearer ${SECRET}` };
  const depsArg = () => executeMock.mock.calls[0][5] as { queryFns?: unknown };

  afterEach(() => {
    delete process.env.E2E_FAKE_PROVIDERS;
    delete process.env.VERCEL;
    vi.unstubAllEnvs();
  });

  it("injects fixture providers locally when E2E_FAKE_PROVIDERS=1", async () => {
    process.env.E2E_FAKE_PROVIDERS = "1";
    await call(goodPayload, auth);
    expect(depsArg().queryFns).toBeDefined();
  });

  it("IGNORES the flag in a deployed env (VERCEL) — real providers", async () => {
    process.env.E2E_FAKE_PROVIDERS = "1";
    process.env.VERCEL = "1";
    await call(goodPayload, auth);
    expect(depsArg().queryFns).toBeUndefined();
  });

  it("IGNORES the flag when NODE_ENV=production", async () => {
    process.env.E2E_FAKE_PROVIDERS = "1";
    vi.stubEnv("NODE_ENV", "production");
    await call(goodPayload, auth);
    expect(depsArg().queryFns).toBeUndefined();
  });
});
