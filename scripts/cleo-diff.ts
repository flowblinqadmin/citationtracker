#!/usr/bin/env node
/**
 * Cleo Diff — compare two run JSONL files and report transitions
 */

import fs from "fs";
import path from "path";

interface RunResult {
  id: string;
  category: string;
  severity: string;
  passed: boolean;
}

function loadRunFile(filepath: string): Map<string, RunResult> {
  const results = new Map<string, RunResult>();
  if (!fs.existsSync(filepath)) {
    console.error(`File not found: ${filepath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(filepath, "utf-8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const result = JSON.parse(line) as RunResult;
    results.set(result.id, result);
  }

  return results;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: cleo:diff <old.jsonl> <new.jsonl>");
    process.exit(1);
  }

  const oldRun = loadRunFile(args[0]);
  const newRun = loadRunFile(args[1]);

  const transitions = {
    passToFail: [] as RunResult[],
    failToPass: [] as RunResult[],
    passToPass: [] as RunResult[],
    failToFail: [] as RunResult[],
  };

  const byCategory: Record<string, number> = {};

  for (const [id, newResult] of newRun) {
    const oldResult = oldRun.get(id);
    if (!oldResult) continue;

    byCategory[newResult.category] = (byCategory[newResult.category] || 0) + (oldResult.passed && !newResult.passed ? 1 : 0);

    if (oldResult.passed && !newResult.passed) {
      transitions.passToFail.push(newResult);
    } else if (!oldResult.passed && newResult.passed) {
      transitions.failToPass.push(newResult);
    } else if (oldResult.passed && newResult.passed) {
      transitions.passToPass.push(newResult);
    } else {
      transitions.failToFail.push(newResult);
    }
  }

  console.log("\n=== CLEO DIFF ===\n");

  console.log(
    `Regressions (PASS → FAIL): ${transitions.passToFail.length}`,
  );
  for (const r of transitions.passToFail) {
    console.log(`  RED ${r.id} [${r.severity}]`);
  }

  console.log(`\nImprovements (FAIL → PASS): ${transitions.failToPass.length}`);
  for (const r of transitions.failToPass) {
    console.log(`  GREEN ${r.id} [${r.severity}]`);
  }

  console.log(`\nStable PASS: ${transitions.passToPass.length}`);
  console.log(`Still broken: ${transitions.failToFail.length}`);

  console.log(`\nRegressions by category:`);
  for (const [cat, count] of Object.entries(byCategory)) {
    if (count > 0) console.log(`  ${cat}: ${count}`);
  }

  const hasRegressions = transitions.passToFail.length > 0;
  process.exit(hasRegressions ? 1 : 0);
}

main();
