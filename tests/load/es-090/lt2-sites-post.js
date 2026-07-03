// ES-090 LT2 — sites-POST IP rate limit defence.
// 100 VUs × 60s same IP single-audit. ≥10 pass per 60s window; rest 429.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

export const options = {
  scenarios: {
    flood: {
      executor: "constant-vus",
      vus: 100,
      duration: "60s",
    },
  },
  thresholds: {
    "checks{check:status_in_set}": ["rate >= 0.99"],
    // The number of 200s should be bounded ≈ 10 — k6 cannot threshold a
    // strict equality, so we cap at 60 (≈ headroom across two 60s windows
    // with timing slop).
    "status_200": ["count <= 60"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const IP = __ENV.TEST_BULK_IP || "203.0.113.50";

const status200 = new Counter("status_200");
const status429 = new Counter("status_429");

export default function () {
  const url = `${BASE}/api/sites`;
  const payload = JSON.stringify({
    url: `https://lt2-${__VU}-${__ITER}.example.test`,
    email: `lt2+${__VU}@example.test`,
  });
  const res = http.post(url, payload, {
    headers: { "x-forwarded-for": IP, "content-type": "application/json" },
  });
  if (res.status === 200) status200.add(1);
  if (res.status === 429) status429.add(1);
  check(res, { status_in_set: (r) => r.status === 200 || r.status === 429 });
}
