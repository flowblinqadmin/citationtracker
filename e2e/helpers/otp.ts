/**
 * e2e/helpers/otp.ts — unified OTP facade per ES-e2e-fixtures §b.14.
 *
 * Two OTP flows, two inboxes (§b.14):
 *   - login  → Supabase Auth mailer → Mailpit @ 127.0.0.1:54324
 *   - verify → lib/email.ts → Resend → Gmail IMAP
 *
 * Specs call `getOtp(flow, email, opts?)`; the facade routes to the right
 * helper. The `OtpFlow` enum is type-narrowed with an exhaustive switch so
 * a new flow added without a matching case is a compile error.
 *
 * Default timeout is 20s (§b.14.3). Specs may LOWER but MUST NOT raise
 * that bound; the facade passes whatever is given through to the
 * underlying helper without coercion.
 */

import { getOtpForEmail } from "./mailpit";
import { getLatestOtp } from "../fixtures/otp-helper";

export type OtpFlow = "login" | "verify";

export interface GetOtpOptions {
  /** Max wait in ms. Default 20_000 (§b.14.3 ceiling). */
  timeoutMs?: number;
}

export async function getOtp(
  flow: OtpFlow,
  email: string,
  opts: GetOtpOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  switch (flow) {
    case "login":
      return getOtpForEmail(email, timeoutMs);
    case "verify":
      return getLatestOtp(email, { maxWaitMs: timeoutMs });
    default: {
      const never: never = flow;
      throw new Error(
        `getOtp: unknown flow "${String(never)}". Expected "login" (Supabase→Mailpit) ` +
          `or "verify" (lib/email.ts→Resend→Gmail). See ES-e2e-fixtures §b.14.`,
      );
    }
  }
}

export { OtpTimeoutError } from "../fixtures/otp-helper";
