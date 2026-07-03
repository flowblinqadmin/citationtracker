/**
 * Unit tests for canonicalizeEmail (NEW-A-02 fix)
 *
 * canonicalizeEmail normalises Gmail addresses (gmail.com + googlemail.com) by:
 *   - Stripping dots from the local-part
 *   - Dropping the sub-address suffix (everything from `+` onwards)
 *   - Normalising googlemail.com → gmail.com
 *
 * For all other providers it only lowercases + trims (no over-normalisation).
 */

import { describe, it, expect } from "vitest";
import { canonicalizeEmail } from "@/lib/email-canonical";

describe("canonicalizeEmail — Gmail canonicalization", () => {
  it("strips dots from Gmail local-part", () => {
    expect(canonicalizeEmail("u.s.e.r@gmail.com")).toBe("user@gmail.com");
  });

  it("strips plus sub-address from Gmail", () => {
    expect(canonicalizeEmail("user+promo@gmail.com")).toBe("user@gmail.com");
  });

  it("strips both dots and plus sub-address from Gmail", () => {
    expect(canonicalizeEmail("u.s.er+x@gmail.com")).toBe("user@gmail.com");
  });

  it("lowercases Gmail addresses", () => {
    expect(canonicalizeEmail("U.S.Er+Promo@Gmail.com")).toBe("user@gmail.com");
  });

  it("normalises googlemail.com → gmail.com", () => {
    expect(canonicalizeEmail("user@googlemail.com")).toBe("user@gmail.com");
  });

  it("normalises googlemail.com with dots and plus", () => {
    expect(canonicalizeEmail("u.s.er+tag@googlemail.com")).toBe("user@gmail.com");
  });

  it("u.ser+promo@gmail.com equals user@gmail.com (the aliasing bypass case)", () => {
    const alias = canonicalizeEmail("u.ser+promo@gmail.com");
    const base = canonicalizeEmail("user@gmail.com");
    expect(alias).toBe(base);
  });

  it("trims leading/trailing whitespace", () => {
    expect(canonicalizeEmail("  user@gmail.com  ")).toBe("user@gmail.com");
  });

  it("plain gmail address is already canonical", () => {
    expect(canonicalizeEmail("user@gmail.com")).toBe("user@gmail.com");
  });
});

describe("canonicalizeEmail — non-Gmail addresses left unchanged (except lowercase+trim)", () => {
  it("does NOT strip dots from Outlook local-part", () => {
    expect(canonicalizeEmail("a.b+c@outlook.com")).toBe("a.b+c@outlook.com");
  });

  it("does NOT strip plus sub-address from Yahoo", () => {
    expect(canonicalizeEmail("user+tag@yahoo.com")).toBe("user+tag@yahoo.com");
  });

  it("does NOT strip dots from custom domain", () => {
    expect(canonicalizeEmail("first.last@company.io")).toBe("first.last@company.io");
  });

  it("lowercases non-Gmail addresses", () => {
    expect(canonicalizeEmail("User@Example.COM")).toBe("user@example.com");
  });

  it("trims non-Gmail addresses", () => {
    expect(canonicalizeEmail("  user@hotmail.com  ")).toBe("user@hotmail.com");
  });

  it("a.b+c@outlook.com and a.b@outlook.com are DISTINCT (not merged)", () => {
    expect(canonicalizeEmail("a.b+c@outlook.com")).not.toBe(
      canonicalizeEmail("a.b@outlook.com")
    );
  });
});

describe("canonicalizeEmail — edge cases", () => {
  it("returns lowercased input unchanged for addresses without @", () => {
    expect(canonicalizeEmail("notanemail")).toBe("notanemail");
  });

  it("handles empty string", () => {
    expect(canonicalizeEmail("")).toBe("");
  });

  it("handles multiple + signs in Gmail (splits on first +)", () => {
    // user+a+b@gmail.com → user (split on first +, rest discarded)
    expect(canonicalizeEmail("user+a+b@gmail.com")).toBe("user@gmail.com");
  });
});
