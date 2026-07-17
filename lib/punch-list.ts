// Pure "what to fix next" builder for the onboarding ready-modal punch list.
// NO server imports — deterministic, side-effect-free, unit-tested.
//
// Given one run's responses, produce up to 5 actionable items:
//   - coverage: which of the 4 canonical platforms mentioned the brand
//   - quote:    up to 2 verbatim brand-mention snippets (sentence-trimmed)
//   - gap:      per-platform "didn't mention you for N prompts — cites instead"
//   - none:     honest zero-mention framing + who AI cites instead
import { PLATFORM_LABEL, PLATFORM_ORDER } from "@/app/brands/[id]/platforms";

/** A run response as the punch list reads it. `error` marks a failed call. */
export interface PunchResponse {
  platform: string;
  responseText: string | null;
  brandMentioned: boolean;
  sentiment: string | null;
  citedUrls: string[];
  /** Set when the provider call errored — such rows are excluded entirely. */
  error?: string | null;
}

export interface CoverageItem {
  kind: "coverage";
  platforms: Array<{ platform: string; platformLabel: string; mentioned: boolean }>;
}

export interface QuoteItem {
  kind: "quote";
  platform: string;
  platformLabel: string;
  sentiment: string | null;
  /** Word-boundary preview (≤200 chars). */
  quote: string;
  /** Full sentence(s) — equal to `quote` when nothing was trimmed. */
  quoteFull: string;
}

export interface GapItem {
  kind: "gap";
  platform: string;
  platformLabel: string;
  missedPrompts: number;
  topDomains: string[];
}

export interface NoneItem {
  kind: "none";
  topDomains: string[];
}

export type PunchItem = CoverageItem | QuoteItem | GapItem | NoneItem;

export interface PunchList {
  items: PunchItem[];
  anyMention: boolean;
}

const MAX_ITEMS = 5;
const MAX_QUOTES = 2;
const QUOTE_MAX_CHARS = 200;
const TOP_DOMAINS = 3;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Rank non-brand cited domains by frequency (desc), deduped, first-seen order
 * breaking ties. `brandDomain` is excluded.
 */
function topCitedDomains(
  responses: PunchResponse[],
  brandDomain: string,
  limit = TOP_DOMAINS,
): string[] {
  const brandHost = brandDomain.replace(/^www\./, "").toLowerCase();
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const r of responses) {
    for (const url of r.citedUrls) {
      const host = hostOf(url);
      if (!host || host === brandHost || host.endsWith(`.${brandHost}`)) continue;
      if (!counts.has(host)) order.push(host);
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }
  return order
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || order.indexOf(a) - order.indexOf(b))
    .slice(0, limit);
}

/**
 * Extract the sentence(s) that name the brand. Returns the full sentence(s) plus
 * a ≤200-char preview cut on a word boundary (never mid-word). Null when the
 * brand string never appears in the text (defensive — a stored brandMentioned
 * flag can outrun the actual text).
 */
function brandSentence(text: string | null, brandName: string): { quote: string; quoteFull: string } | null {
  if (!text) return null;
  const needle = brandName.trim().toLowerCase();
  if (!needle || !text.toLowerCase().includes(needle)) return null;
  // Split into sentences, keep those containing the brand.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const hits = sentences.filter((s) => s.toLowerCase().includes(needle)).map((s) => s.trim());
  const full = (hits.length ? hits.join(" ") : text).trim();
  if (full.length <= QUOTE_MAX_CHARS) return { quote: full, quoteFull: full };
  // Break on the last whitespace within the limit so the preview never ends mid-word.
  const slice = full.slice(0, QUOTE_MAX_CHARS - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
  return { quote: `${cut}…`, quoteFull: full };
}

export function buildPunchList(
  responses: PunchResponse[],
  opts: { brandName: string; brandDomain: string },
): PunchList {
  const live = responses.filter((r) => !r.error);
  if (live.length === 0) return { items: [], anyMention: false };

  const anyMention = live.some((r) => r.brandMentioned);
  const items: PunchItem[] = [];

  // (a) Coverage grid — always first. Any live mention on a platform counts.
  const mentionedByPlatform = new Set(live.filter((r) => r.brandMentioned).map((r) => r.platform));
  items.push({
    kind: "coverage",
    platforms: PLATFORM_ORDER.map((platform) => ({
      platform,
      platformLabel: PLATFORM_LABEL[platform] ?? platform,
      mentioned: mentionedByPlatform.has(platform),
    })),
  });

  // (b) Up to 2 verbatim quote cards.
  for (const r of live) {
    if (items.filter((i) => i.kind === "quote").length >= MAX_QUOTES) break;
    if (!r.brandMentioned) continue;
    const quote = brandSentence(r.responseText, opts.brandName);
    if (!quote) continue;
    items.push({
      kind: "quote",
      platform: r.platform,
      platformLabel: PLATFORM_LABEL[r.platform] ?? r.platform,
      sentiment: r.sentiment,
      quote: quote.quote,
      quoteFull: quote.quoteFull,
    });
  }

  if (!anyMention) {
    // (d) Zero mentions anywhere — honest framing, who AI cites instead.
    items.push({ kind: "none", topDomains: topCitedDomains(live, opts.brandDomain) });
  } else {
    // (c) Per-platform gap items, in canonical order.
    for (const platform of PLATFORM_ORDER) {
      const platformResponses = live.filter((r) => r.platform === platform);
      const missed = platformResponses.filter((r) => !r.brandMentioned);
      if (missed.length === 0) continue;
      items.push({
        kind: "gap",
        platform,
        platformLabel: PLATFORM_LABEL[platform] ?? platform,
        missedPrompts: missed.length,
        topDomains: topCitedDomains(missed, opts.brandDomain),
      });
    }
  }

  return { items: items.slice(0, MAX_ITEMS), anyMention };
}
