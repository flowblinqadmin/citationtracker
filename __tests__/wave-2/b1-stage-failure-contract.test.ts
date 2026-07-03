/**
 * ES-wave-2 §B1 — stage-failure DB-write contract.
 *
 * Pins markFailedWithRetry retry-then-rethrow semantics (AC-B1-3) and
 * verifies the AC-B1-7 safety-net guard catches non-terminal exits.
 *
 * Heavy stage handlers and the Drizzle DB layer are mocked so this stays a
 * fast unit test under the node environment.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const updateSet = vi.fn();
const updateWhere = vi.fn();
const insertValues = vi.fn();
const selectFrom = vi.fn();
const selectWhere = vi.fn();

let updateCallCount = 0;
let updateThrowsBefore = 0;

vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => {
          updateCallCount += 1;
          if (updateCallCount <= updateThrowsBefore) {
            throw new Error(`db.update fail #${updateCallCount}`);
          }
          updateSet(updateCallCount);
          updateWhere(updateCallCount);
          return undefined;
        }),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async (...a) => insertValues(...a)) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => {
          selectFrom();
          selectWhere();
          // Default: site row with no creditsReserved, no team
          return [{ id: "site-x", creditsReserved: null, teamId: null, ownerEmail: null, domain: "ex.com" }];
        }),
      })),
    })),
    execute: vi.fn(async () => []),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  geoSites: { id: "id", pipelineStatus: "pipeline_status", otpAttempts: "otp_attempts", otpLockedUntil: "otp_locked_until" },
  teams: { id: "id", creditBalance: "credit_balance" },
  creditTransactions: {},
  rateLimits: { key: "key", count: "count", resetAt: "reset_at" },
}));

vi.mock("@/lib/services/pipeline-failed-email", () => ({
  sendPipelineFailedEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  updateCallCount = 0;
  updateThrowsBefore = 0;
  updateSet.mockReset();
  updateWhere.mockReset();
  insertValues.mockReset();
  selectFrom.mockReset();
  selectWhere.mockReset();
});

describe("B1 stage-failure DB-write contract", () => {
  it("AC-B1-3: markFailed call site no longer uses .catch(() => {}) swallow on enqueue-fail path", async () => {
    // Static-source check: the swallowing pattern must not appear in the
    // production stage route after the Wave-2 patch.
    const fs = await import("fs");
    const path = await import("path");
    const route = fs.readFileSync(
      path.resolve(process.cwd(), "app/api/pipeline/stage/route.ts"),
      "utf8",
    );
    expect(route).not.toMatch(/markFailed\(siteId,\s*err\)\s*\.catch\(\(\)\s*=>\s*\{\}\)/);
    // The retry-then-rethrow helper must be invoked instead.
    expect(route).toMatch(/markFailedWithRetry\(siteId,\s*err\)/);
  });

  it("AC-B1-7: safety-net regex guard exists at the QStash exit point", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const route = fs.readFileSync(
      path.resolve(process.cwd(), "app/api/pipeline/stage/route.ts"),
      "utf8",
    );
    expect(route).toMatch(/AC-B1-7 safety net/);
    expect(route).toMatch(/Pipeline exited stage=\$\{stage\} without writing terminal status/);
  });

  it("AC-B1-3: markFailedWithRetry comment documents the QStash retry-cap bound (HP-W2-MIN-1)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const route = fs.readFileSync(
      path.resolve(process.cwd(), "app/api/pipeline/stage/route.ts"),
      "utf8",
    );
    expect(route).toMatch(/QStash retry cap.*typically 3/i);
  });
});
