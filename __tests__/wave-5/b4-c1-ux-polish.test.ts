/**
 * ES-wave-5 §B4 + §C1 — UX polish source contracts.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const REGEN_ROUTE = fs.readFileSync(path.resolve(ROOT, "app/api/sites/[id]/regenerate/route.ts"), "utf8");
const ROW_ACTIONS = fs.readFileSync(path.resolve(ROOT, "app/dashboard/RowActions.tsx"), "utf8");
const SITE_CLIENT = fs.readFileSync(path.resolve(ROOT, "app/sites/[id]/SitePageClient.tsx"), "utf8");
const DOMAIN_ROW = fs.readFileSync(path.resolve(ROOT, "app/dashboard/DomainTableRow.tsx"), "utf8");

describe("B4 — regenerate response code = 202", () => {
  it("AC-B4-1/2: every success branch returns 202", () => {
    // Pro-paid + free-rotation success branches both end with `status: 202`.
    const success202 = REGEN_ROUTE.match(/success:\s*true[\s\S]{1,500}status:\s*202/g) ?? [];
    expect(success202.length).toBeGreaterThanOrEqual(2);
  });

  it("AC-B4-4 grep guard: no NextResponse.json(...{ status: 200 }) in regenerate route", () => {
    expect(REGEN_ROUTE).not.toMatch(/status:\s*200\b/);
  });

  it("AC-B4-3: RowActions handleRerunAudit treats 202 as success (onScanStart + router.refresh)", () => {
    expect(ROW_ACTIONS).toMatch(/res\.status\s*===\s*202/);
    expect(ROW_ACTIONS).toMatch(/onScanStart\?\.\(\);\s*router\.refresh\(\);/);
  });

  it("AC-B4-5 grep guard: every regenerate caller treats 202 as success", () => {
    // Currently 2 callers: RowActions + SitePageClient handleRefreshScore.
    // Both must check `res.status === 202` (success guard).
    expect(ROW_ACTIONS).toMatch(/regenerate.*?token=.*?method.*?POST/s);
    expect(SITE_CLIENT).toMatch(/regenerate\?token=/);
    expect(SITE_CLIENT).toMatch(/res\.status\s*===\s*202/);
  });
});

describe("C1 — optimistic polling state machine + 30s safety", () => {
  it("AC-C1-1: polling effect early-returns when neither liveStatus active nor isOptimisticScan", () => {
    expect(DOMAIN_ROW).toMatch(/if \(!isActiveStatus\(liveStatus\) && !isOptimisticScan\) return;/);
  });

  it("AC-C1-3: terminal status observed by polling resets isOptimisticScan + router.refresh", () => {
    expect(DOMAIN_ROW).toMatch(/!isActiveStatus\(data\.pipelineStatus\)[\s\S]{0,200}setIsOptimisticScan\(false\);[\s\S]{0,80}router\.refresh\(\);/);
  });

  it("AC-C1-4: 30s safety useEffect with setTimeout 30_000 + cleanup", () => {
    expect(DOMAIN_ROW).toMatch(/AC-C1-4/);
    expect(DOMAIN_ROW).toMatch(/setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,200}setIsOptimisticScan\(false\);[\s\S]{0,80}router\.refresh\(\);[\s\S]{0,40}\},\s*30_000\)/);
    // Cleanup branch returns clearTimeout(t).
    expect(DOMAIN_ROW).toMatch(/return\s*\(\)\s*=>\s*clearTimeout\(t\)/);
  });

  it("AC-C1-5: state machine call-site count guard — no rogue setIsOptimisticScan sites", () => {
    expect(DOMAIN_ROW).toMatch(/AC-C1-5/);
    const trueSites = [...DOMAIN_ROW.matchAll(/setIsOptimisticScan\(true\)/g)].length;
    const falseSites = [...DOMAIN_ROW.matchAll(/setIsOptimisticScan\(false\)/g)].length;
    // false→true: RowActions onScanStart wiring + the in-row Re-run button's
    // own 202 success branch — both are the same semantic (a) transition.
    expect(trueSites).toBe(2);
    // true→false: polling-observes-terminal + AC-C1-4 30s safety + auth-failure
    // 401 handler (transition (d), added after the May-2026 polling-storm fix).
    expect(falseSites).toBe(3);
  });
});
