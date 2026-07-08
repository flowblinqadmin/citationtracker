// enqueueTrackerJob transport selection — the reliability boundary. The key
// property (F2/F9): in a DEPLOYED environment a missing QSTASH_TOKEN must THROW
// (so the run route refunds and the misconfig surfaces), never silently fall
// back to the fire-and-forget direct call that a frozen lambda won't deliver.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { enqueueTrackerJob } from "@/lib/engine/enqueue";

const SECRET = "cron-secret-0123456789abcdef0123456789abcdef";
const payload = { runId: "tr_1", clientId: "tc_1", cursor: 0 };

let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  delete process.env.QSTASH_TOKEN;
  delete process.env.QSTASH_URL;
  delete process.env.VERCEL;
  vi.stubEnv("NODE_ENV", "test");
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env = { ...savedEnv };
});

describe("enqueueTrackerJob transport", () => {
  it("publishes through QStash when QSTASH_TOKEN is set (regional URL, retries 0)", async () => {
    process.env.QSTASH_TOKEN = "tok";
    process.env.QSTASH_URL = "https://qstash-us-east-1.upstash.io";
    await enqueueTrackerJob(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("qstash-us-east-1.upstash.io/v2/publish/");
    expect(url).toContain("citationtracker.vercel.app/citations/api/cron/tracker-worker");
    expect(init.headers["Upstash-Retries"]).toBe("0");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("throws when QStash returns non-ok (so the caller refunds)", async () => {
    process.env.QSTASH_TOKEN = "tok";
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(enqueueTrackerJob(payload)).rejects.toThrow(/QStash publish failed/);
  });

  it("F2/F9: THROWS in a deployed env (VERCEL) when QSTASH_TOKEN is missing", async () => {
    process.env.VERCEL = "1";
    await expect(enqueueTrackerJob(payload)).rejects.toThrow(/QSTASH_TOKEN is required/);
    expect(fetchMock).not.toHaveBeenCalled(); // never leaks the direct-call fallback
  });

  it("F2/F9: THROWS when NODE_ENV=production and QSTASH_TOKEN is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(enqueueTrackerJob(payload)).rejects.toThrow(/QSTASH_TOKEN is required/);
  });

  it("local dev (no VERCEL, not prod): direct fire-and-forget with the cron Bearer", async () => {
    await enqueueTrackerJob(payload);
    // fire-and-forget: give the void fetch a tick to land
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://citationtracker.vercel.app/citations/api/cron/tracker-worker");
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });
});
