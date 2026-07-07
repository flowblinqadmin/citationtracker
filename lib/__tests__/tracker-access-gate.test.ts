// Architecture gate: tracker.* tables may only be touched via lib/tracker-db.ts.
// PCG's live data shares those tables — a stray import is a data-isolation bug.
//
// lib/engine/** is exempt: it is the ported run-execution engine, invoked only
// by machine-authenticated routes (worker/cron) with run/client ids that were
// already org-scoped at creation time by tracker-db. It never resolves tenancy
// from user input. Everything else (app/, rest of lib/) stays gated.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TRACKER_EXPORTS = /\btracker(Orgs|Clients|Prompts|PromptVersions|Runs|Responses|Citations|Articles|Schema)\b/;
const ALLOWED = new Set(["lib/tracker-db.ts", "lib/db/schema.ts"]);
const ALLOWED_DIRS = ["lib/engine/"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe("tracker table access gate", () => {
  it("no file outside lib/tracker-db.ts references tracker tables", () => {
    const offenders = [...walk("app"), ...walk("lib")]
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => !ALLOWED_DIRS.some((dir) => f.startsWith(dir)))
      .filter((f) => TRACKER_EXPORTS.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
