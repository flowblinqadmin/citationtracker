// ES-090 LT5 — /api/health sustained.
// 10 rps × 10 min. p99 < 50ms; 0% error; DB pool not exhausted.
import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    sustained: {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "10m",
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
  },
  thresholds: {
    "http_req_duration": ["p(99) < 50"],
    "http_req_failed": ["rate == 0"],
    "checks{check:db_ok}": ["rate == 1"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const res = http.get(`${BASE}/api/health`);
  check(res, {
    status_200: (r) => r.status === 200,
    db_ok: (r) => {
      try { return r.json("db") === "ok"; } catch { return false; }
    },
  });
}
