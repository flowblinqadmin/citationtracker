// ES-090 LT6 — verify flow post-MED-4.
// 20 VUs × 60s real OTP + verify. p95 verify ≤ baseline+50ms; cookie set rate
// 100%; no body leak of accessToken.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

export const options = {
  scenarios: {
    verify_flow: {
      executor: "constant-vus",
      vus: 20,
      duration: "60s",
    },
  },
  thresholds: {
    "http_req_duration{name:verify}": ["p(95) < 1500"], // adjust against baseline at PR time
    "checks{check:cookie_set}": ["rate == 1"],
    "checks{check:no_body_token_leak}": ["rate == 1"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const SITE_ID = __ENV.TEST_SITE_ID;
if (!SITE_ID) throw new Error("LT6 requires TEST_SITE_ID");

const cookieSetCount = new Counter("cookie_set_count");

export default function () {
  // 1. Send OTP (idempotent for the test site).
  http.post(`${BASE}/api/sites/${SITE_ID}/auth`, JSON.stringify({ email: __ENV.TEST_EMAIL || "lt6@example.test" }), {
    headers: { "content-type": "application/json" },
  });
  // 2. Verify with a known test code (test fixture pre-seeds verificationCode).
  const verifyRes = http.post(
    `${BASE}/api/sites/${SITE_ID}/verify`,
    JSON.stringify({ code: __ENV.TEST_OTP || "123456" }),
    { headers: { "content-type": "application/json" }, tags: { name: "verify" } },
  );

  const setCookie = verifyRes.headers["Set-Cookie"] ?? "";
  if (setCookie.indexOf("flowblinq_site_token=") !== -1) cookieSetCount.add(1);

  let bodyText = "";
  try { bodyText = verifyRes.body; } catch { /* binary */ }

  check(verifyRes, {
    cookie_set: () => setCookie.indexOf("flowblinq_site_token=") !== -1 && /HttpOnly/i.test(setCookie),
    no_body_token_leak: () => bodyText.indexOf("\"accessToken\"") === -1,
  });
}
