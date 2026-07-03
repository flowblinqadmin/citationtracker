// Local dry-run for the pipeline-health monitoring code.
//
// Runs the three check functions against the configured DB + provider APIs
// and prints what WOULD have been alerted, without sending emails or writing
// dedupe rows. Use this to verify the monitoring catches the current
// known-broken state before deploying.
//
// Usage:  npx tsx --env-file=.env.prod scripts/pipeline-health-dryrun.ts
//   (or set DATABASE_URL + provider keys + RESEND_API_KEY in the env)

import { checkProviders, checkStuckAudits, checkAllQuiet } from "@/lib/services/pipeline-health";

async function main() {
  console.log("─".repeat(72));
  console.log("Pipeline health — DRY RUN (no emails, no DB writes)");
  console.log("─".repeat(72));

  console.log("\n[1/3] Provider probe …");
  const providers = await checkProviders();
  for (const r of providers.results) {
    const tag = r.ok ? "✓" : "✗";
    const status = r.status ? ` (HTTP ${r.status})` : "";
    const err = r.error ? ` — ${r.error.slice(0, 80)}` : "";
    console.log(`  ${tag} ${r.name}${status}${err}`);
  }
  console.log(`  would-alert: ${providers.events.length}`);

  console.log("\n[2/3] Stuck audits …");
  const stuck = await checkStuckAudits();
  console.log(`  found ${stuck.stuck.length} stuck site(s) in the [30 min, 7 day] window`);
  for (const s of stuck.stuck.slice(0, 20)) {
    const ageMin = Math.round((Date.now() - s.createdAt.getTime()) / 60000);
    console.log(`  • ${s.domain.padEnd(36)} ${s.siteId}  (${ageMin} min old)`);
  }
  if (stuck.stuck.length > 20) console.log(`  …and ${stuck.stuck.length - 20} more`);
  console.log(`  would-alert: ${stuck.events.length}`);

  console.log("\n[3/3] All-quiet detector …");
  const quiet = await checkAllQuiet();
  console.log(`  allQuiet: ${quiet.allQuiet}`);
  console.log(`  lastScoreAt: ${quiet.lastScoreAt ? new Date(quiet.lastScoreAt).toISOString() : "never"}`);
  console.log(`  would-alert: ${quiet.events.length}`);

  console.log("\n" + "─".repeat(72));
  const total = providers.events.length + stuck.events.length + quiet.events.length;
  console.log(`TOTAL would-alert events: ${total}`);
  console.log("─".repeat(72));
}

main().catch((err) => {
  console.error("dryrun failed:", err);
  process.exit(1);
});
