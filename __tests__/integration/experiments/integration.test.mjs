// Integration tests for ai-surface-audit pipeline
// Authored from ES-pr-1-group-b §g.
// Network paths (LLM, Firecrawl, Brave, DB, pitchgen) are mocked or spawned with
// --skip flags. Hard-coded macOS cofounder-deliverables paths (AC-9) mean some
// ITs are expected RED on Linux until ScriptDev parametrizes the output dir.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.resolve(__dirname, "../../../scripts/experiments/ai-surface-audit");
const NODE = process.execPath;

function runNode(script, args, cwd, env = {}) {
  return spawnSync(NODE, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function seedMinimalSignalsAndProbes(outDir, n = 5) {
  const domains = Array.from({ length: n }, (_, i) => `m${i}.example.com`);
  const signals = {};
  const probes = {};
  for (let i = 0; i < n; i++) {
    const d = domains[i];
    signals[d] = {
      hasProductSchema: i % 2 === 0,
      hasOrgSchema: true,
      hasReviewSchema: false,
      hasFAQSchema: false,
      hasBreadcrumbs: false,
      hasLlmsTxt: false,
      hasSitemap: true,
      hasRobotsTxt: true,
      allowsAIBots: true,
      blocksGPTBot: false,
      blocksCCBot: false,
      blocksPerplexityBot: false,
      hasAnyReviews: false,
      hasFAQContent: false,
      hasComparisonContent: false,
      hasPricingContent: true,
      hasShippingInfo: true,
      hasReturnPolicy: true,
      hasCanonicalTag: true,
      hasMetaDescription: true,
      hasOpenGraph: true,
      mentionsCurrentYear: true,
      schemaCount: i,
      schemaScore: i * 8,
      freshnessScore: 100,
      contentScore: 50 + i * 5,
      reviewPlatformCount: 0,
      estimatedReviewCount: 0,
      maxWordCount: 500,
      socialChannelCount: 0,
    };
    probes[d] = [
      { surface: "chatgpt_shopping", visibilityScore: i * 20, mentionCount: i, avgPosition: null },
      { surface: "perplexity_shopping", visibilityScore: i * 15, mentionCount: i, avgPosition: null },
      { surface: "google_ai_overview", visibilityScore: i * 10, mentionCount: i, avgPosition: null },
      { surface: "meta_ai", visibilityScore: 0, mentionCount: 0, avgPosition: null },
      { surface: "amazon_rufus", visibilityScore: 0, mentionCount: 0, avgPosition: null },
    ];
  }
  writeFileSync(path.join(outDir, "signals.json"), JSON.stringify(signals));
  writeFileSync(path.join(outDir, "probes.json"), JSON.stringify(probes));
  // also produce a matching tiny cohort if script consults SCRIPT_DIR cohort.
  return { domains };
}

describe("IT1: run-experiment.mjs with --skip-crawl --skip-probes", () => {
  it("writes ranking-factors txt/md/json and appends tracking-history.md", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "aisurface-it1-"));
    seedMinimalSignalsAndProbes(workDir, 5);
    const r = runNode(
      path.join(SCRIPT_DIR, "run-experiment.mjs"),
      ["--skip-crawl", "--skip-probes", "--output", workDir],
      SCRIPT_DIR,
    );
    try {
      expect(r.status).toBe(0);
      const files = readdirSync(workDir);
      expect(files.some((f) => /^ranking-factors-\d{4}-\d{2}-\d{2}\.txt$/.test(f))).toBe(true);
      expect(files.some((f) => /^ranking-factors-\d{4}-\d{2}-\d{2}\.md$/.test(f))).toBe(true);
      expect(files.some((f) => /^ranking-factors-\d{4}-\d{2}-\d{2}\.json$/.test(f))).toBe(true);
      expect(files).toContain("tracking-history.md");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("IT2: run-experiment.mjs exits non-zero when merged merchants < 5", () => {
  it("prints 'Insufficient data' and exits non-zero", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "aisurface-it2-"));
    seedMinimalSignalsAndProbes(workDir, 2);
    const r = runNode(
      path.join(SCRIPT_DIR, "run-experiment.mjs"),
      ["--skip-crawl", "--skip-probes", "--merchants", "2", "--output", workDir],
      SCRIPT_DIR,
    );
    try {
      expect(r.status).not.toBe(0);
      expect((r.stderr || "") + (r.stdout || "")).toMatch(/Insufficient data/i);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("IT3: pitch-bridge.mjs --domain filters to one merchant", () => {
  it("emits audit-jsons/<domain>.json conforming to §c.7 schema for the requested domain", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "aisurface-it3-"));
    // pitch-bridge reads from SCRIPT_DIR/results; it also consults test-run-healthcare.json.
    // We invoke with --domain apollohospitals.com so execSync is called once with --industry healthcare.
    // The pitchgen child will fail on Linux (no /Users/adithya/...) — test asserts the audit JSON
    // file was produced BEFORE the pitchgen shell-out (see pitch-bridge sequencing).
    // pitch-bridge writes to hard-coded SCRIPT_DIR/results — save + restore the committed
    // fixture so the working tree stays clean. (TDD: ScriptDev should add --output to
    // parametrize this; AC-9 pattern.)
    const auditPath = path.join(SCRIPT_DIR, "results", "audit-jsons", "apollohospitals-com.json");
    const committed = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : null;
    const r = spawnSync(
      NODE,
      [
        path.join(SCRIPT_DIR, "pitch-bridge.mjs"),
        "--domain",
        "apollohospitals.com",
        "--max",
        "1",
      ],
      { cwd: SCRIPT_DIR, encoding: "utf8", timeout: 30_000, env: { ...process.env } },
    );
    try {
      // Check the audit JSON was written under the script's results dir
      const auditPath = path.join(SCRIPT_DIR, "results", "audit-jsons", "apollohospitals-com.json");
      expect(existsSync(auditPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(auditPath, "utf8"));
      expect(parsed.domain).toBe("apollohospitals.com");
      expect(parsed.max_score).toBe(100);
      expect(parsed.score).toBeGreaterThanOrEqual(0);
      expect(parsed.score).toBeLessThanOrEqual(100);
      expect(Array.isArray(parsed.issues)).toBe(true);
      for (const is of parsed.issues) {
        expect(["high", "medium", "low"]).toContain(is.severity);
      }
      // Confirm industry routing: script log should mention healthcare
      expect((r.stdout || "") + (r.stderr || "")).toMatch(/healthcare/i);
    } finally {
      if (committed !== null) writeFileSync(auditPath, committed);
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("IT4: outreach-generator.mjs --results <fixture>", () => {
  it("produces outreach-drafts-*.md with draft-only header and one row per non-FlowBlinq merchant", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "aisurface-it4-"));
    // Build a minimal results fixture
    const fixture = {
      merchants: [
        {
          domain: "manipalhospitals.com",
          vertical: "healthcare",
          signals: { hasProductSchema: false, hasOrgSchema: true, allowsAIBots: true },
          visibility: [{ surface: "chatgpt_shopping", visibilityScore: 30 }],
        },
        {
          domain: "flowblinq.com",
          vertical: "healthcare",
          signals: {},
          visibility: [],
        },
      ],
    };
    const fixturePath = path.join(workDir, "results.json");
    writeFileSync(fixturePath, JSON.stringify(fixture));
    const r = runNode(
      path.join(SCRIPT_DIR, "outreach-generator.mjs"),
      ["--results", fixturePath, "--output", workDir],
      SCRIPT_DIR,
    );
    try {
      // Expect outreach-drafts-*.md in workDir or in SCRIPT_DIR/results
      const candidates = [
        ...readdirSync(workDir),
        ...(existsSync(path.join(SCRIPT_DIR, "results"))
          ? readdirSync(path.join(SCRIPT_DIR, "results"))
          : []),
      ];
      const draftFile = candidates.find((f) => /^outreach-drafts-\d{4}-\d{2}-\d{2}\.md$/.test(f));
      expect(draftFile).toBeDefined();
      const content =
        readFileSync(
          existsSync(path.join(workDir, draftFile))
            ? path.join(workDir, draftFile)
            : path.join(SCRIPT_DIR, "results", draftFile),
          "utf8",
        );
      expect(content).toMatch(/DRAFT — requires Adithya approval before sending/);
      expect(content).toContain("manipalhospitals.com");
      // Skip-flowblinq guardrail (outreach-generator.mjs:139): the flowblinq.com merchant
      // must not appear in the email roster. Scope this assertion to the roster sub-blocks
      // only — the summary table and the per-email section headers — since email *bodies*
      // legitimately contain 'ar@flowblinq.com' in the sender signature (HP-251(a)).
      const summaryMatch = content.match(/## Summary\s*\n([\s\S]*?)\n---/);
      expect(summaryMatch, "summary table block not found").not.toBeNull();
      expect(summaryMatch[1]).not.toContain("flowblinq.com");
      const emailHeaders = [...content.matchAll(/^## \d+\.\s+(.+)$/gm)].map((m) => m[1].trim());
      expect(emailHeaders).not.toContain("flowblinq.com");
      expect(emailHeaders).toContain("manipalhospitals.com");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("IT5: test-run.mjs DB call is read-only (AC-15)", () => {
  it("source contains only a SELECT, no write-SQL verbs anywhere in test-run.mjs", () => {
    const src = readFileSync(path.join(SCRIPT_DIR, "test-run.mjs"), "utf8");
    expect(src).toMatch(/SELECT\b/i);
    expect(src).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(src).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(src).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(src).not.toMatch(/\bTRUNCATE\b/i);
    expect(src).not.toMatch(/\bDROP\s+(TABLE|INDEX|SCHEMA)\b/i);
    expect(src).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(src).not.toMatch(/\bCREATE\s+(TABLE|INDEX|SCHEMA)\b/i);
  });
});

describe("IT6: surface-probes timeout path", () => {
  it("query functions return {text:'', citations:[], error:'timeout'} on TIMEOUT_MS expiry", async () => {
    // TDD: requires queryChatGPTShopping (or a testable export). RED until ScriptDev
    // exports an internal wrapper or a testable `withTimeout` helper.
    const mod = await import("../../../scripts/experiments/ai-surface-audit/surface-probes.mjs");
    expect(typeof mod.queryChatGPTShopping === "function" || typeof mod.withTimeout === "function").toBe(true);
    // When exported, a mocked OpenAI client that hangs must resolve to the timeout shape.
    // For now, the presence assertion above is the TDD gate.
  });
});

describe("IT7: signal-extractor extractSiteLevelSignals robots.txt 404 path", () => {
  it("treats missing robots.txt as hasRobotsTxt:false, allowsAIBots:true", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      // All three (robots, llms, sitemap) → 404
      return new Response("", { status: 404 });
    });
    try {
      const { extractSiteLevelSignals } = await import(
        "../../../scripts/experiments/ai-surface-audit/signal-extractor.mjs"
      );
      const s = await extractSiteLevelSignals("example.com");
      expect(s.hasRobotsTxt).toBe(false);
      expect(s.allowsAIBots).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("IT8: committed audit JSON fixtures conform to §c.7 schema (AC-11, AC-12)", () => {
  it("every results/audit-jsons/*.json parses and has required keys + valid severity enum", () => {
    const auditsDir = path.join(SCRIPT_DIR, "results", "audit-jsons");
    expect(existsSync(auditsDir)).toBe(true);
    const files = readdirSync(auditsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const data = JSON.parse(readFileSync(path.join(auditsDir, f), "utf8"));
      expect(typeof data.domain).toBe("string");
      expect(data.max_score).toBe(100);
      expect(data.score).toBeGreaterThanOrEqual(0);
      expect(data.score).toBeLessThanOrEqual(100);
      expect(/^\d{4}-\d{2}-\d{2}$/.test(data.audit_date)).toBe(true);
      expect(Array.isArray(data.issues)).toBe(true);
      for (const is of data.issues) {
        expect(["high", "medium", "low"]).toContain(is.severity);
      }
      expect(typeof data.projected_score_after_fixes).toBe("string");
      expect(typeof data.ai_surface_visibility).toBe("object");
    }
  });
});

describe("AC guard tests (grep-based)", () => {
  it("AC-13: outreach-generator.mjs never imports a mail transport", () => {
    const src = readFileSync(path.join(SCRIPT_DIR, "outreach-generator.mjs"), "utf8");
    expect(src).not.toMatch(/require\(['"]nodemailer['"]\)|from\s+['"]nodemailer['"]/);
    expect(src).not.toMatch(/@sendgrid\/mail/);
    expect(src).not.toMatch(/['"]postmark['"]/);
    expect(src).not.toMatch(/['"]resend['"]/);
  });

  it("AC-14: surface-probes, signal-extractor, test-run never write to process.env", () => {
    for (const f of ["surface-probes.mjs", "signal-extractor.mjs", "test-run.mjs"]) {
      const src = readFileSync(path.join(SCRIPT_DIR, f), "utf8");
      expect(src).not.toMatch(/process\.env\.[A-Z_]+\s*=/);
    }
  });
});
