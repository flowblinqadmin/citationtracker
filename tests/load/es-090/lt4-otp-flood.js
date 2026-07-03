// ES-090 LT4 — OTP lockout under flood.
// 50 VUs × 30s wrong-OTP submits same siteId. ≤5 successful increments
// before lockout; otp_locked_until set within 15-minute window.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

export const options = {
  scenarios: {
    flood: {
      executor: "constant-vus",
      vus: 50,
      duration: "30s",
    },
  },
  thresholds: {
    "otp_success_count": ["count <= 5"],
    "checks{check:expected_status}": ["rate >= 0.99"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const SITE_ID = __ENV.TEST_SITE_ID;
if (!SITE_ID) throw new Error("LT4 requires TEST_SITE_ID");

const otpSuccess = new Counter("otp_success_count");
const otpLocked = new Counter("otp_locked_count");

export default function () {
  const url = `${BASE}/api/sites/${SITE_ID}/verify`;
  const payload = JSON.stringify({ code: "000000" }); // intentional wrong code
  const res = http.post(url, payload, { headers: { "content-type": "application/json" } });
  if (res.status === 200) otpSuccess.add(1);
  if (res.status === 429 || res.status === 423) otpLocked.add(1);
  check(res, {
    expected_status: (r) => [200, 401, 423, 429].indexOf(r.status) !== -1,
  });
}
