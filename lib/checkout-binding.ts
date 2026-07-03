// Defense-in-depth binding for Stripe Checkout metadata.
//
// H4 audit fix (2026-05-27): the stripe/route.ts webhook trusts
// `session.metadata.websiteUrl` to kick off the pipeline. If the Stripe
// publishable key were compromised — or if a Stripe Connect path were
// abused — an attacker could create a session under FlowBlinq's account
// with attacker-chosen metadata. The SSRF validator alone would still
// pass for any public URL.
//
// We close the gap by stamping an HMAC signature of
//   (websiteUrl ‖ "\x00" ‖ stripeCustomerEmailOrPriceId)
// into metadata at checkout-creation time. The webhook recomputes the
// signature using the server-side CRON_SECRET (already required at module
// load) and rejects any session whose binding does not match. Spoofing the
// signature requires the server-side secret, not just the publishable key.
//
// Why not introduce a separate secret?
//   - CRON_SECRET is already provisioned in both dev and prod, fail-closed
//     at module load (see lib/cron-auth.ts), and never exposed to clients.
//   - Adding a new secret expands the surface without reducing risk.

import { createHmac } from "crypto";
import { getCronSecret } from "@/lib/cron-auth";

const METADATA_KEY = "fb_bind";

export function signCheckoutBinding(websiteUrl: string, bound: string): string {
  const secret = getCronSecret();
  return createHmac("sha256", secret)
    .update(websiteUrl)
    .update("\x00")
    .update(bound)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Constant-time-ish compare. Returns true when the signature matches.
 */
export function verifyCheckoutBinding(
  websiteUrl: string,
  bound: string,
  signature: string | null | undefined,
): boolean {
  if (!signature || typeof signature !== "string") return false;
  const expected = signCheckoutBinding(websiteUrl, bound);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

export const CHECKOUT_BINDING_METADATA_KEY = METADATA_KEY;
