/**
 * Tests for sample-bulk-audit.csv file integrity — ES-005-sample
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const CSV_PATH = path.join(__dirname, "../../../public/sample-bulk-audit.csv");

describe("sample-bulk-audit.csv", () => {
  const content = readFileSync(CSV_PATH, "utf-8");
  const lines = content.split(/\r?\n/).filter(Boolean);

  it("has url header in first row", () => {
    expect(lines[0]).toBe("url");
  });

  it("has 5 valid https URLs in rows 2-6", () => {
    const dataLines = lines.slice(1);
    expect(dataLines.length).toBe(5);
    for (const line of dataLines) {
      expect(() => new URL(line)).not.toThrow();
      expect(line.startsWith("https://")).toBe(true);
    }
  });

  it("is valid UTF-8 with no BOM", () => {
    expect(content.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("parses correctly with CRLF line endings", () => {
    const crlf = content.replace(/\n/g, "\r\n");
    const crlfLines = crlf.split(/\r?\n/).filter(Boolean);
    expect(crlfLines[0]).toBe("url");
    expect(crlfLines.slice(1).length).toBe(5);
  });

  it("header row url is skipped by normalizeUrl (no dot)", async () => {
    // Simulates the CSV parser behavior — "url" has no dot so normalizeUrl returns null
    const { normalizeUrl } = await import("@/lib/utils");
    expect(normalizeUrl("url")).toBeNull();
  });
});
