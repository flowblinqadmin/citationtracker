#!/usr/bin/env node
/**
 * Stress test /api/serve endpoints for alpha sites
 * Usage: node scripts/stress-test-serve.mjs [--concurrent=10] [--duration=30]
 *
 * Flags:
 *   --concurrent=N   Number of concurrent requests (default: 10)
 *   --duration=N     Test duration in seconds (default: 30)
 *   --base-url=URL   Base URL (default: http://localhost:3000)
 */

import { neon } from "@neondatabase/serverless";

// Parse CLI args
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith("--"))
    .map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? "true"]; })
);

const concurrent = parseInt(args.concurrent ?? "10", 10);
const duration = parseInt(args.duration ?? "30", 10);
const baseUrl = args["base-url"] ?? "http://localhost:3000";

if (!process.env.DATABASE_URL_UNPOOLED) {
  console.error("DATABASE_URL_UNPOOLED env var required");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL_UNPOOLED);

// Get slugs for sites that have generated content
const sites = await sql`
  SELECT slug FROM geo_sites
  WHERE pipeline_status = 'complete'
    AND generated_llms_txt IS NOT NULL
  LIMIT 5
`;

if (sites.length === 0) {
  console.error("No complete sites with generated content found.");
  process.exit(1);
}

const slugs = sites.map(s => s.slug);
const endpoints = ["llms.txt", "llms-full.txt", "business.json", "schema.json", "schema.js"];

console.log(`Stress test: ${concurrent} concurrent, ${duration}s duration`);
console.log(`Base URL: ${baseUrl}`);
console.log(`Slugs: ${slugs.join(", ")}`);
console.log(`Endpoints: ${endpoints.join(", ")}`);
console.log("");

// Build URL list
const urls = [];
for (const slug of slugs) {
  for (const ep of endpoints) {
    urls.push(`${baseUrl}/api/serve/${slug}/${ep}`);
  }
}

// Metrics collection
const metrics = [];
let running = true;

async function makeRequest(url) {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "StressTest/1.0" },
    });
    const body = await res.text();
    const latencyMs = Math.round(performance.now() - start);
    metrics.push({ url, status: res.status, latencyMs, bodyLength: body.length });
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    metrics.push({ url, status: 0, latencyMs, bodyLength: 0, error: err.message });
  }
}

async function worker() {
  while (running) {
    const url = urls[Math.floor(Math.random() * urls.length)];
    await makeRequest(url);
  }
}

// Start workers
console.log(`Starting ${concurrent} workers for ${duration}s...`);
const workers = Array.from({ length: concurrent }, () => worker());

// Stop after duration
await new Promise(r => setTimeout(r, duration * 1000));
running = false;
await Promise.allSettled(workers);

// Calculate stats
const total = metrics.length;
const errors = metrics.filter(m => m.status === 0 || m.status >= 500).length;
const latencies = metrics.map(m => m.latencyMs).sort((a, b) => a - b);

function percentile(arr, p) {
  const idx = Math.ceil(arr.length * p / 100) - 1;
  return arr[Math.max(0, idx)] ?? 0;
}

// Per-status breakdown
const statusCounts = {};
for (const m of metrics) {
  statusCounts[m.status] = (statusCounts[m.status] || 0) + 1;
}

console.log("\n=== Results ===");
console.log(`Total requests:  ${total}`);
console.log(`Error rate:      ${((errors / total) * 100).toFixed(1)}% (${errors}/${total})`);
console.log(`Throughput:      ${(total / duration).toFixed(1)} req/s`);
console.log("");
console.log(`Latency p50:     ${percentile(latencies, 50)}ms`);
console.log(`Latency p95:     ${percentile(latencies, 95)}ms`);
console.log(`Latency p99:     ${percentile(latencies, 99)}ms`);
console.log("");
console.log("Status codes:", JSON.stringify(statusCounts));
