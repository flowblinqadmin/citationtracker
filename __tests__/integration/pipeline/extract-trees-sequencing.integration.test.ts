/**
 * ES-084 ScriptDev Phase 1 — sequencing regression guard + AC-3 catch wiring.
 *
 * Per ES-084 SpecMaster recon: the primary "fix" (extract-trees enqueued
 * AFTER merge-crawl) is already in the current code at line 469. ES-084
 * becomes a regression guard. This file:
 *   - IT1 + IT4: scan-based assertion that exactly ONE
 *     `enqueueStage({ stage: "extract-trees" })` call site exists, inside
 *     `handleMergeCrawl` (regression guard for AC-1, AC-9)
 *   - IT5: AC-3 — handleExtractTrees catch wires tree_extraction_failed_at
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STAGE_ROUTE_PATH = resolve(__dirname, "..", "..", "..", "app", "api", "pipeline", "stage", "route.ts");

describe("ES-084 — extract-trees sequencing regression guard", () => {
  const stageRouteSource = readFileSync(STAGE_ROUTE_PATH, "utf-8");

  it("IT1 / IT4 — exactly ONE enqueueStage({ stage: 'extract-trees' }) call site exists", () => {
    // Count occurrences of `stage: "extract-trees"` inside enqueueStage calls.
    // The match guards against future contributors adding a second call site
    // that would re-introduce the original timing race premise.
    const matches = stageRouteSource.match(/enqueueStage\(\{[^}]*stage:\s*["']extract-trees["']/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("IT2 — extract-trees enqueueStage call lives inside handleMergeCrawl scope", () => {
    // Find the index of handleMergeCrawl declaration and the next sibling
    // function declaration. The enqueueStage extract-trees line must fall
    // within that range.
    const mergeStart = stageRouteSource.indexOf("async function handleMergeCrawl(");
    expect(mergeStart).toBeGreaterThan(0);

    // Find the next async function declaration after handleMergeCrawl
    const nextFnFromMerge = stageRouteSource.indexOf("async function ", mergeStart + 1);
    expect(nextFnFromMerge).toBeGreaterThan(mergeStart);

    const enqueueIdx = stageRouteSource.indexOf('stage: "extract-trees"', mergeStart);
    expect(enqueueIdx).toBeGreaterThan(mergeStart);
    expect(enqueueIdx).toBeLessThan(nextFnFromMerge);
  });

  it("IT3 — handleExtractTrees reads site.crawlData (not chunk-level data)", () => {
    const handleStart = stageRouteSource.indexOf("async function handleExtractTrees(");
    expect(handleStart).toBeGreaterThan(0);
    const handleEnd = stageRouteSource.indexOf("async function ", handleStart + 1);
    const handleBody = stageRouteSource.slice(handleStart, handleEnd);
    // The body should reference site.crawlData (the merged final result),
    // NOT site.crawlChunkResults or any per-chunk slice.
    expect(handleBody).toContain("site.crawlData");
    expect(handleBody).not.toContain("crawlChunkResults");
  });

  it("IT5 (AC-3) — handleExtractTrees catch block writes tree_extraction_failed_at", () => {
    const handleStart = stageRouteSource.indexOf("async function handleExtractTrees(");
    const handleEnd = stageRouteSource.indexOf("async function ", handleStart + 1);
    const handleBody = stageRouteSource.slice(handleStart, handleEnd);
    // The catch block must write the failure timestamp.
    expect(handleBody).toContain("treeExtractionFailedAt");
    // The catch must re-throw so the outer stage retry / markFailed logic fires.
    // Look for `throw err` after the catch block start. Multiline tolerant.
    expect(handleBody).toMatch(/catch \(err\)/);
    expect(handleBody).toMatch(/throw err/);
  });
});
