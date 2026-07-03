/**
 * CLI format tests — F-1 through F-6.
 *
 * Tests geo/cli/format.ts output helpers in isolation.
 *
 * Captures stdout/stderr by spying on process.stdout.write and
 * process.stderr.write — does not replace console.log/error since
 * format.ts writes directly to streams.
 *
 * Functions tested:
 *   printKv(pairs)    — aligned key-value output to stdout
 *   printError(msg)   — "Error: <msg>" to stderr
 *   printSuccess(msg) — "✓ <msg>" to stdout
 *   jsonOut(data)     — JSON.stringify(data, null, 2) + newline to stdout
 *   printProgress(elapsed, status) — "t+<s>s  status=<status>" to stdout
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Stream capture ───────────────────────────────────────────────────────────

let stdoutOutput: string[] = [];
let stderrOutput: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutOutput = [];
  stderrOutput = [];

  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(
    (data: string | Uint8Array) => {
      stdoutOutput.push(typeof data === "string" ? data : Buffer.from(data).toString());
      return true;
    }
  );

  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
    (data: string | Uint8Array) => {
      stderrOutput.push(typeof data === "string" ? data : Buffer.from(data).toString());
      return true;
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Join all captured stdout into one string. */
const stdout = () => stdoutOutput.join("");
/** Join all captured stderr into one string. */
const stderr = () => stderrOutput.join("");

// ─── F-1 / F-2: printKv ──────────────────────────────────────────────────────

describe("format: printKv", () => {
  it("F-1: 3 pairs → each pair on its own line with colon separator", async () => {
    const { printKv } = await import("@/cli/format");

    printKv([
      ["Team ID", "team_abc123"],
      ["Credits", "95"],
      ["Status", "active"],
    ]);

    const out = stdout();
    expect(out).toContain("Team ID");
    expect(out).toContain("team_abc123");
    expect(out).toContain("Credits");
    expect(out).toContain("95");
    expect(out).toContain("Status");
    expect(out).toContain("active");

    // Each pair on a separate line
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("F-2: long label → all labels padded to the same width", async () => {
    const { printKv } = await import("@/cli/format");

    printKv([
      ["Short", "val1"],
      ["A Much Longer Label", "val2"],
      ["Mid label", "val3"],
    ]);

    const out = stdout();
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Find the column position of each value — it should be the same for all lines
    // by checking the offset of the value in each line
    const valueLine1 = lines.find((l) => l.includes("val1"))!;
    const valueLine2 = lines.find((l) => l.includes("val2"))!;
    const valueLine3 = lines.find((l) => l.includes("val3"))!;

    const offsetOf = (line: string, val: string) => line.indexOf(val);
    const offsets = [
      offsetOf(valueLine1, "val1"),
      offsetOf(valueLine2, "val2"),
      offsetOf(valueLine3, "val3"),
    ];

    // All values should start at the same column (aligned)
    expect(offsets[0]).toBe(offsets[1]);
    expect(offsets[1]).toBe(offsets[2]);
  });
});

// ─── F-3 / F-4: Error and success ────────────────────────────────────────────

describe("format: printError and printSuccess", () => {
  it("F-3: printError writes to stderr with 'Error:' prefix", async () => {
    const { printError } = await import("@/cli/format");

    printError("something went wrong");

    expect(stderr()).toContain("Error:");
    expect(stderr()).toContain("something went wrong");
    expect(stdout()).toBe(""); // nothing to stdout
  });

  it("F-4: printSuccess writes to stdout with '✓' prefix", async () => {
    const { printSuccess } = await import("@/cli/format");

    printSuccess("Connected successfully");

    expect(stdout()).toContain("✓");
    expect(stdout()).toContain("Connected successfully");
    expect(stderr()).toBe(""); // nothing to stderr
  });
});

// ─── F-5: jsonOut ─────────────────────────────────────────────────────────────

describe("format: jsonOut", () => {
  it(
    "F-5: jsonOut serializes object as JSON.stringify(data, null, 2) to stdout",
    async () => {
      const { jsonOut } = await import("@/cli/format");

      const data = { teamId: "abc", creditBalance: 42, tools: ["a", "b"] };
      jsonOut(data);

      const out = stdout();
      // Should be parseable JSON
      const parsed = JSON.parse(out);
      expect(parsed.teamId).toBe("abc");
      expect(parsed.creditBalance).toBe(42);
      expect(parsed.tools).toEqual(["a", "b"]);

      // Should be pretty-printed (2-space indent)
      expect(out).toContain("  ");
      expect(out.trim()).toBe(JSON.stringify(data, null, 2));
    }
  );
});

// ─── F-6: printProgress ───────────────────────────────────────────────────────

describe("format: printProgress", () => {
  it(
    "F-6: printProgress writes elapsed seconds and status to stdout",
    async () => {
      const { printProgress } = await import("@/cli/format");

      printProgress(12_500, "running");

      const out = stdout();
      // Contains elapsed in seconds (12500ms → 12s)
      expect(out).toMatch(/t\+12s/);
      // Contains status value
      expect(out).toContain("status=running");
    }
  );
});
