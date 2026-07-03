/**
 * ES-e2e-fixtures UT-8 (AC-1) — shared email constant between ids.ts and
 * otp-helper.ts. Any drift desynchronizes OTP IMAP polling and fixture seeds.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TEST_USER_EMAIL } from "@/e2e/fixtures/ids";

const REPO_ROOT = path.resolve(__dirname, "../../");
const OTP_HELPER_PATH = path.join(REPO_ROOT, "e2e/fixtures/otp-helper.ts");

describe("UT-8: TEST_USER_EMAIL byte-equals otp-helper.ts TO_FILTER", () => {
  const src = readFileSync(OTP_HELPER_PATH, "utf8");
  const m = src.match(/const\s+TO_FILTER\s*=\s*"([^"]+)"/);

  it("otp-helper.ts declares a TO_FILTER constant", () => {
    expect(m, "TO_FILTER not found in otp-helper.ts").toBeTruthy();
  });

  it("TEST_USER_EMAIL === TO_FILTER (byte-equal)", () => {
    expect(m![1]).toBe(TEST_USER_EMAIL);
  });
});
