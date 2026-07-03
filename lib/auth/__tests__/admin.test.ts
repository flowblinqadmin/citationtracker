import { describe, test, expect } from "vitest";
import { isAdminEmail } from "../admin";

describe("isAdminEmail", () => {
  test("returns false for null", () => {
    expect(isAdminEmail(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isAdminEmail(undefined)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isAdminEmail("")).toBe(false);
  });

  test("matches the operator email exactly", () => {
    expect(isAdminEmail("ar@flowblinq.com")).toBe(true);
  });

  test("is case-insensitive — uppercase matches", () => {
    expect(isAdminEmail("AR@FLOWBLINQ.COM")).toBe(true);
  });

  test("is case-insensitive — mixed case matches", () => {
    expect(isAdminEmail("Ar@FlowBlinq.Com")).toBe(true);
  });

  test("does NOT match a suffix-injected domain (subdomain attacker.com)", () => {
    expect(isAdminEmail("ar@flowblinq.com.attacker.com")).toBe(false);
  });

  test("does NOT match a prefix-injected local part", () => {
    expect(isAdminEmail("notar@flowblinq.com")).toBe(false);
  });

  test("does NOT match a plus-tag variant unless explicitly allowed", () => {
    expect(isAdminEmail("ar+test@flowblinq.com")).toBe(false);
  });

  test("does NOT match a different domain entirely", () => {
    expect(isAdminEmail("ar@other.com")).toBe(false);
  });

  test("does NOT match whitespace-padded email (no auto-trim)", () => {
    // Trim is the caller's responsibility — this guards against silent normalisation.
    expect(isAdminEmail(" ar@flowblinq.com ")).toBe(false);
  });
});
