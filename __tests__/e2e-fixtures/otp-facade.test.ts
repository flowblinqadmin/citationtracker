/**
 * UT-15 + UT-16 — OTP facade dispatch + timeout ceiling (Phase 0 Track A).
 *
 * Unit-level: the facade is mocked against the two underlying helpers to
 * prove (a) `flow="login"` routes to Mailpit only, `flow="verify"` routes
 * to Gmail IMAP only, (b) unknown flow throws with a crisp message,
 * (c) timeouts pass through untouched, (d) timeout errors re-throw unchanged.
 *
 * ES-e2e-fixtures AC-18, AC-19, AC-20.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock both helpers BEFORE importing the facade. Each test asserts the
// call-counts match the expected-dispatch matrix.
const mailpitMock = vi.fn();
const imapMock = vi.fn();

vi.mock("@/e2e/helpers/mailpit", () => ({
  getOtpForEmail: (...args: unknown[]) => mailpitMock(...args),
}));

vi.mock("@/e2e/fixtures/otp-helper", () => {
  class OtpTimeoutError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "OtpTimeoutError";
    }
  }
  return {
    getLatestOtp: (...args: unknown[]) => imapMock(...args),
    OtpTimeoutError,
  };
});

describe("UT-15: getOtp dispatch correctness (AC-18)", () => {
  beforeEach(() => {
    mailpitMock.mockReset();
    imapMock.mockReset();
  });

  it("flow=login routes ONLY to mailpit (getOtpForEmail) with default timeout 20_000", async () => {
    mailpitMock.mockResolvedValueOnce("123456");
    const { getOtp } = await import("@/e2e/helpers/otp");
    const code = await getOtp("login", "x@y.z");
    expect(code).toBe("123456");
    expect(mailpitMock).toHaveBeenCalledTimes(1);
    expect(mailpitMock).toHaveBeenCalledWith("x@y.z", 20_000);
    expect(imapMock).not.toHaveBeenCalled();
  });

  it("flow=verify routes ONLY to Gmail IMAP (getLatestOtp) with { maxWaitMs: 20_000 }", async () => {
    imapMock.mockResolvedValueOnce("654321");
    const { getOtp } = await import("@/e2e/helpers/otp");
    const code = await getOtp("verify", "x@y.z");
    expect(code).toBe("654321");
    expect(imapMock).toHaveBeenCalledTimes(1);
    expect(imapMock).toHaveBeenCalledWith("x@y.z", { maxWaitMs: 20_000 });
    expect(mailpitMock).not.toHaveBeenCalled();
  });

  it("unknown flow throws with a crisp diagnostic message", async () => {
    const { getOtp } = await import("@/e2e/helpers/otp");
    await expect(
      // @ts-expect-error — intentionally invalid flow
      getOtp("bogus", "x@y.z"),
    ).rejects.toThrow(/unknown flow/);
    await expect(
      // @ts-expect-error — intentionally invalid flow
      getOtp("bogus", "x@y.z"),
    ).rejects.toThrow(/Supabase.*Mailpit/);
    await expect(
      // @ts-expect-error — intentionally invalid flow
      getOtp("bogus", "x@y.z"),
    ).rejects.toThrow(/Resend.*Gmail/);
    expect(mailpitMock).not.toHaveBeenCalled();
    expect(imapMock).not.toHaveBeenCalled();
  });
});

describe("UT-16: timeout ceiling + error re-throw (AC-19, AC-20)", () => {
  beforeEach(() => {
    mailpitMock.mockReset();
    imapMock.mockReset();
  });

  it("passes explicit timeoutMs down to mailpit verbatim", async () => {
    mailpitMock.mockResolvedValueOnce("111111");
    const { getOtp } = await import("@/e2e/helpers/otp");
    await getOtp("login", "x@y.z", { timeoutMs: 5_000 });
    expect(mailpitMock).toHaveBeenCalledWith("x@y.z", 5_000);
  });

  it("passes explicit timeoutMs down to Gmail IMAP as { maxWaitMs }", async () => {
    imapMock.mockResolvedValueOnce("222222");
    const { getOtp } = await import("@/e2e/helpers/otp");
    await getOtp("verify", "x@y.z", { timeoutMs: 7_000 });
    expect(imapMock).toHaveBeenCalledWith("x@y.z", { maxWaitMs: 7_000 });
  });

  it("facade passes values through even above the 20s ceiling (lint/review is the ceiling gate)", async () => {
    mailpitMock.mockResolvedValueOnce("333333");
    const { getOtp } = await import("@/e2e/helpers/otp");
    await getOtp("login", "x@y.z", { timeoutMs: 100_000 });
    expect(mailpitMock).toHaveBeenCalledWith("x@y.z", 100_000);
  });

  it("Mailpit timeout error re-throws unchanged through the facade", async () => {
    const timeoutErr = new Error("No OTP email received for x@y.z within 3000ms");
    mailpitMock.mockRejectedValueOnce(timeoutErr);
    const { getOtp } = await import("@/e2e/helpers/otp");
    await expect(getOtp("login", "x@y.z", { timeoutMs: 3_000 })).rejects.toBe(timeoutErr);
  });

  it("Gmail IMAP OtpTimeoutError re-throws unchanged through the facade", async () => {
    const { OtpTimeoutError } = await import("@/e2e/helpers/otp");
    const timeoutErr = new OtpTimeoutError("IMAP polling hit maxWaitMs=3000");
    imapMock.mockRejectedValueOnce(timeoutErr);
    const { getOtp } = await import("@/e2e/helpers/otp");
    await expect(getOtp("verify", "x@y.z", { timeoutMs: 3_000 })).rejects.toBe(timeoutErr);
    expect(timeoutErr).toBeInstanceOf(OtpTimeoutError);
  });
});
