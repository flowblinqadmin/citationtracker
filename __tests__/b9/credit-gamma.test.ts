/**
 * ES-B9 §credit AC-B9-10 — γ free-retry policy + bulk_retry_failed_free ledger.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROUTE = fs.readFileSync(
  path.resolve(process.cwd(), "app/api/sites/[id]/retry-failed/route.ts"),
  "utf8",
);
const SCHEMA = fs.readFileSync(
  path.resolve(process.cwd(), "lib/db/schema.ts"),
  "utf8",
);
const MIGRATION_DIR = path.resolve(process.cwd(), "lib/db/migrations");
const MIGRATIONS = fs.readdirSync(MIGRATION_DIR);

describe("AC-B9-10 — γ free-retry policy", () => {
  it("isFreeRetry branch fires when site.pipelineStatus === 'failed'", () => {
    expect(ROUTE).toMatch(/AC-B9-10/);
    expect(ROUTE).toMatch(/const isFreeRetry\s*=\s*site\.pipelineStatus\s*===\s*"failed"/);
  });

  it("γ path: charge=0 (creditsChanged: 0), no balance mutation, ledger row written", () => {
    // The transaction's free-retry branch inserts the ledger but does NOT
    // call tx.update(teams).set creditBalance.
    const freeBranch = ROUTE.match(/if \(isFreeRetry\) \{[\s\S]*?\} else \{/);
    expect(freeBranch).toBeTruthy();
    const block = freeBranch![0];
    expect(block).toMatch(/creditsChanged:\s*0/);
    expect(block).toMatch(/type:\s*"bulk_retry_failed_free"/);
    expect(block).toMatch(/parentSiteId:\s*id/);
    // No balance mutation in the free branch.
    expect(block).not.toMatch(/tx\.update\(teams\)\s*[\s\S]{0,200}creditBalance/);
  });

  it("ledger row carries balanceBefore = balanceAfter (unchanged)", () => {
    const freeBranch = ROUTE.match(/if \(isFreeRetry\) \{[\s\S]*?\} else \{/);
    expect(freeBranch).toBeTruthy();
    expect(freeBranch![0]).toMatch(/balanceAfter:\s*balanceBefore/);
  });

  it("α path preserved: complete-with-failures still charges via bulk_crawl_reserve", () => {
    // The α (else) branch contains the bulk_crawl_reserve insert + the team
    // balance deduction. Source-grep both signatures inside the route file.
    expect(ROUTE).toMatch(/type:\s*"bulk_crawl_reserve"/);
    expect(ROUTE).toMatch(/creditsChanged:\s*-reservedCredits/);
    expect(ROUTE).toMatch(/tx\.update\(teams\)\s*\n?\s*\.set\(\{\s*creditBalance:\s*sql`\$\{teams\.creditBalance\} - \$\{reservedCredits\}/);
  });

  it("crawlLimitVal on γ path = urlsToRetry.length (no balance gating)", () => {
    expect(ROUTE).toMatch(/crawlLimitVal\s*=\s*isFreeRetry\s*\?\s*urlsToRetry\.length\s*:\s*effectiveCrawlLimit/);
  });

  it("reservedCredits on γ path = 0", () => {
    expect(ROUTE).toMatch(/reservedCredits\s*=\s*isFreeRetry\s*\?\s*0\s*:\s*bulkCreditsRequired/);
  });

  it("γ path skips the 402 'Insufficient credits' gate (urlsToRetry.length>0 satisfies crawlLimitVal>0)", () => {
    // With isFreeRetry=true, crawlLimitVal = urlsToRetry.length. The route's
    // existing check `if (crawlLimitVal === 0)` only fires when urlsToRetry
    // is empty — which is already trapped by the earlier "No failed URLs"
    // 400 at line 144. Confirm the gate still references crawlLimitVal so
    // the α path's "team has zero affordable pages" failure mode still
    // bites for status='complete'.
    expect(ROUTE).toMatch(/if \(crawlLimitVal === 0\)/);
    expect(ROUTE).toMatch(/Insufficient credits\. Please top up before retrying/);
  });
});

describe("Schema + migration — credit_transactions.parent_site_id", () => {
  it("schema.ts declares parentSiteId column", () => {
    expect(SCHEMA).toMatch(/parentSiteId:\s*text\("parent_site_id"\)/);
    // The type column comment now references the new bulk_retry_failed_free
    // type for documentation continuity.
    expect(SCHEMA).toMatch(/bulk_retry_failed_free/);
  });

  it("migration file exists with idempotent ADD COLUMN IF NOT EXISTS + index", () => {
    const m = MIGRATIONS.find((f) => f.endsWith("credit-tx-parent-site-id.sql"));
    expect(m).toBeTruthy();
    const sql = fs.readFileSync(path.join(MIGRATION_DIR, m!), "utf8");
    expect(sql).toMatch(/ALTER TABLE credit_transactions[\s\S]{0,80}ADD COLUMN IF NOT EXISTS parent_site_id text/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS credit_transactions_parent_site_idx[\s\S]{0,200}WHERE parent_site_id IS NOT NULL/);
  });

  it("schema-change verdict: NEEDED — new column for parent_site_id", () => {
    // This test simply documents the verdict the dispatch reporter consumes.
    // The migration file's existence is the implementation artifact.
    const m = MIGRATIONS.find((f) => f.endsWith("credit-tx-parent-site-id.sql"));
    expect(m).toBeTruthy();
  });
});

describe("Idempotency — retry-of-retry doesn't double-charge / double-credit", () => {
  it("retry of a retry-spawned site (auditMode='bulk', pipelineStatus='complete', no failedUrls) → 400", () => {
    // The pre-existing AC-B9-2 gate (No failed URLs to retry) traps this
    // case before any ledger write, so retry-of-retry can't double-charge
    // via this route. Asserting via source — the empty-candidate guard
    // remains intact.
    expect(ROUTE).toMatch(/if \(urlsToRetry\.length === 0\)[\s\S]{0,80}status:\s*400/);
    expect(ROUTE).toMatch(/No failed URLs to retry/);
  });

  it("retry-of-retry with status='failed' (the new γ branch) inserts only one free-retry ledger per request", () => {
    // The γ branch's INSERT lives inside a single tx — no loop, no upsert
    // pattern that could double-write. One request → one ledger row.
    const freeBranch = ROUTE.match(/if \(isFreeRetry\) \{[\s\S]*?\} else \{/);
    expect(freeBranch).toBeTruthy();
    const inserts = (freeBranch![0].match(/tx\.insert\(creditTransactions\)/g) ?? []).length;
    expect(inserts).toBe(1);
  });
});
