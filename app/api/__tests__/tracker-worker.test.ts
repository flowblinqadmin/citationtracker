// Worker route auth matrix + dispatch semantics. The runner itself is covered
// by lib/engine tests; here the runner is mocked and we assert the route's
// contract: who gets in, what happens on pause/fatal, and that QStash
// signature verification pins the exact public worker URL.
import { describe, it, expect, beforeEach, vi } from "vitest";
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
  enqueueMock.mockClear();
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
});
