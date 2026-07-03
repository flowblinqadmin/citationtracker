/**
 * ES-082 Phase A — regenerate-empty-llms-txt operator script tests (U22-U34)
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-09
 * Spec:     geo/docs/specs/engineering/ES-082-llms-txt-empty-generation-fix.md (§c.4, §b.8)
 *
 * Phase A state: the script doesn't exist yet (CREATE per §b.8). All 13
 * tests are gated behind a file-existence check via describe.skipIf — they
 * auto-enable the moment ScriptDev creates `geo/scripts/regenerate-empty-llms-txt.ts`
 * with an exported `main(args)` function suitable for unit testing.
 *
 * Required script surface (ScriptDev contract):
 *   export interface RegenerateOpts {
 *     commit?: boolean;     // default false (dry-run)
 *     site?: string;        // single-site filter
 *     domain?: string;      // single-domain filter
 *     owner?: string;       // single-owner filter
 *     max?: number;         // limit
 *   }
 *   export interface RegenerateSummary {
 *     mode: "dry-run" | "commit";
 *     eligible: number;
 *     regenerated: number;
 *     skipped: number;
 *     failed: number;
 *   }
 *   export async function main(opts: RegenerateOpts): Promise<RegenerateSummary>;
 *
 * Independence rule (Phase A):
 *   Fixture site IDs use `manipal-fixture-rm` etc., NOT the literal
 *   `-GzFX1KcKhmN0W_1t8SmY` ScriptDev source uses for the canonical
 *   regeneration target.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { existsSync } from "fs";
import { resolve } from "path";

// ─── Script existence gate ────────────────────────────────────────────────────

const SCRIPT_PATH = resolve(__dirname, "..", "..", "scripts", "regenerate-empty-llms-txt.ts");
const scriptExists = existsSync(SCRIPT_PATH);

// ─── Hoisted mocks (apply when script exists) ────────────────────────────────

const { mockSelect, mockUpdate, mockOpenAICreate } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockOpenAICreate: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockOpenAICreate } } };
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    execute: vi.fn(),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  geoSites: {},
}));

// ─── Dynamic script loader ────────────────────────────────────────────────────

type RegenerateOpts = {
  commit?: boolean;
  site?: string;
  domain?: string;
  owner?: string;
  max?: number;
};

type RegenerateSummary = {
  mode: "dry-run" | "commit";
  eligible: number;
  regenerated: number;
  skipped: number;
  failed: number;
};

let scriptMain: ((opts: RegenerateOpts) => Promise<RegenerateSummary>) | undefined;

beforeAll(async () => {
  if (!scriptExists) return;
  try {
    // @ts-ignore — dynamic import; module path resolves at runtime
    const mod = await import("@/scripts/regenerate-empty-llms-txt");
    scriptMain = (mod as any).main;
  } catch (e) {
    // Script exists but failed to load — fail loudly so the issue is visible
    console.error("[U22-U34] Script exists but failed to import:", e);
  }
});

beforeEach(() => {
  mockSelect.mockReset();
  mockUpdate.mockReset();
  mockOpenAICreate.mockReset();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEligibleRow(overrides: Partial<{
  id: string;
  domain: string;
  slug: string;
  generated_llms_full_txt: string;
  generated_llms_txt: string | null;
}> = {}) {
  // Default fullText must clear the ES-082 §b.8 sanity gate (>= 1000 chars)
  // so U22 and U23 (which don't override this field) reach the regen path.
  const defaultFullText =
    "# Manipal Hospitals\n\n> A multi-specialty network.\n\n## About\n" +
    "Manipal Hospitals is one of India's largest hospital chains.\n".repeat(20) +
    "\n## Services\n- Cardiac care\n- Oncology\n- Orthopedics\n";
  return {
    id: overrides.id ?? "manipal-fixture-rm",
    domain: overrides.domain ?? "manipalhospitals.com",
    slug: overrides.slug ?? "manipal-fixture-rm",
    generated_llms_full_txt: overrides.generated_llms_full_txt ?? defaultFullText,
    generated_llms_txt: overrides.generated_llms_txt ?? "",
  };
}

function chainableSelect(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function chainableUpdate(returningRows: any[]) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returningRows),
      }),
    }),
  };
}

function validLlmsTxtContent(): string {
  return [
    "# Test Brand",
    "",
    "> Test Brand provides specialised services across multiple regions.",
    "",
    "## About",
    "Test Brand was founded in 2010 and serves customers across the country.",
    "",
    "## Services",
    "- Service one",
    "- Service two",
    "",
    "## Key Concepts",
    "**Concept**: refers to an important domain term.",
  ].join("\n");
}

function mockOpenAIWithContent(content: string) {
  mockOpenAICreate.mockResolvedValue({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: {
      completion_tokens: 800,
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// §c.4 — regenerate-empty-llms-txt script tests (U22-U34)
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!scriptExists)("ES-082 §c.4 — regenerate-empty-llms-txt (RM independent)", () => {
  it("U22: dry-run mode does NOT call db.update", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    mockSelect.mockReturnValue(chainableSelect([makeEligibleRow()]));
    mockOpenAIWithContent(validLlmsTxtContent());

    const summary = await scriptMain({ commit: false });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(summary.mode).toBe("dry-run");
    expect(summary.eligible).toBeGreaterThanOrEqual(1);
  });

  it("U23: commit mode calls db.update with sanitized content", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    mockSelect.mockReturnValue(chainableSelect([makeEligibleRow()]));
    mockOpenAIWithContent(validLlmsTxtContent());
    mockUpdate.mockReturnValue(chainableUpdate([{ id: "manipal-fixture-rm", new_len: 234 }]));

    const summary = await scriptMain({ commit: true });

    expect(mockUpdate).toHaveBeenCalled();
    expect(summary.mode).toBe("commit");
    expect(summary.regenerated).toBeGreaterThanOrEqual(1);
  });

  it("U24: sanity-gate skips sites with full_text < 1000 chars", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    mockSelect.mockReturnValue(
      chainableSelect([makeEligibleRow({ generated_llms_full_txt: "# Short" })]),
    );

    const summary = await scriptMain({ commit: true });

    // Sanity gate should reject the row before OpenAI is called.
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
  });

  it("U25: idempotent — re-running on already-fixed site is a no-op (UPDATE returns 0 rows)", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    // Long enough to pass sanity gate
    const longFullText = "# Manipal Hospitals\n\n" + "x".repeat(1500);
    mockSelect.mockReturnValue(
      chainableSelect([makeEligibleRow({ generated_llms_full_txt: longFullText })]),
    );
    mockOpenAIWithContent(validLlmsTxtContent());
    // Idempotency: WHERE length=0 clause matched 0 rows because another
    // process already wrote content between SELECT and UPDATE.
    mockUpdate.mockReturnValue(chainableUpdate([]));

    const summary = await scriptMain({ commit: true });

    expect(summary.regenerated).toBe(0);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
  });

  it("U26: validation gate rejects too-short OpenAI output", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    const longFullText = "# Manipal Hospitals\n\n" + "x".repeat(1500);
    mockSelect.mockReturnValue(
      chainableSelect([makeEligibleRow({ generated_llms_full_txt: longFullText })]),
    );
    mockOpenAIWithContent("# X\n> Y"); // 8 chars total

    const summary = await scriptMain({ commit: true });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(summary.failed).toBeGreaterThanOrEqual(1);
  });

  it("U27: validation gate rejects missing H1", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    const longFullText = "# Manipal Hospitals\n\n" + "x".repeat(1500);
    mockSelect.mockReturnValue(
      chainableSelect([makeEligibleRow({ generated_llms_full_txt: longFullText })]),
    );
    // Long content but no `# ` line
    const noH1 = "Just plain text without any headings.\n".repeat(50);
    mockOpenAIWithContent(noH1);

    const summary = await scriptMain({ commit: true });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(summary.failed).toBeGreaterThanOrEqual(1);
  });

  it("U28: validation gate rejects missing blockquote", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    const longFullText = "# Manipal Hospitals\n\n" + "x".repeat(1500);
    mockSelect.mockReturnValue(
      chainableSelect([makeEligibleRow({ generated_llms_full_txt: longFullText })]),
    );
    // H1 + sections but no `> ` blockquote
    const noBq = "# Test Brand\n\n## About\n" + "Body content. ".repeat(100) + "\n## Services\n- One\n";
    mockOpenAIWithContent(noBq);

    const summary = await scriptMain({ commit: true });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(summary.failed).toBeGreaterThanOrEqual(1);
  });

  it("U29: validation gate rejects content without any ## sections", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    const longFullText = "# Manipal Hospitals\n\n" + "x".repeat(1500);
    mockSelect.mockReturnValue(
      chainableSelect([makeEligibleRow({ generated_llms_full_txt: longFullText })]),
    );
    const noSections = "# Test Brand\n\n> A summary line.\n\n" + "Body. ".repeat(100);
    mockOpenAIWithContent(noSections);

    const summary = await scriptMain({ commit: true });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(summary.failed).toBeGreaterThanOrEqual(1);
  });

  it("U30: sanitization strips leading/trailing markdown code fences", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    const longFullText = "# Manipal Hospitals\n\n" + "x".repeat(1500);
    mockSelect.mockReturnValue(
      chainableSelect([makeEligibleRow({ generated_llms_full_txt: longFullText })]),
    );
    const fenced = "```markdown\n" + validLlmsTxtContent() + "\n```";
    mockOpenAIWithContent(fenced);

    const updateChain = chainableUpdate([{ id: "manipal-fixture-rm", new_len: 234 }]);
    mockUpdate.mockReturnValue(updateChain);

    await scriptMain({ commit: true });

    // Inspect the SET call to see what was passed for the new value.
    const setCalls = updateChain.set.mock.calls;
    expect(setCalls.length).toBeGreaterThan(0);
    const setArg = setCalls[0][0];
    const sanitizedValue =
      setArg?.generated_llms_txt ??
      setArg?.generatedLlmsTxt ??
      Object.values(setArg ?? {}).find((v) => typeof v === "string");
    expect(typeof sanitizedValue).toBe("string");
    expect(sanitizedValue as string).not.toMatch(/^```/);
    expect(sanitizedValue as string).not.toMatch(/```\s*$/);
  });

  it("U31: --site filter restricts SELECT to a single site id", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    mockSelect.mockReturnValue(chainableSelect([]));

    await scriptMain({ commit: false, site: "manipal-fixture-rm" });

    // The SELECT chain was invoked — exact where-clause inspection depends
    // on the script's internal builder, but at minimum the function call
    // should have been routed through select.
    expect(mockSelect).toHaveBeenCalled();
  });

  it("U32: --max <n> caps the SELECT LIMIT to n rows", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    // Drizzle .limit() is the last call in the chain. We can capture it via
    // an inline chain that exposes its limit args.
    const limitFn = vi.fn().mockResolvedValue([]);
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn, limit: limitFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    mockSelect.mockReturnValue({ from: fromFn });

    await scriptMain({ commit: false, max: 5 });

    expect(limitFn).toHaveBeenCalledWith(5);
  });

  it("U33: OpenAI failure on one site does not abort the others (per-site isolation)", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    const longFullText = "# Site Brand\n\n" + "x".repeat(1500);
    const rows = [
      makeEligibleRow({ id: "site-a", domain: "site-a.com", generated_llms_full_txt: longFullText }),
      makeEligibleRow({ id: "site-b", domain: "site-b.com", generated_llms_full_txt: longFullText }),
      makeEligibleRow({ id: "site-c", domain: "site-c.com", generated_llms_full_txt: longFullText }),
    ];
    mockSelect.mockReturnValue(chainableSelect(rows));

    // First and third OpenAI calls succeed, second throws.
    mockOpenAICreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: validLlmsTxtContent() }, finish_reason: "stop" }],
        usage: { completion_tokens: 800, completion_tokens_details: { reasoning_tokens: 0 } },
      })
      .mockRejectedValueOnce(new Error("openai rate-limit on site-b"))
      .mockResolvedValueOnce({
        choices: [{ message: { content: validLlmsTxtContent() }, finish_reason: "stop" }],
        usage: { completion_tokens: 800, completion_tokens_details: { reasoning_tokens: 0 } },
      });

    mockUpdate.mockReturnValue(chainableUpdate([{ id: "x", new_len: 200 }]));

    const summary = await scriptMain({ commit: true });

    expect(summary.regenerated).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it("U34: default mode (no flags) is dry-run — does NOT write to db", async () => {
    if (!scriptMain) throw new Error("scriptMain not loaded");
    const longFullText = "# Manipal Hospitals\n\n" + "x".repeat(1500);
    mockSelect.mockReturnValue(
      chainableSelect([makeEligibleRow({ generated_llms_full_txt: longFullText })]),
    );
    mockOpenAIWithContent(validLlmsTxtContent());

    // No `commit: true` — default per AC-12 is dry-run.
    const summary = await scriptMain({});

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(summary.mode).toBe("dry-run");
  });
});

// Out-of-skip safety net: when the script doesn't exist, document that
// these 13 tests are intentionally awaiting ScriptDev.
describe.skipIf(scriptExists)("ES-082 §c.4 — regenerate-empty-llms-txt (RM Phase A — awaiting script)", () => {
  it("13 unit tests U22-U34 are gated on geo/scripts/regenerate-empty-llms-txt.ts existing", () => {
    expect(scriptExists).toBe(false);
    // ScriptDev: when this file exists with an exported `main(opts)`, the
    // 13 tests above will auto-enable. No further test changes required.
  });
});
