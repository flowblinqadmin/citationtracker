/**
 * ES-090 MED-3 — OTP race-condition harness.
 *
 * Used by U32 (unit, simulated parallelism) and IT7 (integration, real Postgres).
 *
 * Exposes `runOtpRace(siteId, parallel)` which fires N concurrent attempts
 * against `checkAndIncrementOtpAttempt` and returns the verdict tuple
 * (allowedCount, blockedCount, finalAttempts).
 *
 * Phase A (RED): import target does not yet implement atomic UPDATE-RETURNING,
 * so allowedCount > 5 is the deliberate failure mode this harness surfaces.
 */

export interface OtpRaceVerdict {
  parallel: number;
  allowedCount: number;
  blockedCount: number;
  finalAttempts: number;
  durationMs: number;
}

/**
 * Fires N parallel calls and aggregates the result counts.
 *
 * @param invoke - the function under test (typically `checkAndIncrementOtpAttempt(siteId)`)
 * @param parallel - number of concurrent invocations
 * @param readFinalAttempts - returns the row's `otp_attempts` value after all calls settle
 */
export async function runOtpRace(
  invoke: () => Promise<{ allowed: boolean; attemptsLeft: number }>,
  parallel: number,
  readFinalAttempts: () => Promise<number>,
): Promise<OtpRaceVerdict> {
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: parallel }, () => invoke().catch(() => ({ allowed: false, attemptsLeft: 0 }))),
  );
  const allowedCount = results.filter((r) => r.allowed).length;
  const blockedCount = parallel - allowedCount;
  const finalAttempts = await readFinalAttempts();
  return {
    parallel,
    allowedCount,
    blockedCount,
    finalAttempts,
    durationMs: Date.now() - started,
  };
}

/**
 * Hard cap from spec b.9 — OTP must lock at attempts >= 5.
 * Used by both unit and integration tests to assert the race-safe invariant:
 *   allowedCount <= 5 across any parallel level.
 */
export const OTP_HARD_CAP = 5;
