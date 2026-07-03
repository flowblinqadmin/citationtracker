/**
 * logCrawl — crawl logging with retry
 *
 * LC-1  Successful insert on first attempt
 * LC-2  First attempt fails → retry succeeds with new nanoid
 * LC-3  Both attempts fail → logs error, does not throw
 * LC-4  Extracts bot name from user-agent
 * LC-5  Extracts country from cf-ipcountry header
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockInsert, mockNanoid } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockNanoid: vi.fn().mockReturnValue("mock-id-1"),
}));

vi.mock("@/lib/db", () => ({
  db: { insert: mockInsert },
}));

vi.mock("nanoid", () => ({
  nanoid: mockNanoid,
}));

import { logCrawl } from "@/lib/log-crawl";

function makeReq(opts?: { ua?: string; country?: string; ip?: string }) {
  const headers: Record<string, string> = {};
  if (opts?.ua) headers["user-agent"] = opts.ua;
  if (opts?.country) headers["cf-ipcountry"] = opts.country;
  if (opts?.ip) headers["x-forwarded-for"] = opts.ip;
  return new NextRequest("http://localhost/api/serve/test-slug/llms.txt", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNanoid
    .mockReturnValueOnce("id-attempt-1")
    .mockReturnValueOnce("id-attempt-2");
});

describe("logCrawl", () => {
  it("LC-1: successful insert on first attempt", async () => {
    const valuesChain = { values: vi.fn().mockResolvedValue(undefined) };
    mockInsert.mockReturnValue(valuesChain);

    await logCrawl(makeReq({ ua: "GPTBot/1.0" }), "site-1", "test-slug", "llms_txt");

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = valuesChain.values.mock.calls[0][0];
    expect(row.id).toBe("id-attempt-1");
    expect(row.slug).toBe("test-slug");
    expect(row.fileType).toBe("llms_txt");
  });

  it("LC-2: first attempt fails → retry succeeds with new nanoid", async () => {
    const valuesChain1 = { values: vi.fn().mockRejectedValue(new Error("CONNECT_TIMEOUT")) };
    const valuesChain2 = { values: vi.fn().mockResolvedValue(undefined) };
    mockInsert
      .mockReturnValueOnce(valuesChain1)
      .mockReturnValueOnce(valuesChain2);

    await logCrawl(makeReq(), "site-1", "test-slug", "schema_js");

    expect(mockInsert).toHaveBeenCalledTimes(2);
    const retryRow = valuesChain2.values.mock.calls[0][0];
    // Retry should have a different ID than the first attempt
    const firstRow = valuesChain1.values.mock.calls[0][0];
    expect(retryRow.id).not.toBe(firstRow.id);
  });

  it("LC-3: both attempts fail → logs error, does not throw", async () => {
    const fail1 = { values: vi.fn().mockRejectedValue(new Error("timeout")) };
    const fail2 = { values: vi.fn().mockRejectedValue(new Error("timeout again")) };
    mockInsert.mockReturnValueOnce(fail1).mockReturnValueOnce(fail2);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Should not throw
    await logCrawl(makeReq(), "site-1", "test-slug", "llms_txt");

    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged.event).toBe("log_crawl_persistent_failure");
    expect(logged.siteId).toBe("site-1");
    expect(logged.slug).toBe("test-slug");
    expect(logged.fileType).toBe("llms_txt");
    spy.mockRestore();
  });

  it("LC-4: extracts bot name from user-agent", async () => {
    const valuesChain = { values: vi.fn().mockResolvedValue(undefined) };
    mockInsert.mockReturnValue(valuesChain);

    await logCrawl(makeReq({ ua: "ClaudeBot/1.0" }), "site-1", "test-slug", "llms_txt");

    const row = valuesChain.values.mock.calls[0][0];
    expect(row.botName).toBe("ClaudeBot");
  });

  it("LC-5: extracts country from cf-ipcountry header", async () => {
    const valuesChain = { values: vi.fn().mockResolvedValue(undefined) };
    mockInsert.mockReturnValue(valuesChain);

    await logCrawl(makeReq({ country: "US", ip: "1.2.3.4" }), "site-1", "test-slug", "business_json");

    const row = valuesChain.values.mock.calls[0][0];
    expect(row.country).toBe("US");
    expect(row.ip).toBe("1.2.3.4");
  });
});
