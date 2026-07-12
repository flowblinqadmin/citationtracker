// Getting-started checklist derivation. Pure, unit-tested core for the
// dismissible GettingStarted card on the brand Overview tab. Given the current
// brand state, produce the ordered checklist rows; the UI renders them and
// auto-hides the whole card when every item is done.
import type { TrackerRunFrequency } from "@/lib/types/tracker";

export interface ChecklistInput {
  brandId: string;
  hasCompetitors: boolean;
  hasTrackedUrls: boolean;
  hasRuns: boolean;
  runFrequency: TrackerRunFrequency;
}

export interface ChecklistItem {
  key: "brand" | "competitors" | "tracked-urls" | "first-run" | "schedule";
  label: string;
  done: boolean;
  /** Where an unchecked row navigates; omitted for always-done rows. */
  href?: string;
}

/** localStorage key for the per-brand dismissal flag. */
export function dismissKey(brandId: string): string {
  return `cite-gs-dismissed-${brandId}`;
}

/**
 * The checklist rows for a brand. Returns [] when everything is complete so
 * the card unmounts entirely (no empty "all done" state to dismiss).
 */
export function checklistItems(input: ChecklistInput): ChecklistItem[] {
  const items: ChecklistItem[] = [
    { key: "brand", label: "Brand created", done: true },
    {
      key: "competitors",
      label: "Competitors added",
      done: input.hasCompetitors,
      href: `/brands/${input.brandId}?tab=overview`,
    },
    {
      key: "tracked-urls",
      label: "Publicity URLs tracked",
      done: input.hasTrackedUrls,
      href: `/brands/${input.brandId}?tab=overview`,
    },
    {
      key: "first-run",
      label: "First report run",
      done: input.hasRuns,
      href: `/brands/${input.brandId}?tab=prompts`,
    },
    {
      key: "schedule",
      label: "Schedule set",
      done: input.runFrequency !== "manual",
      href: "/onboarding",
    },
  ];
  if (items.every((i) => i.done)) return [];
  return items;
}
