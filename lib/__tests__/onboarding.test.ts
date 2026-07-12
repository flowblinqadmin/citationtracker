// Pure onboarding-wizard logic: default prompts, suggested-prompt merge, run
// cost, and step-navigation gating. No server imports — unit-testable.
import { describe, it, expect } from "vitest";
import {
  brandFromDomain,
  buildDefaultPrompts,
  mergeSuggestedPrompts,
  runCost,
  canProceed,
  initialWizardState,
  type WizardState,
} from "@/lib/onboarding";
import { PROMPT_CATEGORIES } from "@/lib/prompt-library";

const CATS = new Set(PROMPT_CATEGORIES);

describe("brandFromDomain", () => {
  it("capitalizes the core label of a plain two-part domain", () => {
    expect(brandFromDomain("acme.com")).toBe("Acme");
  });

  it("picks the third-from-last label for a multi-label host (current heuristic)", () => {
    // labels = [shop, acme, co, uk] → labels[length-3] = "acme" → "Acme".
    // (Pins actual behavior: the two-part TLD + subdomain are both skipped.)
    expect(brandFromDomain("shop.acme.co.uk")).toBe("Acme");
  });

  it("only upper-cases the first char, leaving hyphenated labels intact", () => {
    expect(brandFromDomain("drive-buddy.ai")).toBe("Drive-buddy");
  });

  it("returns '' for a single-label host with no TLD (normalizeDomain rejects it)", () => {
    expect(brandFromDomain("localhost")).toBe("");
  });

  it("returns '' for empty or garbage input", () => {
    expect(brandFromDomain("")).toBe("");
    expect(brandFromDomain("   ")).toBe("");
    expect(brandFromDomain("not a domain!!")).toBe("");
  });

  it("normalizes scheme / www / path before deriving the name", () => {
    expect(brandFromDomain("https://www.Acme.com/about")).toBe("Acme");
  });
});

describe("buildDefaultPrompts", () => {
  it("returns exactly 15 prompts", () => {
    expect(buildDefaultPrompts("Acme")).toHaveLength(15);
  });

  it("fills the {brand} token with the brand name and leaves no token behind", () => {
    for (const p of buildDefaultPrompts("Acme")) {
      expect(p.text).not.toContain("{brand}");
      expect(p.text).toContain("Acme");
    }
  });

  it("marks every default selected:true", () => {
    expect(buildDefaultPrompts("Acme").every((p) => p.selected)).toBe(true);
  });

  it("uses only allowed categories and non-empty names", () => {
    for (const p of buildDefaultPrompts("Acme")) {
      expect(CATS.has(p.category)).toBe(true);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.text.length).toBeGreaterThan(0);
    }
  });

  it("handles brand names with regex-special / repeated tokens safely", () => {
    const prompts = buildDefaultPrompts("A$1 & Co.");
    expect(prompts).toHaveLength(15);
    expect(prompts.every((p) => p.text.includes("A$1 & Co.") && !p.text.includes("{brand}"))).toBe(true);
  });
});

