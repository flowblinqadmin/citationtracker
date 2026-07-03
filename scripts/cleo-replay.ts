#!/usr/bin/env node
/**
 * Cleo Replay/Eval Harness — execute test cases against the chatbot pipeline
 * and produce pass/fail reports.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EVAL_DIR = path.join(REPO_ROOT, "eval");
const CACHE_DIR = path.join(EVAL_DIR, "cache");
const RUNS_DIR = path.join(EVAL_DIR, "runs");

// Ensure cache/runs directories exist
[CACHE_DIR, RUNS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface TestCase {
  id: string;
  category: string;
  severity?: "critical" | "high" | "medium";
  runs?: number;
  query?: string;
  turns?: Array<{ role: "user" | "assistant"; content: string }>;
  siteContextOverrides?: Record<string, unknown>;
  viewContext?: Record<string, unknown> | null;
  mustContain?: string[];
  mustNotContain?: string[];
  mustContainAny?: string[][];
  mustNotContainRegex?: string[];
  expectedTier?: "full" | "hedged" | "refused";
  expectedEscalation?: boolean;
  sourceLogId?: string;
  why?: string;
}

interface RunResult {
  id: string;
  category: string;
  severity: string;
  passed: boolean;
  runsExecuted: number;
  runsPassed: number;
  runsRequired?: number;
  perRun: Array<{
    text: string;
    passed: boolean;
    violations: string[];
    durationMs: number;
    costUsd: number;
    error?: string;
  }>;
  retrieval?: {
    tier: string;
    topSimilarity: number;
    chunks: Array<{ source: string; similarity: number }>;
  };
  expectedTierMatch?: boolean;
  totalDurationMs: number;
  totalCostUsd: number;
}

interface GenerateResponseOpts {
  provider: "openai" | "anthropic";
  model: string;
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature: number;
  siteContext?: any;
  viewContext?: any;
  retrieval?: any;
  seed?: number;
}

interface GenerateResponseResult {
  text: string;
  durationMs: number;
  costUsd: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Args
// ─────────────────────────────────────────────────────────────────────────────

interface CliOptions {
  failuresOnly: boolean;
  allFailures: boolean;
  single?: string;
  severity?: "critical" | "high" | "medium";
  failFast: boolean;
  noCache: boolean;
  provider: "openai" | "anthropic";
  model?: string;
  singleRun: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    failuresOnly: true,
    allFailures: false,
    failFast: false,
    noCache: false,
    provider: "openai",
    singleRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all-failures") {
      opts.failuresOnly = false;
      opts.allFailures = true;
    } else if (arg === "--failures-only") {
      opts.failuresOnly = true;
      opts.allFailures = false;
    } else if (arg === "--single" && args[i + 1]) {
      const kv = args[++i].split("=");
      if (kv[0] === "id") opts.single = kv[1];
    } else if (arg === "--severity" && args[i + 1]) {
      opts.severity = args[++i] as "critical" | "high" | "medium";
    } else if (arg === "--fail-fast") {
      opts.failFast = true;
    } else if (arg === "--no-cache") {
      opts.noCache = true;
    } else if (arg === "--provider" && args[i + 1]) {
      opts.provider = args[++i] as "openai" | "anthropic";
    } else if (arg === "--model" && args[i + 1]) {
      opts.model = args[++i];
    } else if (arg === "--single-run") {
      opts.singleRun = true;
    }
  }

  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load test cases
// ─────────────────────────────────────────────────────────────────────────────

function loadTestCases(opts: CliOptions): TestCase[] {
  const cases: TestCase[] = [];

  const failureFiles = [
    "curated.jsonl",
    "multiturn.jsonl",
    "platform-coverage.jsonl",
    "audit-interpretation.jsonl",
    "anti-hallucination-probes.jsonl",
    "pricing-billing.jsonl",
    "threshold-boundary.jsonl",
    "follow-up-ambiguity.jsonl",
    "escalation-triggers.jsonl",
  ];

  if (opts.single) {
    // Load just the single case
    for (const file of failureFiles) {
      const path_ = path.join(EVAL_DIR, "failures", file);
      if (!fs.existsSync(path_)) continue;
      const lines = fs.readFileSync(path_, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const c = JSON.parse(line) as TestCase;
        if (c.id === opts.single) {
          c.severity = c.severity ?? "high";
          cases.push(c);
          return cases;
        }
      }
    }
    console.error(`Case not found: ${opts.single}`);
    process.exit(1);
  }

  if (opts.allFailures) {
    // Load ALL cases from all files
    for (const file of failureFiles) {
      const path_ = path.join(EVAL_DIR, "failures", file);
      if (!fs.existsSync(path_)) continue;
      const lines = fs.readFileSync(path_, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const c = JSON.parse(line) as TestCase;
        c.severity = c.severity ?? "high";
        cases.push(c);
      }
    }
  } else {
    // Default: failures-only = curated + multiturn + all critical
    const curatedPath = path.join(EVAL_DIR, "failures", "curated.jsonl");
    const multiturnPath = path.join(EVAL_DIR, "failures", "multiturn.jsonl");

    if (fs.existsSync(curatedPath)) {
      const lines = fs.readFileSync(curatedPath, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const c = JSON.parse(line) as TestCase;
        c.severity = c.severity ?? "high";
        cases.push(c);
      }
    }

    if (fs.existsSync(multiturnPath)) {
      const lines = fs.readFileSync(multiturnPath, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const c = JSON.parse(line) as TestCase;
        c.severity = c.severity ?? "high";
        cases.push(c);
      }
    }

    // Add all critical from other files
    for (const file of failureFiles.slice(2)) {
      const path_ = path.join(EVAL_DIR, "failures", file);
      if (!fs.existsSync(path_)) continue;
      const lines = fs.readFileSync(path_, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const c = JSON.parse(line) as TestCase;
        c.severity = c.severity ?? "high";
        if (c.severity === "critical") {
          cases.push(c);
        }
      }
    }
  }

  // Filter by severity if specified
  if (opts.severity) {
    return cases.filter((c) => c.severity === opts.severity);
  }

  return cases;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider abstraction
// ─────────────────────────────────────────────────────────────────────────────

async function generateResponse(opts: GenerateResponseOpts): Promise<GenerateResponseResult> {
  if (opts.provider === "openai") {
    // If we have the full context (siteContext, viewContext, retrieval), use the consolidated generate module
    if (opts.siteContext !== undefined && opts.viewContext !== undefined && opts.retrieval !== undefined) {
      return generateOpenAIViaModule(opts);
    } else {
      // Fallback to direct API call for legacy tests
      return generateOpenAI(opts);
    }
  } else {
    return generateAnthropic(opts);
  }
}

async function generateOpenAIViaModule(opts: GenerateResponseOpts): Promise<GenerateResponseResult> {
  const { generateChatbotResponse } = await import(path.join(REPO_ROOT, "lib/chatbot/generate.ts"));

  const startMs = Date.now();

  try {
    const { text } = await generateChatbotResponse({
      messages: opts.messages,
      siteContext: opts.siteContext,
      viewContext: opts.viewContext,
      retrieval: opts.retrieval,
      modelOverride: opts.model,
      temperatureOverride: opts.temperature,
      seedOverride: opts.seed,
    });

    const durationMs = Date.now() - startMs;
    // Rough cost estimate (actual costs would come from AI SDK response usage)
    const costUsd = 0.001;

    return { text, durationMs, costUsd };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAI via module error: ${msg}`);
  }
}

async function generateOpenAI(opts: GenerateResponseOpts): Promise<GenerateResponseResult> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const startMs = Date.now();

  const params = {
    model: opts.model,
    messages: [
      { role: "system" as const, content: opts.systemPrompt },
      ...opts.messages,
    ] as any,
    max_tokens: 1000,
    temperature: opts.temperature,
  };

  try {
    const response = await client.chat.completions.create(params);

    const text =
      response.choices[0]?.message?.content || "";
    const durationMs = Date.now() - startMs;
    // OpenAI pricing approximation (gpt-4o-mini: $0.15/1M input, $0.6/1M output)
    const costUsd =
      (response.usage?.prompt_tokens || 0) * 0.00000015 +
      (response.usage?.completion_tokens || 0) * 0.0000006;

    return { text, durationMs, costUsd };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAI error: ${msg}`);
  }
}

async function generateAnthropic(opts: GenerateResponseOpts): Promise<GenerateResponseResult> {
  const { execSync } = await import("child_process");
  const os = await import("os");

  // Build message for claude -p
  // Multi-turn: concatenate prior assistant responses
  const messageText = opts.messages
    .map((m) => {
      const prefix = m.role === "user" ? "User: " : "Assistant: ";
      return prefix + m.content;
    })
    .join("\n\n");

  // Write system prompt + empty MCP config to temp files (avoids shell quoting hell)
  const ts = Date.now();
  const sysFile = path.join(os.tmpdir(), `cleo-system-${ts}.txt`);
  const mcpFile = path.join(os.tmpdir(), `cleo-mcp-${ts}.json`);
  fs.writeFileSync(sysFile, opts.systemPrompt);
  fs.writeFileSync(mcpFile, '{"mcpServers":{}}');

  const startMs = Date.now();

  try {
    // Map full Anthropic ids to claude CLI aliases.
    const cliModel = opts.model.replace(/^claude-haiku-4-5(-\d+)?$/, "haiku")
      .replace(/^claude-sonnet-4-6(-\d+)?$/, "sonnet")
      .replace(/^claude-opus-4-7(-\d+)?$/, "opus");

    const cmd = [
      "claude",
      "-p",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--tools", '""',
      "--exclude-dynamic-system-prompt-sections",
      "--strict-mcp-config",
      "--mcp-config", JSON.stringify(mcpFile),
      "--setting-sources", '""',
      "--system-prompt", `"$(cat ${JSON.stringify(sysFile)})"`,
      "--model", cliModel,
      "--output-format", "json",
      JSON.stringify(messageText),
    ].join(" ");

    const output = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
    const events = JSON.parse(output);

    const result = events.find((e: Record<string, unknown>) => e.type === "result") as
      | Record<string, unknown>
      | undefined;
    if (!result?.result) {
      throw new Error("No result in claude output");
    }

    const text = String(result.result);
    const costUsd = Number(result.total_cost_usd) || 0;
    const durationMs = Date.now() - startMs;

    return { text, durationMs, costUsd };
  } catch (err) {
    throw new Error(`Anthropic error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (fs.existsSync(sysFile)) fs.unlinkSync(sysFile);
    if (fs.existsSync(mcpFile)) fs.unlinkSync(mcpFile);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Caching
// ─────────────────────────────────────────────────────────────────────────────

function getCacheKey(opts: GenerateResponseOpts): string {
  const seedPart = opts.seed ?? "no-seed";
  const input = `${opts.provider}:${opts.model}:${opts.temperature}:${seedPart}:${opts.systemPrompt}:${JSON.stringify(
    opts.messages,
  )}`;
  return createHash("sha256").update(input).digest("hex");
}

function loadFromCache(key: string, noCache: boolean): GenerateResponseResult | null {
  if (noCache) return null;
  const filepath = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(filepath)) {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  }
  return null;
}

function saveToCache(key: string, result: GenerateResponseResult): void {
  const filepath = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(filepath, JSON.stringify(result));
}

// ─────────────────────────────────────────────────────────────────────────────
// Import chatbot functions
// ─────────────────────────────────────────────────────────────────────────────

async function loadChatbotModules() {
  const guardRailsModule = await import(path.join(REPO_ROOT, "lib/chatbot/guardrails.ts"));
  const retrieveModule = await import(path.join(REPO_ROOT, "lib/chatbot/retrieve.ts"));
  const systemPromptModule = await import(path.join(REPO_ROOT, "lib/chatbot/system-prompt.ts"));

  return {
    checkGuardrails: guardRailsModule.checkGuardrails as (message: string) => { allowed: boolean; refusalMessage?: string },
    retrieveKnowledge: retrieveModule.retrieveKnowledge as (
      query: string,
      platformHint: string | null,
      conversationContext?: string,
    ) => Promise<{ tier: "full" | "hedged" | "refused"; chunks: Array<{ content: string; source: string; similarity: number }> }>,
    buildSystemPrompt: systemPromptModule.buildSystemPrompt as (
      siteContext: unknown,
      viewContext: unknown,
      chunks: unknown[],
      tier: string,
    ) => string,
    SiteContext: systemPromptModule.SiteContext,
    ViewContext: systemPromptModule.ViewContext,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion logic
// ─────────────────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function checkAssertions(
  response: string,
  testCase: TestCase,
): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  const normalized = normalize(response);

  // mustContain
  if (testCase.mustContain) {
    for (const s of testCase.mustContain) {
      if (!normalized.includes(normalize(s))) {
        violations.push(`mustContain: "${s}" not found`);
      }
    }
  }

  // mustNotContain
  if (testCase.mustNotContain) {
    for (const s of testCase.mustNotContain) {
      if (normalized.includes(normalize(s))) {
        violations.push(`mustNotContain: "${s}" found`);
      }
    }
  }

  // mustContainAny
  if (testCase.mustContainAny) {
    for (const group of testCase.mustContainAny) {
      const anyMatch = group.some((s) => normalized.includes(normalize(s)));
      if (!anyMatch) {
        violations.push(`mustContainAny: none of [${group.join(", ")}] found`);
      }
    }
  }

  // mustNotContainRegex
  if (testCase.mustNotContainRegex) {
    for (const pattern of testCase.mustNotContainRegex) {
      try {
        const regex = new RegExp(pattern, "i");
        if (regex.test(response)) {
          violations.push(`mustNotContainRegex: pattern ${pattern} matched`);
        }
      } catch {
        console.warn(`Invalid regex: ${pattern}`);
      }
    }
  }

  return { passed: violations.length === 0, violations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main harness
// ─────────────────────────────────────────────────────────────────────────────

async function runTestCase(
  testCase: TestCase,
  opts: { provider: "openai" | "anthropic"; model: string; noCache: boolean; singleRun: boolean },
  modules: Awaited<ReturnType<typeof loadChatbotModules>>,
): Promise<RunResult> {
  let runs = testCase.runs ?? 1;
  // --single-run flag overrides runs to 1 (no seed used)
  if (opts.singleRun) {
    runs = 1;
  }
  const perRun: RunResult["perRun"] = [];
  let totalDurationMs = 0;
  let totalCostUsd = 0;
  let runsPassed = 0;

  // Build SiteContext with defaults
  const siteContext = {
    domain: testCase.siteContextOverrides?.domain ?? "example.com",
    tier: (testCase.siteContextOverrides?.tier as "free" | "paid") ?? "free",
    overallScore: testCase.siteContextOverrides?.overallScore ?? 50,
    platformDetected: testCase.siteContextOverrides?.platformDetected ?? null,
    pillars: testCase.siteContextOverrides?.pillars ?? [],
    rankedRecommendations: testCase.siteContextOverrides?.rankedRecommendations ?? [],
    ...(testCase.siteContextOverrides ?? {}),
  } as any;

  // Build ViewContext
  const viewContext = testCase.viewContext ?? null;

  // Get user query
  let userQuery = testCase.query || "";
  let messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  if (testCase.turns) {
    // Multi-turn case
    for (let i = 0; i < testCase.turns.length; i++) {
      const turn = testCase.turns[i];
      if (turn.role === "user") {
        userQuery = turn.content;
      } else if (turn.role === "assistant" && turn.content === "<previous-answer>") {
        // Recursively generate previous answer (not implemented in phase 0)
        messages.push({ role: "assistant", content: "[placeholder-answer]" });
      } else {
        messages.push(turn);
      }
    }
    messages.push({ role: "user", content: userQuery });
  } else {
    messages = [{ role: "user", content: userQuery }];
  }

  // Retrieve knowledge.
  // Multi-turn: build conversationContext from prior user turns (matches route.ts behavior)
  // so embedding sees prior platform/topic context, not just the final terse follow-up.
  const priorUserTurns = messages
    .filter((m) => m.role === "user")
    .slice(0, -1)
    .map((m) => m.content)
    .filter((c): c is string => Boolean(c))
    .join("\n");
  const conversationContext = priorUserTurns.slice(0, 2000) || undefined;

  let retrieval: RunResult["retrieval"] | undefined;
  let retrievalChunks: any[] = [];
  try {
    const result = await modules.retrieveKnowledge(
      userQuery,
      siteContext.platformDetected as string | null,
      conversationContext,
    );
    retrievalChunks = result.chunks || [];
    retrieval = {
      tier: result.tier,
      topSimilarity: retrievalChunks[0]?.similarity ?? 0,
      chunks: retrievalChunks.map((c: any) => ({ source: c.source || "", similarity: c.similarity || 0 })),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      id: testCase.id,
      category: testCase.category,
      severity: testCase.severity ?? "high",
      passed: false,
      runsExecuted: 0,
      runsPassed: 0,
      runsRequired: 0,
      perRun: [
        {
          text: "",
          passed: false,
          violations: [],
          durationMs: 0,
          costUsd: 0,
          error: `Retrieval failed: ${errMsg}`,
        },
      ],
      totalDurationMs: 0,
      totalCostUsd: 0,
    };
  }

  // Check guardrails
  const guardrailCheck = modules.checkGuardrails(userQuery);
  if (!guardrailCheck.allowed) {
    const response = guardrailCheck.refusalMessage || "Request blocked by guardrails";
    const { passed, violations } = checkAssertions(response, testCase);
    perRun.push({ text: response, passed, violations, durationMs: 0, costUsd: 0 });
    if (passed) runsPassed++;
    const runsRequired = Math.ceil(1 / 2); // 1 run
    const runsPassed_check = runsPassed >= runsRequired;
    return {
      id: testCase.id,
      category: testCase.category,
      severity: testCase.severity ?? "high",
      passed: runsPassed_check,
      runsExecuted: 1,
      runsPassed,
      runsRequired,
      perRun,
      retrieval,
      totalDurationMs: 0,
      totalCostUsd: 0,
    };
  }

  // Build system prompt and call LLM
  const systemPrompt = modules.buildSystemPrompt(siteContext, viewContext, retrievalChunks, retrieval.tier);

  for (let run = 0; run < runs; run++) {
    try {
      // For OpenAI with runs > 1, use distinct seeds (1-indexed). Anthropic doesn't support seed.
      const seed = runs > 1 && opts.provider === "openai" ? run + 1 : undefined;

      const cacheKey = getCacheKey({
        provider: opts.provider as "openai" | "anthropic",
        model: opts.model,
        systemPrompt,
        messages,
        temperature: 0,
        seed,
      });

      let result = loadFromCache(cacheKey, opts.noCache);
      if (!result) {
        result = await generateResponse({
          provider: opts.provider as "openai" | "anthropic",
          model: opts.model,
          systemPrompt,
          messages,
          temperature: 0,
          siteContext,
          viewContext,
          retrieval,
          seed,
        });
        saveToCache(cacheKey, result);
      }

      const { passed, violations } = checkAssertions(result.text, testCase);
      perRun.push({
        text: result.text,
        passed,
        violations,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
      });

      if (passed) runsPassed++;
      totalDurationMs += result.durationMs;
      totalCostUsd += result.costUsd;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      perRun.push({
        text: "",
        passed: false,
        violations: [],
        durationMs: 0,
        costUsd: 0,
        error: errMsg,
      });
    }
  }

  const expectedTierMatch =
    !testCase.expectedTier || (retrieval && retrieval.tier === testCase.expectedTier);

  // Majority-pass logic: ceil(runs / 2) required to pass
  const runsRequired = Math.ceil(runs / 2);
  const runsPassed_check = runsPassed >= runsRequired;

  return {
    id: testCase.id,
    category: testCase.category,
    severity: testCase.severity ?? "high",
    passed: runsPassed_check && expectedTierMatch,
    runsExecuted: runs,
    runsPassed,
    runsRequired,
    perRun,
    retrieval,
    expectedTierMatch,
    totalDurationMs,
    totalCostUsd,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  opts.model = opts.model || (opts.provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5");
  const testCases = loadTestCases(opts);

  console.log(
    `\n[CLEO REPLAY] ${opts.provider} ${opts.model} (temp=0)\n`,
  );

  if (testCases.length === 0) {
    console.log("No test cases found.");
    process.exit(0);
  }

  console.log(`Cases to run: ${testCases.length}`);
  console.log("");

  const modules = await loadChatbotModules();
  const results: RunResult[] = [];
  const startTime = Date.now();

  // Type-safe opts
  const typedOpts: { provider: "openai" | "anthropic"; model: string; noCache: boolean; singleRun: boolean } = {
    provider: opts.provider as "openai" | "anthropic",
    model: opts.model,
    noCache: opts.noCache,
    singleRun: opts.singleRun,
  };

  // Group by severity
  const bySeverity = {
    critical: testCases.filter((c) => c.severity === "critical"),
    high: testCases.filter((c) => c.severity === "high" || !c.severity),
    medium: testCases.filter((c) => c.severity === "medium"),
  };

  let totalCases = 0;
  for (const severity of ["critical", "high", "medium"] as const) {
    const cases = bySeverity[severity];
    for (let i = 0; i < cases.length; i++) {
      const testCase = cases[i];
      totalCases++;

      process.stdout.write(
        `[${totalCases}/${testCases.length}] ${testCase.id} [${testCase.severity || "high"}] ... `,
      );

      const result = await runTestCase(testCase, typedOpts, modules);
      results.push(result);

      if (result.perRun[0]?.error) {
        console.log(`ERROR: ${result.perRun[0].error}`);
      } else if (result.passed) {
        console.log(
          `PASS (${result.perRun[0]?.durationMs}ms, $${result.totalCostUsd.toFixed(4)})`,
        );
      } else {
        const runsReqStr = result.runsRequired !== undefined ? `, ${result.runsRequired} required` : "";
        console.log(`FAIL (${result.runsPassed}/${result.runsExecuted} passed${runsReqStr})`);
        for (const violation of result.perRun[0]?.violations || []) {
          console.log(`  - ${violation}`);
        }
      }

      if (opts.failFast && !result.passed && severity === "critical") {
        break;
      }
    }

    if (opts.failFast && results.some((r) => !r.passed && r.severity === "critical")) {
      break;
    }
  }

  // Write run file
  const gitSha = "unknown"; // Would need git integration
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const runFilePath = path.join(RUNS_DIR, `${gitSha}-${timestamp}.jsonl`);

  for (const result of results) {
    fs.appendFileSync(runFilePath, JSON.stringify(result) + "\n");
  }

  // Summary
  console.log("\n=== CLEO REPLAY SUMMARY ===\n");

  const criticalPass = results.filter((r) => r.severity === "critical" && r.passed).length;
  const criticalTotal = results.filter((r) => r.severity === "critical").length;
  const highPass = results.filter((r) => r.severity === "high" && r.passed).length;
  const highTotal = results.filter((r) => r.severity === "high").length;
  const mediumPass = results.filter((r) => r.severity === "medium" && r.passed).length;
  const mediumTotal = results.filter((r) => r.severity === "medium").length;

  console.log(
    `critical: ${criticalPass}/${criticalTotal} PASS (${((criticalPass / (criticalTotal || 1)) * 100).toFixed(0)}%)`,
  );
  console.log(`high:     ${highPass}/${highTotal} PASS (${((highPass / (highTotal || 1)) * 100).toFixed(0)}%)`);
  console.log(
    `medium:   ${mediumPass}/${mediumTotal} PASS (${((mediumPass / (mediumTotal || 1)) * 100).toFixed(0)}%)`,
  );

  const totalPass = results.filter((r) => r.passed).length;
  const totalCost = results.reduce((sum, r) => sum + r.totalCostUsd, 0);
  const wallClockMs = Date.now() - startTime;

  console.log(`\nTotal: ${totalPass}/${results.length} passed`);
  console.log(`Wall clock: ${(wallClockMs / 1000 / 60).toFixed(1)}m`);
  console.log(`Cost: $${totalCost.toFixed(2)}`);
  console.log(`Run saved: ${runFilePath}\n`);

  process.exit(criticalPass < criticalTotal ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
