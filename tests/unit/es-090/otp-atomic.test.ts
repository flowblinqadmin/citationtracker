/**
 * ES-090 MED-3 — OTP atomic increment (U27-U32).
 *
 * Phase A (RED): main @ 70645cba `lib/rate-limit.ts:51-89` uses SELECT-then-UPDATE
 * which races under concurrency. Spec b.9 replaces with UPDATE … RETURNING.
 *
 * HP-216 note: unit-level atomic detection here is a smoke signal only. The
 * `/otp_attempts\s*\+\s*1/` regex below catches whether the caller's UPDATE
 * patch looks like the atomic shape spec b.9 mandates — but it's a string-
 * matching heuristic, not real atomicity verification. Real atomicity is
 * validated at IT7 via pglite (HP-205), which runs the same code against
 * actual Postgres MVCC + row-level locking.
 *
 * ChangedSpec per HP-205 (§c.5): pg-mem is EXPLICITLY FORBIDDEN for U32 —
 * its JS reimplementation always looks atomic even on a racy impl.
 *
 * Tests assert:
 *   - the new contract (single atomic write per call) via call-shape mocks
 *   - the race-safe invariant via the `runOtpRace` harness (U32)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runOtpRace, OTP_HARD_CAP } from "@/tests/fixtures/es-090/otp-race";

interface FakeRow {
  otpAttempts: number;
  otpLockedUntil: Date | null;
}

const { state, dbMock } = vi.hoisted(() => {
  const state: { rows: Map<string, FakeRow>; __lastSiteId: string } = {
    rows: new Map(),
    __lastSiteId: "",
  };

  // ANTI-FALSE-GREEN: this fake intentionally does NOT serialize.
  //
  // The current (pre-ES-090) lib/rate-limit.ts uses SELECT-then-UPDATE which
  // races. A serializing fake would let the test pass today via mock magic
  // even when the source code is still racy. Instead, we model the *unsafe*
  // behavior — only the post-ES-090 atomic UPDATE…RETURNING (which our fake
  // sees via the `+ 1` signature path) returns serialized values.
  //
  // Post-HP-239 the atomic path also writes otpLockedUntil in the same
  // UPDATE via CASE WHEN; the fake mirrors that so callers observe the lock
  // in the RETURNING row.
  const atomicIncrementUnsafe = async (siteId: string): Promise<FakeRow | null> => {
    const row = state.rows.get(siteId);
    if (!row) return null;
    // Read-modify-write with no lock — concurrent callers race.
    const seen = row.otpAttempts;
    await new Promise((r) => setTimeout(r, 0));
    row.otpAttempts = seen + 1;
    if (row.otpAttempts >= 5 && !row.otpLockedUntil) {
      row.otpLockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    }
    return { otpAttempts: row.otpAttempts, otpLockedUntil: row.otpLockedUntil };
  };

  const dbMock = {
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        // Spec post-fix: UPDATE … SET otp_attempts = sql`otp_attempts + 1` … RETURNING
        // HP-216 regex: more precise than substring `includes("+ 1")` which
        // would match any string with `+ 1` anywhere. The anchored pattern
        // requires the literal column reference immediately before the
        // increment token.
        const isAtomic = /otp_attempts\s*\+\s*1/.test(String(patch.otpAttempts ?? ""));
        const clearsAttempts = patch.otpAttempts === 0;
        return {
          where: vi.fn(() => {
            // clearOtpAttempts path: `.update().set({...}).where()` returns
            // void (no .returning()). Model as a thenable + a .returning()
            // chain so both shapes resolve.
            if (clearsAttempts) {
              const siteId = state.__lastSiteId ?? "";
              const row = state.rows.get(siteId);
              if (row) { row.otpAttempts = 0; row.otpLockedUntil = null; }
              return Promise.resolve([]);
            }
            return {
              returning: vi.fn(async () => {
                const siteId = state.__lastSiteId ?? "";
                if (!isAtomic) return [];
                const r = await atomicIncrementUnsafe(siteId);
                return r ? [r] : [];
              }),
            };
          }),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => {
          const r = state.rows.get(state.__lastSiteId ?? "");
          return r ? [r] : [];
        }),
      })),
    })),
    insert: vi.fn(),
  } as Record<string, unknown>;

  return { state, dbMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/db/schema", () => ({
  geoSites: {
    id: "id",
    otpAttempts: { name: "otp_attempts", toString: () => "otp_attempts" },
    otpLockedUntil: "otp_locked_until",
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  // sql tag — interpolate values into the template so the atomic-shape detector
  // sees the literal column reference (`otp_attempts + 1`). HP-239 split
  // routed the atomic UPDATE through `incrementOtpAttempt`; the wrapper still
  // emits the same `sql\`${geoSites.otpAttempts} + 1\`` patch, so the detector
  // only needs the column-name to land in the joined string.
  sql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (acc, s, i) => acc + s + (values[i] !== undefined ? String(values[i]) : ""),
      ""
    ),
}));

beforeEach(() => {
  state.rows.clear();
  state.rows.set("site-a", { otpAttempts: 0, otpLockedUntil: null });
  state.__lastSiteId = "site-a";
  (dbMock.update as ReturnType<typeof vi.fn>).mockClear();
  (dbMock.select as ReturnType<typeof vi.fn>).mockClear();
});

describe("ES-090 MED-3 — checkAndIncrementOtpAttempt", () => {
  it("U27: single increment returns attemptsLeft = 4", async () => {
    const mod = await import("@/lib/rate-limit?u27");
    const r = await mod.checkAndIncrementOtpAttempt("site-a");
    expect(r.allowed).toBe(true);
    expect(r.attemptsLeft).toBe(4);
  });

  it("U28: at attempts == 5, lockout is written (otpLockedUntil set ≈ now+15m)", async () => {
    state.rows.set("site-a", { otpAttempts: 4, otpLockedUntil: null });
    const mod = await import("@/lib/rate-limit?u28");
    const r = await mod.checkAndIncrementOtpAttempt("site-a");
    expect(r.allowed).toBe(false);
    // Post-HP-239: the atomic UPDATE writes BOTH otpAttempts and
    // otpLockedUntil in a single CASE-WHEN patch — so db.update is called
    // exactly once by incrementOtpAttempt, not twice. The lock write is
    // observed via the RETURNING row (otpLockedUntil populated on state).
    expect((dbMock.update as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    const finalRow = state.rows.get("site-a");
    expect(finalRow?.otpLockedUntil).toBeInstanceOf(Date);
    expect(finalRow!.otpLockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("U29: locked row returns not-allowed without further increment", async () => {
    state.rows.set("site-a", { otpAttempts: 1, otpLockedUntil: new Date(Date.now() + 60_000) });
    const mod = await import("@/lib/rate-limit?u29");
    const r = await mod.checkAndIncrementOtpAttempt("site-a");
    expect(r.allowed).toBe(false);
    expect(r.attemptsLeft).toBe(0);
  });

  it("U30: clearOtpAttempts resets to 0", async () => {
    state.rows.set("site-a", { otpAttempts: 3, otpLockedUntil: null });
    const mod = await import("@/lib/rate-limit?u30");
    await mod.clearOtpAttempts("site-a");
    // Subsequent increment should report attemptsLeft == 4 (i.e. counter was reset).
    state.rows.set("site-a", { otpAttempts: 0, otpLockedUntil: null });
    const r = await mod.checkAndIncrementOtpAttempt("site-a");
    expect(r.attemptsLeft).toBe(4);
  });

  it("U31: siteId not found → not allowed", async () => {
    state.rows.clear();
    const mod = await import("@/lib/rate-limit?u31");
    const r = await mod.checkAndIncrementOtpAttempt("does-not-exist");
    expect(r.allowed).toBe(false);
    expect(r.attemptsLeft).toBe(0);
  });

  // U32 is PR#2+ MED-3 IT7 scope — real concurrency invariants require pglite
  // per HP-205 (§c.5). The docstring above flags the unit-level version as a
  // smoke signal only (HP-216 note). A JS fake can't honestly serialize a
  // racy caller without "mock magic" that would false-green a still-racy
  // impl. Skipped here; atomicity is enforced by IT7 in the pglite suite.
  it.skip("U32: 20 concurrent calls — at most OTP_HARD_CAP (5) succeed (race-safe invariant) [→ IT7 pglite, PR#2+ MED-3]", async () => {
    // The current code uses SELECT-then-UPDATE — under our racing fake DB,
    // 20 parallel callers all read otpAttempts=0, all increment to 1, all
    // get allowed=true. allowedCount will exceed OTP_HARD_CAP. Test fails.
    //
    // Post-ES-090: spec b.9 uses UPDATE … SET otp_attempts = otp_attempts + 1
    // RETURNING — the dbMock detects this signature and serializes the
    // increment (via atomicIncrementUnsafe with await 0 — Postgres atomic
    // semantics serialize even a racing impl). allowedCount ≤ 5.
    const mod = await import("@/lib/rate-limit?u32");
    const verdict = await runOtpRace(
      () => mod.checkAndIncrementOtpAttempt("site-a"),
      20,
      async () => state.rows.get("site-a")?.otpAttempts ?? 0,
    );
    // Anti-false-green guard: at least one call must have succeeded.
    // Without this, an impl that throws on every call (allowedCount === 0)
    // would trivially satisfy the ≤5 bound.
    expect(verdict.allowedCount).toBeGreaterThanOrEqual(1);
    expect(verdict.allowedCount).toBeLessThanOrEqual(OTP_HARD_CAP);
    expect(verdict.blockedCount).toBeGreaterThanOrEqual(20 - OTP_HARD_CAP);
    // Final attempts row must reflect the cap — anti-false-green: a no-op
    // db.update would leave finalAttempts at 0.
    expect(verdict.finalAttempts).toBeGreaterThanOrEqual(1);
  });
});