describe("mergeSuggestedPrompts", () => {
  const defaults = buildDefaultPrompts("Acme");

  it("returns a 15-item pre-checked list with suggested first (category), leftovers appended unchecked", () => {
    const suggested = ["Best CRM for small teams in 2026", "Top invoicing tools for freelancers"];
    const merged = mergeSuggestedPrompts(suggested, defaults);

    // First two are the LLM suggestions, category "category", selected.
    expect(merged[0].text).toBe("Best CRM for small teams in 2026");
    expect(merged[0].category).toBe("category");
    expect(merged[0].selected).toBe(true);
    expect(merged[1].text).toBe("Top invoicing tools for freelancers");
    expect(merged[1].selected).toBe(true);

    // 15 are pre-checked (suggested replace defaults from the front).
    const checked = merged.filter((p) => p.selected);
    expect(checked).toHaveLength(15);

    // The two suggestions displaced two defaults, which are appended unchecked.
    const extras = merged.filter((p) => !p.selected);
    expect(extras).toHaveLength(2);
    expect(extras.every((p) => !p.selected)).toBe(true);
    expect(merged).toHaveLength(17);
  });

  it("derives a name from the first ~6 words of a suggestion", () => {
    const merged = mergeSuggestedPrompts(
      ["What are the very best alternatives to modern billing platforms today"],
      defaults,
    );
    // name is the first ~6 words
    expect(merged[0].name.split(/\s+/).length).toBeLessThanOrEqual(6);
    expect(merged[0].name.startsWith("What are the very best")).toBe(true);
  });

  it("dedupes suggestions case-insensitively against defaults", () => {
    const dupText = defaults[0].text;
    const merged = mergeSuggestedPrompts([dupText.toUpperCase()], defaults);
    // The duplicate is dropped — no double of that text, still 15 checked.
    const occurrences = merged.filter((p) => p.text.toLowerCase() === dupText.toLowerCase());
    expect(occurrences).toHaveLength(1);
    expect(merged.filter((p) => p.selected)).toHaveLength(15);
  });

  it("dedupes suggestions against each other (keeps first)", () => {
    const merged = mergeSuggestedPrompts(["Same query here", "same query here"], defaults);
    const dups = merged.filter((p) => p.text.toLowerCase() === "same query here");
    expect(dups).toHaveLength(1);
  });

  it("with no suggestions returns the 15 defaults, all checked, no extras", () => {
    const merged = mergeSuggestedPrompts([], defaults);
    expect(merged).toHaveLength(15);
    expect(merged.every((p) => p.selected)).toBe(true);
  });

  it("ignores blank/whitespace-only suggestions", () => {
    const merged = mergeSuggestedPrompts(["   ", ""], defaults);
    expect(merged.filter((p) => p.selected)).toHaveLength(15);
    expect(merged).toHaveLength(15);
  });

  it("caps the pre-checked list at 15 even with many suggestions", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Suggested query number ${i}`);
    const merged = mergeSuggestedPrompts(many, defaults);
    expect(merged.filter((p) => p.selected)).toHaveLength(15);
    // All 15 defaults are displaced and appended unchecked.
    expect(merged.filter((p) => !p.selected)).toHaveLength(15);
  });
});

describe("runCost", () => {
  it("is selectedCount × 4 platforms × 2 credits", () => {
    expect(runCost(1)).toEqual({ credits: 8 });
    expect(runCost(15)).toEqual({ credits: 120 });
  });

  it("returns {credits:0} for 0 selected and never throws", () => {
    expect(runCost(0)).toEqual({ credits: 0 });
    expect(() => runCost(0)).not.toThrow();
    expect(() => runCost(-3)).not.toThrow();
    expect(runCost(-3)).toEqual({ credits: 0 });
  });
});

describe("canProceed", () => {
  const base = (): WizardState => initialWizardState();

  describe("step 1 — brand", () => {
    it("blocks on an empty name", () => {
      const s = { ...base(), domain: "acme.com", brandName: "  " };
      expect(canProceed(1, s)).toBe(false);
    });
    it("blocks on an invalid domain", () => {
      const s = { ...base(), domain: "not a domain", brandName: "Acme" };
      expect(canProceed(1, s)).toBe(false);
    });
    it("blocks on an empty domain", () => {
      const s = { ...base(), domain: "", brandName: "Acme" };
      expect(canProceed(1, s)).toBe(false);
    });
    it("passes with a valid domain and a name", () => {
      const s = { ...base(), domain: "https://www.Acme.com/about", brandName: "Acme" };
      expect(canProceed(1, s)).toBe(true);
    });
  });

  describe("step 2 — competitors (optional)", () => {
    it("passes with no competitors", () => {
      expect(canProceed(2, base())).toBe(true);
    });
    it("passes with valid competitor rows", () => {
      const s = { ...base(), competitors: [{ name: "Rival", domain: "rival.com" }] };
      expect(canProceed(2, s)).toBe(true);
    });
    it("blocks when a competitor row is missing a name", () => {
      const s = { ...base(), competitors: [{ name: "", domain: "rival.com" }] };
      expect(canProceed(2, s)).toBe(false);
    });
    it("blocks when a competitor domain is invalid", () => {
      const s = { ...base(), competitors: [{ name: "Rival", domain: "bogus" }] };
      expect(canProceed(2, s)).toBe(false);
    });
    it("blocks on more than 10 competitors", () => {
      const competitors = Array.from({ length: 11 }, (_, i) => ({ name: `C${i}`, domain: `c${i}.com` }));
      expect(canProceed(2, { ...base(), competitors })).toBe(false);
    });
  });

  describe("step 3 — prompts", () => {
    it("blocks with 0 selected prompts", () => {
      const prompts = buildDefaultPrompts("Acme").map((p) => ({ ...p, selected: false }));
      expect(canProceed(3, { ...base(), prompts })).toBe(false);
    });
    it("passes with at least 1 selected prompt", () => {
      const prompts = buildDefaultPrompts("Acme");
      expect(canProceed(3, { ...base(), prompts })).toBe(true);
    });
  });

  describe("step 4 — tracked URLs (optional)", () => {
    it("passes with no URLs", () => {
      expect(canProceed(4, base())).toBe(true);
    });
    it("passes with up to 50 URLs", () => {
      const trackedUrls = Array.from({ length: 50 }, (_, i) => `https://o${i}.com/p`);
      expect(canProceed(4, { ...base(), trackedUrls })).toBe(true);
    });
    it("blocks on more than 50 URLs", () => {
      const trackedUrls = Array.from({ length: 51 }, (_, i) => `https://o${i}.com/p`);
      expect(canProceed(4, { ...base(), trackedUrls })).toBe(false);
    });
  });

  it("step 5 (or unknown) never blocks navigation", () => {
    expect(canProceed(5, base())).toBe(true);
  });
});
