/**
 * Concurrency test utilities for Vercel + QStash + Postgres stack.
 *
 * These helpers simulate the race conditions that occur in production when
 * multiple Vercel instances, QStash redeliveries, or Postgres read-committed
 * transactions interact.
 *
 * Usage:
 *   import { SimulatedRace, AtomicClaimVerifier, LedgerConsistencyChecker } from "./helpers/concurrency";
 */

import { vi } from "vitest";

/**
 * Simulates concurrent calls to a function where each caller sees "stale" DB state.
 *
 * Models the Vercel multi-instance scenario where two cold-start instances
 * read the same DB row before either writes. Returns all results for assertion.
 *
 * @example
 * const race = new SimulatedRace();
 * // Both callers will see creditsReserved=10
 * race.addCaller(() => POST(makeRequest({ stage: "discover", ... })));
 * race.addCaller(() => POST(makeRequest({ stage: "discover", ... })));
 * const results = await race.run();
 * expect(results.every(r => r.status === 200)).toBe(true);
 */
export class SimulatedRace<T> {
  private callers: (() => Promise<T>)[] = [];

  addCaller(fn: () => Promise<T>): this {
    this.callers.push(fn);
    return this;
  }

  /** Run all callers sequentially (simulates interleaved execution with shared stale mocks) */
  async run(): Promise<T[]> {
    const results: T[] = [];
    for (const caller of this.callers) {
      results.push(await caller());
    }
    return results;
  }
}

/**
 * Verifies that a function uses the atomic claim pattern:
 *   UPDATE ... SET column = NULL WHERE column IS NOT NULL RETURNING column
 *
 * This is the correct pattern for preventing double-refunds and double-credits
 * on Vercel (multiple instances) and Postgres (read-committed isolation).
 *
 * @example
 * const verifier = new AtomicClaimVerifier(db.execute);
 * await markFailed(siteId, error);
 * verifier.assertAtomicClaim("credits_reserved");
 */
export class AtomicClaimVerifier {
  constructor(private executeMock: ReturnType<typeof vi.fn>) {}

  /**
   * Asserts that db.execute was called with SQL that atomically claims
   * a column (SET to NULL + WHERE IS NOT NULL + RETURNING).
   *
   * Since we can't inspect sql tagged template literals in Vitest mocks,
   * this checks that db.execute was called (not db.select + db.update).
   */
  assertUsesExecute(): void {
    if (this.executeMock.mock.calls.length === 0) {
      throw new Error(
        "Expected db.execute to be called (atomic SQL pattern), " +
        "but it was not. The code may be using separate SELECT + UPDATE " +
        "which is not safe under Vercel multi-instance concurrency."
      );
    }
  }
}

/**
 * Checks that credit ledger entries (creditTransactions) have consistent
 * balanceBefore/balanceAfter values.
 *
 * Under Postgres read-committed isolation, a SELECT before UPDATE can return
 * stale data. The correct pattern is UPDATE...RETURNING to derive balances.
 *
 * @example
 * const checker = new LedgerConsistencyChecker();
 * checker.addEntry({ balanceBefore: 50, balanceAfter: 60, creditsChanged: 10 });
 * checker.addEntry({ balanceBefore: 60, balanceAfter: 70, creditsChanged: 10 });
 * checker.assertConsistent(); // passes — each before matches previous after
 */
export class LedgerConsistencyChecker {
  private entries: { balanceBefore: number; balanceAfter: number; creditsChanged: number }[] = [];

  addEntry(entry: { balanceBefore: number; balanceAfter: number; creditsChanged: number }): this {
    this.entries.push(entry);
    return this;
  }

  /** Assert balanceAfter = balanceBefore + creditsChanged for each entry */
  assertInternalConsistency(): void {
    for (const entry of this.entries) {
      if (entry.balanceAfter !== entry.balanceBefore + entry.creditsChanged) {
        throw new Error(
          `Ledger entry inconsistent: balanceBefore=${entry.balanceBefore} + ` +
          `creditsChanged=${entry.creditsChanged} should equal ` +
          `balanceAfter=${entry.balanceAfter} but got ${entry.balanceBefore + entry.creditsChanged}`
        );
      }
    }
  }

  /** Assert sequential entries chain: entry[n].balanceBefore === entry[n-1].balanceAfter */
  assertSequentialConsistency(): void {
    for (let i = 1; i < this.entries.length; i++) {
      if (this.entries[i].balanceBefore !== this.entries[i - 1].balanceAfter) {
        throw new Error(
          `Ledger chain broken at entry ${i}: ` +
          `previous.balanceAfter=${this.entries[i - 1].balanceAfter} ≠ ` +
          `current.balanceBefore=${this.entries[i].balanceBefore}`
        );
      }
    }
  }

  /** Run both internal and sequential consistency checks */
  assertConsistent(): void {
    this.assertInternalConsistency();
    this.assertSequentialConsistency();
  }
}

/**
 * Helper to create a mock sequence where N callers all read the same stale
 * DB state, simulating Vercel multi-instance + Postgres read-committed.
 *
 * @param staleRows The rows that ALL callers will read (simulating pre-write state)
 * @param concurrentCallers Number of concurrent callers
 * @returns A mock implementation function for db.select
 */
export function makeStaleReadMock(staleRows: unknown[], concurrentCallers: number) {
  let callCount = 0;
  return () => {
    callCount++;
    // All callers see the same stale data
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(staleRows),
      limit: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
    };
  };
}
