/**
 * ES-090 U2j — HP-239 split-primitives regression guard (spec §c.1, PR#1 merge gate).
 *
 * HP-239 replaced `checkAndIncrementOtpAttempt` (a combined read-modify-write
 * primitive that incremented the attempts counter on every unlocked call) with
 * two narrower primitives:
 *   - `checkOtpLock` — read-only lock check.
 *   - `incrementOtpAttempt` — write-only increment, called ONLY on the
 *     wrong-OTP path.
 *
 * The DoS vector closed by HP-239: any caller with a site's id could burn the
 * 5-attempt counter with `POST /verify { code: "000000" }` — no prior OTP
 * send required — locking out the real owner for 15 minutes. Fix: read the
 * lock first, increment only after verifyCode() returns false.
 *
 * This source-grep regression guard trips if a future refactor re-introduces
 * the legacy combined primitive inside `app/api/sites/[id]/verify/route.ts`.
 * A zero-match count is the invariant. Kept as a plain text scan — faster
 * than the AST walk in U2k, since the threat model here is textual recall.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

describe("ES-090 U2j — HP-239 split-primitives regression guard (PR#1 merge gate)", () => {
  it("verify/route.ts contains zero direct `checkAndIncrementOtpAttempt(` calls", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/sites/[id]/verify/route.ts"),
      "utf-8",
    );
    const matches = source.match(/checkAndIncrementOtpAttempt\s*\(/g) ?? [];
    expect(
      matches.length,
      "HP-239 invariant: verify-route must NOT call the legacy combined primitive directly. " +
      "Both re-login and fresh-verify branches must go through assertOtpGate which uses the " +
      "split primitives (checkOtpLock + incrementOtpAttempt). A non-zero match count means a " +
      "refactor has re-introduced the DoS-prone combined-primitive pattern.",
    ).toBe(0);
  });
});
