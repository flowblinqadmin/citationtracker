// Pure onboarding-wizard logic — NO server imports. OnboardingWizard.tsx stays
// a thin shell over this so the interesting behaviour is unit-tested.
//
// Covers: the curated default prompt set, merging LLM-suggested prompts on top,
// per-run credit math, wizard state shape, and the per-step "can I advance?"
// gate. Everything here is deterministic and side-effect-free.
import { PROMPT_LIBRARY, fillTemplate } from "@/lib/prompt-library";
import { citationRunCredits } from "@/lib/pricing";
import { normalizeDomain } from "@/lib/domain";
import type { TrackerPromptCategory, TrackerRunFrequency } from "@/lib/types/tracker";

/**
 * Derive a display brand name from a domain. Normalizes first, then picks the
 * "core" label: for a plain `acme.com` that's the first label (`Acme`); for a
 * multi-label host (`>2` labels, e.g. `shop.acme.co.uk`) it's the third-from-last
 * label (`acme` → `Acme`), which skips a leading subdomain and a two-part TLD.
 * Only the first character is upper-cased, so `drive-buddy.ai` → `Drive-buddy`.
 * Returns "" when the input has no plausible hostname (e.g. `localhost`, junk).
 */
export function brandFromDomain(domain: string): string {
  const host = normalizeDomain(domain);
  if (!host) return "";
  const labels = host.split(".");
  const core = labels.length > 2 ? labels[labels.length - 3] : labels[0];
  return core ? core.charAt(0).toUpperCase() + core.slice(1) : "";
}

/** A prompt row as the wizard carries it (before it becomes a real prompt). */
export interface WizardPrompt {
  name: string;
  category: TrackerPromptCategory;
  text: string;
  selected: boolean;
}

/** A competitor row the wizard edits (may be mid-edit / incomplete). */
export interface WizardCompetitor {
  name: string;
  domain: string;
}

// A curated 15 from the library, ~3 per category, ordered brand-first so the
// list reads like a coverage story (who you are → your market → rivals →
// themes → claims). Ids reference PROMPT_LIBRARY entries.
const CURATED_PROMPT_IDS = [
  "brand-what-is",
  "brand-reputable",
  "brand-reviews",
  "brand-products",
  "brand-proscons",
  "cat-leaders",
  "cat-similar-tools",
  "cat-consider",
  "comp-alternatives",
  "comp-compare",
  "comp-biggest",
  "topic-trends",
  "topic-thought",
  "claim-different",
  "claim-leader",
] as const;

/** The 15 curated default prompts, {brand}-filled and all pre-selected. */
export function buildDefaultPrompts(brandName: string): WizardPrompt[] {
  return CURATED_PROMPT_IDS.map((id) => {
    const tpl = PROMPT_LIBRARY.find((t) => t.id === id);
    if (!tpl) throw new Error(`onboarding: unknown curated prompt id ${id}`);
    return {
      name: tpl.name,
      category: tpl.category,
      text: fillTemplate(tpl.template, brandName),
      selected: true,
    };
  });
}

const MAX_PRECHECKED = 15;

/** Derive a short prompt name from the first ~6 words of a suggestion. */
function nameFromText(text: string): string {
  return text.trim().split(/\s+/).slice(0, 6).join(" ");
}

/**
 * Merge LLM-suggested prompts on top of the curated defaults. Suggestions come
 * first (category "category"), dedup'd case-insensitively against each other
 * and the defaults. The pre-checked list stays 15 — each accepted suggestion
 * displaces a default from the FRONT; displaced defaults are appended UNchecked
 * as "extras" the user can opt back in. Blank suggestions are ignored.
 */
export function mergeSuggestedPrompts(
  suggested: string[],
  defaults: WizardPrompt[],
): WizardPrompt[] {
  const seen = new Set(defaults.map((d) => d.text.trim().toLowerCase()));
  const accepted: WizardPrompt[] = [];
  for (const raw of suggested) {
    const text = raw.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({ name: nameFromText(text), category: "category", text, selected: true });
  }

  // Suggestions replace defaults from the front, keeping the checked total ≤ 15.
  const keepDefaults = Math.max(0, MAX_PRECHECKED - accepted.length);
  const checkedDefaults = defaults.slice(0, keepDefaults);
  const extraDefaults = defaults.slice(keepDefaults).map((d) => ({ ...d, selected: false }));
  const checkedSuggestions = accepted.slice(0, MAX_PRECHECKED);

  return [...checkedSuggestions, ...checkedDefaults, ...extraDefaults];
}

/** Credits one run of `selectedCount` prompts costs (4 platforms × 2 credits). */
export function runCost(selectedCount: number): { credits: number } {
  if (!Number.isInteger(selectedCount) || selectedCount <= 0) return { credits: 0 };
  return { credits: citationRunCredits(selectedCount, 4) };
}

// ── Wizard state machine ────────────────────────────────────────────────────

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export interface WizardState {
  step: WizardStep;
  domain: string;
  brandName: string;
  competitors: WizardCompetitor[];
  prompts: WizardPrompt[];
  runFrequency: TrackerRunFrequency;
  trackedUrls: string[];
  /** Suggested prompts stashed from the competitor-suggest response (step 2). */
  suggestedPrompts: string[];
}

export function initialWizardState(): WizardState {
  return {
    step: 1,
    domain: "",
    brandName: "",
    competitors: [],
    prompts: [],
    runFrequency: "monthly",
    trackedUrls: [],
    suggestedPrompts: [],
  };
}

export const MAX_COMPETITORS = 10;
export const MAX_TRACKED_URLS = 50;
export const MAX_PROMPTS = 30;
/** Geo dashboard is where credits are bought (cross-zone; client-safe default). */
export const BUY_CREDITS_FALLBACK = "https://geo.flowblinq.com/dashboard";

function competitorValid(c: WizardCompetitor): boolean {
  return c.name.trim().length > 0 && normalizeDomain(c.domain) !== null;
}

/** Whether the wizard may advance PAST `step` given the current state. */
export function canProceed(step: number, state: WizardState): boolean {
  switch (step) {
    case 1:
      return state.brandName.trim().length > 0 && normalizeDomain(state.domain) !== null;
    case 2:
      // Competitors are optional, but any present row must be complete + valid.
      return state.competitors.length <= MAX_COMPETITORS && state.competitors.every(competitorValid);
    case 3:
      return state.prompts.some((p) => p.selected);
    case 4:
      return state.trackedUrls.length <= MAX_TRACKED_URLS;
    default:
      return true;
  }
}

/** Clamp a step to the 1..5 range (used by the wizard's Back/Continue nav). */
export function clampStep(step: number): WizardStep {
  return Math.max(1, Math.min(5, step)) as WizardStep;
}
