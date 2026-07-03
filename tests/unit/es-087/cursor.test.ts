/**
 * ES-087 — lib/cursor.ts unit tests
 *
 * Spec-first (RED until lib/cursor.ts is implemented).
 *
 * Covers cursor encoding/decoding invariants for /api/v1/page_views pagination:
 * - round-trip determinism (TS-087 criterion #8)
 * - malformed input rejection
 * - base64url encoding (URL-safe, no %-escaping)
 * - timestamp shape validation (ISO-8601 with optional fractional seconds and Z)
 */
import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, type Cursor } from "@/lib/cursor";

describe("encodeCursor/decodeCursor — round trip (TS-087 #8)", () => {
  it("encodes then decodes a simple cursor without loss", () => {
    const c: Cursor = { viewed_at: "2026-04-21T15:29:45.123Z", id: "abcXYZ123" };
    const encoded = encodeCursor(c);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(c);
  });

  it("produces byte-identical output for identical input (deterministic)", () => {
    const c: Cursor = { viewed_at: "2026-04-21T00:00:00Z", id: "nano-xyz" };
    const a = encodeCursor(c);
    const b = encodeCursor(c);
    const d = encodeCursor(c);
    expect(a).toBe(b);
    expect(b).toBe(d);
  });

  it("round-trips 100 times with the same output (criterion #8)", () => {
    const c: Cursor = { viewed_at: "2026-04-21T12:34:56.789Z", id: "stable-id" };
    const first = encodeCursor(c);
    for (let i = 0; i < 100; i++) {
      expect(encodeCursor(decodeCursor(first))).toBe(first);
    }
  });

  it("preserves id with special characters (nanoid alphabet)", () => {
    const c: Cursor = { viewed_at: "2026-04-21T00:00:00.000Z", id: "_-ABCxyz0123456789" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});

describe("encodeCursor — URL safety", () => {
  it("uses base64url (no +, /, or = characters)", () => {
    const c: Cursor = { viewed_at: "2026-04-21T15:29:45.123Z", id: "nano-test-long-id-1234" };
    const encoded = encodeCursor(c);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("survives URL round trip without %-escaping", () => {
    const c: Cursor = { viewed_at: "2026-04-21T15:29:45.123Z", id: "abc123" };
    const encoded = encodeCursor(c);
    const url = new URL(`https://example.com/api?cursor=${encoded}`);
    expect(url.searchParams.get("cursor")).toBe(encoded);
  });
});

describe("decodeCursor — rejection of malformed input", () => {
  it("throws on non-base64 input", () => {
    expect(() => decodeCursor("!!!not-base64!!!")).toThrow();
  });

  it("throws on base64 that decodes to invalid JSON", () => {
    const notJson = Buffer.from("not json", "utf-8").toString("base64url");
    expect(() => decodeCursor(notJson)).toThrow();
  });

  it("throws when decoded JSON lacks viewed_at", () => {
    const bad = Buffer.from(JSON.stringify({ id: "x" }), "utf-8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow();
  });

  it("throws when decoded JSON lacks id", () => {
    const bad = Buffer.from(JSON.stringify({ viewed_at: "2026-04-21T00:00:00Z" }), "utf-8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow();
  });

  it("throws when viewed_at is not a string", () => {
    const bad = Buffer.from(JSON.stringify({ viewed_at: 123456789, id: "x" }), "utf-8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow();
  });

  it("throws when id is not a string", () => {
    const bad = Buffer.from(JSON.stringify({ viewed_at: "2026-04-21T00:00:00Z", id: 42 }), "utf-8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow();
  });

  it("throws when viewed_at does not match ISO-8601 shape", () => {
    const bad = Buffer.from(JSON.stringify({ viewed_at: "yesterday", id: "x" }), "utf-8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => decodeCursor("")).toThrow();
  });

  it("throws on SQL-injection-shaped payload (sanity, not a real exploit)", () => {
    const bad = Buffer.from(
      JSON.stringify({ viewed_at: "2026-04-21T00:00:00Z'; DROP TABLE geo_page_views; --", id: "x" }),
      "utf-8"
    ).toString("base64url");
    expect(() => decodeCursor(bad)).toThrow();
  });
});

describe("decodeCursor — accepted timestamp shapes", () => {
  it("accepts fractional seconds with Z", () => {
    const c: Cursor = { viewed_at: "2026-04-21T15:29:45.123Z", id: "x" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("accepts no fractional seconds with Z", () => {
    const c: Cursor = { viewed_at: "2026-04-21T15:29:45Z", id: "x" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("accepts no Z suffix (naive UTC)", () => {
    const c: Cursor = { viewed_at: "2026-04-21T15:29:45", id: "x" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("accepts microsecond precision", () => {
    const c: Cursor = { viewed_at: "2026-04-21T15:29:45.123456Z", id: "x" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});
