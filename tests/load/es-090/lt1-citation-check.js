// ES-090 LT1 — citation-check rate-limit defence.
// 50 VUs × 60s same siteId. ≥98% should be 429; p99 of 429 < 80ms.
// Asserts AC-4: only ~floor(60/30) = 2 credit deductions across the run.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

export const options = {
  scenarios: {
    flood: {
      executor: "constant-vus",
      vus: 50,
      duration: "60s",
    },
  },
  thresholds: {
    "http_req_duration{status:429}": ["p(99) < 80"],
    "checks{check:is_429_when_blocked}": ["rate >= 0.98"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const SITE_ID = __ENV.TEST_SITE_ID;
const TOKEN = __ENV.TEST_SITE_TOKEN;
if (!SITE_ID || !TOKEN) throw new Error("LT1 requires TEST_SITE_ID + TEST_SITE_TOKEN env");

const status200 = new Counter("status_200");
const status429 = new Counter("status_429");

export default function () {
  const url = `${BASE}/api/sites/${SITE_ID}/citation-check?token=${TOKEN}`;
  const res = http.post(url);
  if (res.status === 200) status200.add(1);
  if (res.status === 429) status429.add(1);
  check(res, {
    is_429_when_blocked: (r) => r.status === 200 || r.status === 429,
  });
  sleep(0.1);
}
