// Architecture gate: tracker.* tables may only be touched via lib/tracker-db.ts.
// PCG's live data shares those tables — a stray import is a data-isolation bug.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TRACKER_EXPORTS = /\btracker(Orgs|Clients|Prompts|PromptVersions|Runs|Responses|Citations|Schema)\b/;
const ALLOWED = new Set(["lib/tracker-db.ts", "lib/db/schema.ts"]);

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
      .filter((f) => TRACKER_EXPORTS.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
