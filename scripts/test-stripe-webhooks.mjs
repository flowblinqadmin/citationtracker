#!/usr/bin/env node
/**
 * Test Stripe webhook handlers locally without the Stripe CLI.
 * Constructs real HMAC-signed payloads and posts them to localhost.
 *
 * Usage:
 *   node scripts/test-stripe-webhooks.mjs [--team TEAM_ID] [--port 3000]
 *
 * What it tests:
 *   1. invoice.paid (subscription_cycle) → resets monthly_pages_used to 0
 *   2. invoice.payment_failed            → sets subscription_status to past_due
 *   3. customer.subscription.deleted     → downgrades to free
 */

import crypto from "crypto";
import postgres from "postgres";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Config ──────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");

function loadEnv() {
  const env = {};
  for (const file of [".env.local", ".env"]) {
    try {
      readFileSync(resolve(ROOT, file), "utf8")
        .split("\n")
        .filter(l => l && !l.startsWith("#") && l.includes("="))
        .forEach(l => {
          const [k, ...v] = l.split("=");
          env[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
        });
    } catch {}
  }
  return env;
}

const env = loadEnv();
const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
const DB_URL = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL ?? env.SUPABASE_DATABASE_URL ?? env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;

const args = process.argv.slice(2);
const TEAM_ID = args[args.indexOf("--team") + 1] ?? "Ff8-mlY9vIaiwfnKabBwB";
const PORT    = args[args.indexOf("--port") + 1] ?? "3000";
const BASE    = `http://localhost:${PORT}`;

if (!WEBHOOK_SECRET) { console.error("❌ STRIPE_WEBHOOK_SECRET not found in .env.local"); process.exit(1); }
if (!DB_URL)         { console.error("❌ DATABASE_URL not found in .env.local"); process.exit(1); }

const sql = postgres(DB_URL, { max: 1, prepare: false });

// ── Helpers ──────────────────────────────────────────────────────────────────

function signPayload(payload) {
  const ts = Math.floor(Date.now() / 1000);
  const signed = `${ts}.${payload}`;
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(signed).digest("hex");
  return { signature: `t=${ts},v1=${sig}`, body: payload };
}

async function postWebhook(eventType, dataObject) {
  const payload = JSON.stringify({ type: eventType, data: { object: dataObject } });
  const { signature, body } = signPayload(payload);
  const res = await fetch(`${BASE}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function pass(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); return 1; }

// ── Setup ────────────────────────────────────────────────────────────────────

console.log(`\n🔧 Setting up test team: ${TEAM_ID}`);

// Give the team a known state before each test
await sql`
  UPDATE teams SET
    stripe_subscription_id = 'sub_test_webhook_123',
    stripe_customer_id     = 'cus_test_webhook_123',
    subscription_tier      = 'starter',
    subscription_status    = 'active',
    monthly_page_allowance = 1000,
    monthly_pages_used     = 850
  WHERE id = ${TEAM_ID}
`;
const [before] = await sql`
  SELECT subscription_tier, subscription_status, monthly_pages_used, monthly_page_allowance
  FROM teams WHERE id = ${TEAM_ID}
`;
console.log(`  Before: pages_used=${before.monthly_pages_used}, status=${before.subscription_status}`);

let failures = 0;
function check(condition, pass_msg, fail_msg) {
  if (condition) { pass(pass_msg); } else { failures++; fail(fail_msg); }
}

// ── Test 1: invoice.paid resets monthly counter ──────────────────────────────

console.log("\n📋 Test 1 — invoice.paid (subscription_cycle) resets monthly_pages_used");

const { status: s1 } = await postWebhook("invoice.paid", {
  billing_reason:        "subscription_cycle",
  subscription:          "sub_test_webhook_123",
  customer_email:        "test@flowblinq.com",
  subscription_details:  { metadata: { teamId: TEAM_ID } },
});

const [after1] = await sql`
  SELECT monthly_pages_used, subscription_status, current_period_end
  FROM teams WHERE id = ${TEAM_ID}
`;

check(s1 === 200,                    `webhook returned 200`,                              `webhook returned ${s1}`);
check(after1.monthly_pages_used === 0, `monthly_pages_used reset to 0 (was 850)`,          `monthly_pages_used = ${after1.monthly_pages_used} (expected 0)`);
check(after1.subscription_status === "active", `subscription_status still active`,          `subscription_status = ${after1.subscription_status}`);
check(after1.current_period_end !== null, `current_period_end updated: ${after1.current_period_end}`, `current_period_end not set`);

// ── Test 2: invoice.payment_failed marks past_due ────────────────────────────

console.log("\n📋 Test 2 — invoice.payment_failed marks subscription past_due");

// Reset to active first
await sql`UPDATE teams SET subscription_status = 'active' WHERE id = ${TEAM_ID}`;

const { status: s2 } = await postWebhook("invoice.payment_failed", {
  subscription:         "sub_test_webhook_123",
  customer_email:       "test@flowblinq.com",
  subscription_details: { metadata: { teamId: TEAM_ID } },
});

const [after2] = await sql`SELECT subscription_status FROM teams WHERE id = ${TEAM_ID}`;

check(s2 === 200, `webhook returned 200`, `webhook returned ${s2}`);
check(after2.subscription_status === "past_due", `subscription_status = past_due`, `subscription_status = ${after2.subscription_status} (expected past_due)`);

// ── Test 3: customer.subscription.deleted downgrades to free ─────────────────

console.log("\n📋 Test 3 — customer.subscription.deleted downgrades to free");

const { status: s3 } = await postWebhook("customer.subscription.deleted", {
  id:       "sub_test_webhook_123",
  status:   "canceled",
  metadata: { teamId: TEAM_ID },
});

const [after3] = await sql`
  SELECT subscription_tier, subscription_status, stripe_subscription_id, monthly_page_allowance
  FROM teams WHERE id = ${TEAM_ID}
`;

check(s3 === 200,                          `webhook returned 200`,             `webhook returned ${s3}`);
check(after3.subscription_tier === "free", `subscription_tier downgraded to free`, `subscription_tier = ${after3.subscription_tier}`);
check(after3.subscription_status === "inactive", `subscription_status = inactive`, `subscription_status = ${after3.subscription_status}`);
check(after3.stripe_subscription_id === null, `stripe_subscription_id cleared`,   `stripe_subscription_id not cleared: ${after3.stripe_subscription_id}`);

// ── Test 4: non-cycle invoice.paid is ignored ─────────────────────────────────

console.log("\n📋 Test 4 — invoice.paid with billing_reason=manual is ignored");

await sql`UPDATE teams SET monthly_pages_used = 500 WHERE id = ${TEAM_ID}`;

const { status: s4 } = await postWebhook("invoice.paid", {
  billing_reason: "manual",
  subscription:   "sub_test_webhook_123",
});

const [after4] = await sql`SELECT monthly_pages_used FROM teams WHERE id = ${TEAM_ID}`;

check(s4 === 200, `webhook returned 200`, `webhook returned ${s4}`);
check(after4.monthly_pages_used === 500, `monthly_pages_used unchanged at 500 (non-cycle ignored)`, `monthly_pages_used changed to ${after4.monthly_pages_used} (should be unchanged)`);

// ── Restore ───────────────────────────────────────────────────────────────────

await sql`
  UPDATE teams SET
    subscription_tier      = 'pro',
    subscription_status    = 'active',
    monthly_pages_used     = 0,
    stripe_subscription_id = NULL
  WHERE id = ${TEAM_ID}
`;
console.log(`\n🔧 Team restored to pro/active`);

// ── Summary ───────────────────────────────────────────────────────────────────

await sql.end();

console.log("\n═══════════════════════════════════════");
if (failures === 0) {
  console.log(" ✅ All webhook tests passed");
} else {
  console.log(` ❌ ${failures} test(s) failed`);
}
console.log("═══════════════════════════════════════\n");

process.exit(failures > 0 ? 1 : 0);
