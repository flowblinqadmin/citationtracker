/**
 * e2e/helpers/stripe-webhook.ts
 *
 * Sends a Stripe-signed webhook event to the local dev server.
 * Matches exactly what stripe.webhooks.constructEvent() expects:
 *   - body   = the exact JSON string that was signed
 *   - header = "t=<unix>,v1=<HMAC_SHA256(t + "." + body, secret)>"
 *
 * CRITICAL: constructEvent verifies the signature against the EXACT raw body.
 * Do NOT re-serialize between signing and posting.
 */

import { createHmac } from "crypto";

export interface WebhookResult {
  status: number;
  json: unknown;
}

export async function postSignedStripeEvent(
  baseURL: string,
  event: Record<string, unknown>,
  secret: string,
): Promise<WebhookResult> {
  const body = JSON.stringify(event);
  const nowSec = Math.floor(Date.now() / 1000).toString();
  const signed = `${nowSec}.${body}`;
  const hmac = createHmac("sha256", secret).update(signed).digest("hex");
  const sig = `t=${nowSec},v1=${hmac}`;

  const url = `${baseURL}/api/webhooks/stripe`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": sig,
    },
    body,
  });

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    json = {};
  }

  return { status: resp.status, json };
}
