#!/usr/bin/env tsx
// CI gate: assert every app/api route matches docs/runtime-policy.md.
//
// Two classes:
//   - Vercel Edge:  route MUST export `runtime = 'edge'` AND appear in the
//                   EDGE_ROUTES registry below (defense-in-depth — the
//                   registry is the explicit allowlist).
//   - Vercel Fluid: route MUST NOT export `runtime = 'edge'`.
//
// An app/api route not classified in any section fails with
// "unclassified route" so newly-added routes can't silently skip the policy.
//
// Run:  npm run check:runtime-policy   (wired in package.json)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const API_ROOT = join(REPO_ROOT, "app", "api");
const POLICY_DOC = join(REPO_ROOT, "docs", "runtime-policy.md");

/**
 * Explicit allowlist of routes that run on Vercel Edge. A route can be
 * here AND in the docs's "Vercel Edge" section but the registry is the
 * second gate — adding a route to one without the other fails CI.
 */
const EDGE_ROUTES: ReadonlySet<string> = new Set([
  "app/api/t/collect/route.ts",
  "app/api/t/[slug]/route.ts",
]);

function listRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      listRouteFiles(full, acc);
    } else if (
      entry === "route.ts" || entry === "route.tsx" || entry === "route.js"
    ) {
      acc.push(full);
    }
  }
  return acc;
}

function normalize(p: string): string {
  return relative(REPO_ROOT, p).split(sep).join("/");
}

function readPolicyClassifications(): {
  edge: Set<string>;
  fluid: Set<string>;
} {
  const doc = readFileSync(POLICY_DOC, "utf8");
  const sections = doc.split(/^## /m);

  function paths(section: string): Set<string> {
    const out = new Set<string>();
    // Markdown table rows: `| <path> | ... |`. We accept either bare paths
    // or paths wrapped in backticks.
    const rows = section.match(/^\|[^|\n]+\|[^\n]+\|/gm) ?? [];
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      const cell = cells[1] ?? "";
      const stripped = cell.replace(/^`|`$/g, "");
      if (stripped.startsWith("app/api/")) out.add(stripped);
    }
    return out;
  }

  const findSection = (heading: string) =>
    sections.find((s) => s.trimStart().startsWith(heading)) ?? "";

  return {
    fluid: paths(findSection("Vercel Fluid")),
    edge: paths(findSection("Vercel Edge")),
  };
}

function stripComments(source: string): string {
  // Strip block comments and line comments. Order matters: block first so we
  // don't accidentally treat `// ... /* */` as line content.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function fileExports(source: string, name: string): RegExpMatchArray | null {
  // matches `export const <name> = '...';` or "..."
  const code = stripComments(source);
  const re = new RegExp(
    String.raw`export\s+(?:const|let|var)\s+${name}\s*=\s*["']([^"']+)["']`,
    "m",
  );
  return code.match(re);
}

function main(): number {
  const policy = readPolicyClassifications();
  const found = listRouteFiles(API_ROOT).map(normalize).sort();

  const errors: string[] = [];

  for (const path of found) {
    const inFluid = policy.fluid.has(path);
    const inEdge = policy.edge.has(path);
    const inEdgeRegistry = EDGE_ROUTES.has(path);

    // Membership rules
    const memberships = [inFluid, inEdge].filter(Boolean).length;
    if (memberships === 0) {
      errors.push(
        `unclassified route: ${path} — add it to docs/runtime-policy.md (Vercel Fluid or Vercel Edge section)`,
      );
      continue;
    }
    if (memberships > 1) {
      errors.push(
        `route ${path} appears in multiple sections of docs/runtime-policy.md — pick one`,
      );
      continue;
    }

    const source = readFileSync(join(REPO_ROOT, path), "utf8");
    const runtimeExport = fileExports(source, "runtime");

    if (inEdge) {
      if (!runtimeExport || runtimeExport[1] !== "edge") {
        errors.push(
          `${path} is in 'Vercel Edge' section but does not export runtime = 'edge'`,
        );
      }
      if (!inEdgeRegistry) {
        errors.push(
          `${path} is in 'Vercel Edge' section but missing from EDGE_ROUTES registry in scripts/check-runtime-policy.ts`,
        );
      }
    } else if (inFluid) {
      if (runtimeExport && runtimeExport[1] === "edge") {
        errors.push(
          `${path} is in 'Vercel Fluid' section but exports runtime = 'edge' — remove the export or move to the Vercel Edge section`,
        );
      }
      if (inEdgeRegistry) {
        errors.push(
          `${path} is in EDGE_ROUTES registry but classified as Vercel Fluid in docs/runtime-policy.md — pick one`,
        );
      }
    }
  }

  // Detect stale registry entries — files in EDGE_ROUTES that no longer
  // exist would indicate dead config. Warn so the cleanup happens promptly.
  for (const path of EDGE_ROUTES) {
    if (!found.includes(path)) {
      console.warn(
        `[runtime-policy] stale EDGE_ROUTES entry: ${path} no longer exists. Remove from scripts/check-runtime-policy.ts.`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("✗ runtime-policy check failed:");
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }

  console.log(
    `✓ runtime-policy: ${found.length} routes classified (fluid=${policy.fluid.size}, edge=${policy.edge.size})`,
  );
  return 0;
}

const exitCode = main();
process.exit(exitCode);
