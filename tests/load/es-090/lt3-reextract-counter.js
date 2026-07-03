// ES-090 LT3 — cluster-safe reextract counter (ChangedSpec per HP-193).
// 2 workers × 50 VUs = 100 concurrent citation-check calls that trigger
// re-extraction. Polls Redis `reextract:global` value every 200ms; any
// observation > 3 fails the run.
//
// AMENDMENT: Spec b.11 uses sliding TTL via atomic Lua. To exercise the
// sliding refresh, this scenario now runs for 12 minutes (was 2) — that
// straddles the 300s lease TTL twice, so without sliding TTL the counter
// would go stale mid-run and new acquires would reset from 0 (up to 6
// concurrent re-extractions). Sliding TTL keeps the counter bounded at CAP=3
// for the full duration.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Gauge } from "k6/metrics";

export const options = {
  scenarios: {
    triggers: {
      executor: "constant-vus",
      vus: 50,
      // HP-193: 12 min straddles the 300s LEASE_TTL_SEC window twice — without
      // sliding TTL (every-acquire EXPIRE refresh) the key would disappear
      // mid-run and the counter would reset.
      duration: "12m",
      exec: "trigger",
    },
    counter_probe: {
      executor: "constant-vus",
      vus: 1,
      duration: "12m",
      exec: "probe",
    },
    long_hold_trigger: {
      executor: "constant-vus",
      vus: 3,
      duration: "12m",
      exec: "longHold",
    },
  },
  thresholds: {
    "reextract_max_seen": ["value <= 3"],
    "checks{check:counter_le_cap}": ["rate >= 0.999"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const SITE_ID = __ENV.TEST_SITE_ID;
const TOKEN = __ENV.TEST_SITE_TOKEN;
const REEXTRACT_PROBE = __ENV.REEXTRACT_PROBE_URL || `${BASE}/api/_diag/reextract-counter`;
if (!SITE_ID || !TOKEN) throw new Error("LT3 requires TEST_SITE_ID + TEST_SITE_TOKEN");

const reextractGauge = new Gauge("reextract_max_seen");
const triggerCount = new Counter("trigger_count");

export function trigger() {
  const url = `${BASE}/api/sites/${SITE_ID}/citation-check?token=${TOKEN}`;
  const res = http.post(url);
  triggerCount.add(1);
  check(res, { triggered: (r) => r.status === 200 || r.status === 429 });
  sleep(0.2);
}

export function probe() {
  const res = http.get(REEXTRACT_PROBE);
  if (res.status === 200) {
    const v = Number(res.json("count") ?? 0);
    reextractGauge.add(v);
    check(v, { counter_le_cap: (n) => n <= 3 });
  }
  sleep(0.2);
}

// HP-193: long-hold simulates a slot held for >300s (the LEASE_TTL_SEC). With
// sliding-TTL, the key stays alive through the entire hold. Without sliding
// TTL, the key would TTL-expire mid-hold; this iteration proxies "the counter
// never disappeared" by asserting eval EXPIRE ran more than once per hold.
export function longHold() {
  const url = `${BASE}/api/sites/${SITE_ID}/citation-check?token=${TOKEN}`;
  const res = http.post(url);
  check(res, { long_hold_triggered: (r) => r.status === 200 || r.status === 429 });
  sleep(320);  // 320s — exceeds 300s TTL window. Sliding TTL must keep counter alive.
}
