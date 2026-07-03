#!/usr/bin/env node
/**
 * check-schema-columns.mjs
 *
 * Prints every table and its SQL column names as defined in lib/db/schema.ts.
 * No database connection required — reads the Drizzle schema object directly.
 *
 * Usage:
 *   node scripts/check-schema-columns.mjs
 *
 * Or via npm:
 *   npm run schema:check
 *
 * Exit code 0 on success.
 *
 * Useful for:
 * - Quickly auditing what columns Drizzle will SELECT in production
 * - Confirming a new column appears in the schema before running tests
 * - CI pre-check to log the schema state alongside deployment artifacts
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { transformSync } from "esbuild";

// ---------------------------------------------------------------------------
// Bootstrap: teach Node how to require() TypeScript files via esbuild.
// This mirrors the same setup in vitest.setup.ts.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const projectRoot = join(dirname(__filename), "..");

const require = createRequire(import.meta.url);
const Module = require("node:module") ?? require("module");

// Resolve @/ aliases to absolute paths
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (typeof request === "string" && request.startsWith("@/")) {
    const base = join(projectRoot, request.slice(2));
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ""]) {
      if (existsSync(base + ext)) return origResolve.call(this, base + ext, ...rest);
    }
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      if (existsSync(join(base, "index" + ext))) {
        return origResolve.call(this, join(base, "index" + ext), ...rest);
      }
    }
  }
  return origResolve.call(this, request, ...rest);
};

// Register .ts extension handler using esbuild
if (!Module._extensions[".ts"]) {
  Module._extensions[".ts"] = function (mod, filename) {
    const { readFileSync } = require("node:fs");
    const code = readFileSync(filename, "utf8");
    const { code: compiled } = transformSync(code, {
      loader: "ts",
      format: "cjs",
      target: "node20",
      sourcefile: filename,
    });
    mod._compile(compiled, filename);
  };
}

// ---------------------------------------------------------------------------
// Stub out modules that try to connect to a real database at import time.
// We only need the schema definitions, not a live connection.
// ---------------------------------------------------------------------------

// Stub postgres client so lib/db/index.ts doesn't throw on missing DATABASE_URL
const postgresStub = () => {
  const stub = () => Promise.resolve([]);
  stub.unsafe = stub;
  stub.end = () => Promise.resolve();
  return stub;
};
Module._extensions[".ts"]; // ensure .ts handler is registered before the stub
require.cache[require.resolve("postgres")] = {
  id: "postgres",
  filename: "postgres",
  loaded: true,
  exports: postgresStub,
};

// Provide a dummy DATABASE_URL so the guard in lib/db/index.ts doesn't throw
if (!process.env.DATABASE_URL && !process.env.SUPABASE_DATABASE_URL && !process.env.POSTGRES_URL) {
  process.env.DATABASE_URL = "postgresql://stub:stub@localhost:5432/stub";
}

// Also stub SIGNUP_BONUS_CREDITS so lib/config.ts loads without error
// (it may read from environment or set a default — this is a no-op if already set)
if (!process.env.SIGNUP_BONUS_CREDITS) {
  process.env.SIGNUP_BONUS_CREDITS = "20";
}

// ---------------------------------------------------------------------------
// Load the schema
// ---------------------------------------------------------------------------

const schemaPath = join(projectRoot, "lib/db/schema.ts");
const schema = require(schemaPath);

// ---------------------------------------------------------------------------
// Introspect Drizzle table objects
// ---------------------------------------------------------------------------

/**
 * Extracts SQL column names from a Drizzle table object using the same
 * symbol-based introspection as __tests__/schema-drift.test.ts.
 */
function getColumns(table) {
  const columnsSymbol = Object.getOwnPropertySymbols(table).find(
    (s) => s.toString() === "Symbol(drizzle:Columns)"
  );

  if (columnsSymbol) {
    return Object.entries(table[columnsSymbol]).map(([tsKey, col]) => ({
      tsKey,
      sqlName: col.name,
      type: col.columnType ?? col.getSQLType?.() ?? "unknown",
      notNull: col.notNull ?? false,
    }));
  }

  // Fallback: collect string-keyed properties with a .name string
  const cols = [];
  for (const key of Object.keys(table)) {
    const col = table[key];
    if (col && typeof col === "object" && typeof col.name === "string") {
      cols.push({
        tsKey: key,
        sqlName: col.name,
        type: col.columnType ?? "unknown",
        notNull: col.notNull ?? false,
      });
    }
  }
  return cols;
}

/**
 * Returns the SQL table name from a Drizzle table object.
 */
function getTableName(table) {
  const nameSymbol = Object.getOwnPropertySymbols(table).find(
    (s) => s.toString() === "Symbol(drizzle:Name)"
  );
  if (nameSymbol) return table[nameSymbol];
  return table._?.name ?? "(unknown)";
}

// ---------------------------------------------------------------------------
// Tables we care about (add new exports from schema.ts here)
// ---------------------------------------------------------------------------

const TABLES = {
  teams: schema.teams,
  teamMembers: schema.teamMembers,
  teamDomains: schema.teamDomains,
  creditTransactions: schema.creditTransactions,
  geoSites: schema.geoSites,
  geoCrawlLogs: schema.geoCrawlLogs,
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log("\nDrizzle ORM schema column report");
console.log("=".repeat(60));

let totalColumns = 0;

for (const [exportName, table] of Object.entries(TABLES)) {
  if (!table) {
    console.warn(`\n[WARN] ${exportName} not found in schema exports — skipping`);
    continue;
  }

  const sqlTableName = getTableName(table);
  const columns = getColumns(table);
  totalColumns += columns.length;

  console.log(`\n${exportName} (${sqlTableName}) — ${columns.length} columns`);
  console.log("-".repeat(50));

  for (const col of columns) {
    const notNullTag = col.notNull ? " NOT NULL" : "";
    console.log(`  ${col.sqlName.padEnd(35)} ${col.type}${notNullTag}`);
  }
}

console.log("\n" + "=".repeat(60));
console.log(`Total: ${Object.keys(TABLES).length} tables, ${totalColumns} columns`);
console.log("");

process.exit(0);
