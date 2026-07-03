/**
 * Polling utility for integration tests.
 * Retries an async predicate until it returns a truthy result or times out.
 */

/**
 * Poll fn() until predicate(result) returns true.
 * Returns the result when predicate passes.
 * Throws a descriptive error on timeout.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  predicate: (result: T) => boolean,
  timeoutMs: number,
  intervalMs: number,
  label = "pollUntil"
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: T | null | undefined;

  while (Date.now() < deadline) {
    lastResult = await fn();
    if (lastResult != null && predicate(lastResult as T)) {
      return lastResult as T;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `${label}: timed out after ${timeoutMs}ms. Last result: ${JSON.stringify(lastResult)}`
  );
}

/**
 * Wait for a condition to become true, retrying every intervalMs.
 * Simpler version of pollUntil for boolean predicates.
 */
export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
  label = "waitUntil"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Measure elapsed time for a promise.
 * Returns { result, elapsedMs }.
 */
export async function timed<T>(
  fn: () => Promise<T>
): Promise<{ result: T; elapsedMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, elapsedMs: Date.now() - start };
}
