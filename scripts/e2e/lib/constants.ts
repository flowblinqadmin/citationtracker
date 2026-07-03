/**
 * ES-e2e-fixtures §b.1 + HP-260 — absolute time anchoring for deterministic seeds.
 *
 * Every timestamp column in the seed plan is derived as
 *   `SEED_EPOCH + <fixed-offset>`
 * so consecutive `db:seed:e2e` runs produce byte-identical rows (AC-6).
 * No `Date.now()`, no `new Date()` without a literal arg, no `NOW()`,
 * no drizzle `$defaultFn` fallback. UT-11 enforces this with a static scan.
 */

export const SEED_EPOCH_ISO = "2026-04-01T00:00:00.000Z";
export const SEED_EPOCH = new Date(SEED_EPOCH_ISO);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function offset(ms: number): Date {
  return new Date(SEED_EPOCH.getTime() + ms);
}

// Common anchors used by the fixture plan (§b.2–§b.8).
export const SEED_EPOCH_MINUS_1M  = offset(-1 * MIN);
export const SEED_EPOCH_MINUS_2M  = offset(-2 * MIN);
export const SEED_EPOCH_MINUS_10M = offset(-10 * MIN);
export const SEED_EPOCH_MINUS_1D  = offset(-1 * DAY);
export const SEED_EPOCH_MINUS_2D  = offset(-2 * DAY);
export const SEED_EPOCH_MINUS_30D = offset(-30 * DAY);
export const SEED_EPOCH_MINUS_37D = offset(-37 * DAY);
export const SEED_EPOCH_PLUS_90D  = offset(90 * DAY);
