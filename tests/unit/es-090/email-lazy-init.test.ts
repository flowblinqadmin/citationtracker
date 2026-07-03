/**
 * ES-090 HP-218 — lib/email.ts lazy Resend init.
 *
 * Seals CoFounder brief #9: `new Resend(process.env.RESEND_API_KEY!)` at
 * module top-level crashes on import whenever RESEND_API_KEY is unset —
 * which is the Phase A unit-test default. This blocked ~5 Phase A tests at
 * import time rather than at the spec-driven assertion.
 *
 * Expected ScriptDev fix pattern: lazy getter.
 *
 *   let _resend: Resend | null = null;
 *   function getResend(): Resend {
 *     if (!_resend) _resend = new Resend(requireEnv("RESEND_API_KEY"));
 *     return _resend;
 *   }
 *
 * Tests assert:
 *   (a) `import("@/lib/email")` resolves without RESEND_API_KEY (no throw).
 *   (b) The Resend constructor is NOT invoked on module import; it IS
 *       invoked exactly once on first send-call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ORIGINAL_KEY = process.env.RESEND_API_KEY;
const ORIGINAL_SENDGRID = process.env.SENDGRID_API_KEY;

const { resendCtorSpy } = vi.hoisted(() => {
  const resendCtorSpy = vi.fn();
  return { resendCtorSpy };
});

vi.mock("resend", () => {
  class Resend {
    constructor(key: string) {
      resendCtorSpy(key);
    }
    emails = {
      send: vi.fn().mockResolvedValue({ id: "mock-email-id" }),
    };
  }
  return { Resend };
});

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.SENDGRID_API_KEY;
  resendCtorSpy.mockClear();
  // Bust ESM cache — each test imports a fresh module instance.
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_SENDGRID === undefined) delete process.env.SENDGRID_API_KEY;
  else process.env.SENDGRID_API_KEY = ORIGINAL_SENDGRID;
});

describe("ES-090 HP-218 — lib/email lazy Resend init", () => {
  it("(a) import('@/lib/email') resolves without RESEND_API_KEY set (no throw at module-load)", async () => {
    await expect(import("@/lib/email?hp218-a")).resolves.toBeDefined();
    // Critical assertion: ctor NOT invoked as a side-effect of import.
    expect(resendCtorSpy, "Resend constructor must NOT run at module-load time").not.toHaveBeenCalled();
  });

  it("(b) first send-call instantiates Resend exactly once; second call reuses the instance", async () => {
    // Set the key only for this test so the send path can actually run.
    process.env.RESEND_API_KEY = "re_test_key_for_hp218";
    const mod = await import("@/lib/email?hp218-b") as Record<string, unknown>;

    // Before any send-call, the ctor must not have been invoked.
    expect(resendCtorSpy).not.toHaveBeenCalled();

    // Pick whichever send-* function exists as the first public entry point.
    type SendFn = (...args: unknown[]) => Promise<unknown>;
    const send =
      (mod.sendVerificationEmail as SendFn | undefined) ??
      (mod.sendCompletionEmail as SendFn | undefined) ??
      (mod.sendLowCreditsEmail as SendFn | undefined) ??
      (mod.sendEmail as SendFn | undefined);
    expect(send, "lib/email must export at least one send-* function").toBeDefined();

    // Call it twice — try/catch because the function may require specific args
    // shape that we don't mirror exhaustively. The assertion is on the Resend
    // ctor invocation count, not the send return value.
    try { await send!("a@b.test", "code-123"); } catch { /* ignore */ }
    try { await send!("a@b.test", "code-456"); } catch { /* ignore */ }

    expect(resendCtorSpy, "Resend constructor must be invoked exactly once across two send-calls")
      .toHaveBeenCalledTimes(1);
  });
});
