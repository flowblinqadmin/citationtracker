// AI Citation Tracker — create a monthly run
//
// Shared by the manual-trigger route and the Phase-3 cron. Snapshots the
// client's active prompt versions (the verbatim text submitted this month) and
// flags which prompts changed since the prior run, for MoM comparability
// reporting. Does NOT enqueue work — the caller (route / cron) enqueues via
// QStash after creation.

import { db } from "@/lib/db";
import {
  trackerRuns,
  trackerPrompts,
  trackerPromptVersions,
  trackerResponses,
} from "@/lib/db/schema";
import { and, eq, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { TrackerRun } from "@/lib/db/schema";

export interface ActivePromptVersion {
  promptId: string;
  promptVersionId: string;
  version: number;
  text: string;
  category: string;
}

/**
 * The latest version of every ACTIVE prompt for a client — the exact set the
 * run submits. Both run-create (for counting/flagging) and the worker (for
 * execution) must use this so counts and execution agree.
 */
export async function getActivePromptVersions(clientId: string): Promise<ActivePromptVersion[]> {
  const prompts = await db
    .select()
    .from(trackerPrompts)
    .where(and(eq(trackerPrompts.clientId, clientId), eq(trackerPrompts.status, "active")));

  const out: ActivePromptVersion[] = [];
  for (const p of prompts) {
    const [latest] = await db
      .select()
      .from(trackerPromptVersions)
      .where(eq(trackerPromptVersions.promptId, p.id))
      .orderBy(desc(trackerPromptVersions.version))
      .limit(1);
    if (latest) {
      out.push({
        promptId: p.id,
        promptVersionId: latest.id,
        version: latest.version,
        text: latest.text,
        category: p.category,
      });
    }
  }
  return out;
}

/** Current calendar month as 'YYYY-MM' (UTC). */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Next scheduled run time for a frequency, or null for 'manual' (never auto-runs).
 * weekly = +7 days, monthly = +1 calendar month.
 */
export function computeNextRunAt(
  frequency: "manual" | "weekly" | "monthly",
  now: Date = new Date(),
): Date | null {
  if (frequency === "manual") return null;
  const next = new Date(now);
  if (frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export interface CreateRunResult {
  run: TrackerRun;
  created: boolean; // false only when a SCHEDULED run already existed for the period
  promptVersions: ActivePromptVersion[];
}

/**
 * Snapshot the client's active prompt versions and compute which prompts changed
 * since the most recent prior run (for MoM comparability flagging). Shared by
 * the scheduled and manual run creators.
 */
async function snapshotForRun(clientId: string): Promise<{
  promptVersions: ActivePromptVersion[];
  promptVersionsChanged: string[];
  hadPriorRun: boolean;
}> {
  const promptVersions = await getActivePromptVersions(clientId);

  const [priorRun] = await db
    .select({ id: trackerRuns.id })
    .from(trackerRuns)
    .where(eq(trackerRuns.clientId, clientId))
    .orderBy(desc(trackerRuns.createdAt))
    .limit(1);
  let priorVersionIds = new Set<string>();
  if (priorRun) {
    const rows = await db
      .select({ promptVersionId: trackerResponses.promptVersionId })
      .from(trackerResponses)
      .where(eq(trackerResponses.runId, priorRun.id));
    priorVersionIds = new Set(rows.map((r) => r.promptVersionId));
  }
  const promptVersionsChanged = promptVersions
    .filter((v) => !priorVersionIds.has(v.promptVersionId))
    .map((v) => v.promptId);

  return { promptVersions, promptVersionsChanged, hadPriorRun: !!priorRun };
}

/**
 * Scheduled monthly run — idempotent per (client, period). Used by the cron.
 * The partial unique index (kind='scheduled') makes a second insert a no-op, so
 * repeated cron ticks never create duplicate scheduled runs for the same month.
 */
export async function createScheduledRun(
  clientId: string,
  orgId: string,
  period: string = currentPeriod(),
): Promise<CreateRunResult> {
  const { promptVersions, promptVersionsChanged, hadPriorRun } = await snapshotForRun(clientId);

  const inserted = await db
    .insert(trackerRuns)
    .values({
      id: `tr_${nanoid()}`,
      clientId,
      orgId,
      period,
      kind: "scheduled",
      status: "pending",
      promptsTotal: promptVersions.length,
      promptVersionsChanged: hadPriorRun ? promptVersionsChanged : [],
    })
    .onConflictDoNothing({
      target: [trackerRuns.clientId, trackerRuns.period],
      where: sql`kind = 'scheduled'`,
    })
    .returning();

  if (inserted.length > 0) return { run: inserted[0], created: true, promptVersions };

  const [existing] = await db
    .select()
    .from(trackerRuns)
    .where(
      and(
        eq(trackerRuns.clientId, clientId),
        eq(trackerRuns.period, period),
        eq(trackerRuns.kind, "scheduled"),
      ),
    );
  return { run: existing, created: false, promptVersions };
}

/**
 * Manual "Run now" — ALWAYS creates a new, preserved run (kind='manual'). There
 * is no per-period cap, so re-running a month accumulates history rather than
 * overwriting the prior run.
 */
export async function createManualRun(
  clientId: string,
  orgId: string,
  period: string = currentPeriod(),
): Promise<CreateRunResult> {
  const { promptVersions, promptVersionsChanged, hadPriorRun } = await snapshotForRun(clientId);

  const [run] = await db
    .insert(trackerRuns)
    .values({
      id: `tr_${nanoid()}`,
      clientId,
      orgId,
      period,
      kind: "manual",
      status: "pending",
      promptsTotal: promptVersions.length,
      promptVersionsChanged: hadPriorRun ? promptVersionsChanged : [],
    })
    .returning();

  return { run, created: true, promptVersions };
}
