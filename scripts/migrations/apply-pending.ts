/**
 * scripts/migrations/apply-pending.ts — ES-wave-3 §A2 AC-A2-2 runner.
 *
 * Reads `lib/db/migrations/*.sql` in lexicographic order, queries
 * `__schema_migrations` for already-applied filenames, applies pending files
 * in order (each inside a transaction), and records the applied filename +
 * sha256 checksum into the journal.
 *
 * Usage:
 *   npm run db:migrate:apply-pending             # local DB (DATABASE_URL must point at 127.0.0.1/localhost)
 *   npm run db:migrate:apply-pending -- --prod   # PROD: explicit opt-in; refuses without this flag if URL host is non-local
 *
 * Idempotent: filenames already in __schema_migrations are skipped. Concurrent
 * runs are absorbed by the ON CONFLICT (filename) DO NOTHING semantics of the
 * journal table (HP-W3-MIN-1) and the per-file transaction.
 *
 * No drizzle-kit dependency — uses the `postgres` driver directly so the
 * runner stays decoupled from migration authoring tooling.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import postgres from "postgres";

const MIGRATIONS_DIR = resolve(process.cwd(), "lib/db/migrations");
const JOURNAL_TABLE = "__schema_migrations";

export type ApplyOptions = {
  databaseUrl: string;
  migrationsDir?: string;
  isProd?: boolean;
  /** Override io for unit tests. */
  fs?: {
    readdirSync: typeof readdirSync;
    readFileSync: typeof readFileSync;
    existsSync: typeof existsSync;
  };
  /**
   * Override sql client factory for tests. Default uses postgres driver.
   * The factory must return an object with the minimal interface used here:
   *   - unsafe(text): Promise<unknown>
   *   - end(): Promise<void>
   */
  sqlFactory?: (url: string) => MinimalSqlClient;
  log?: (line: string) => void;
};

export interface MinimalSqlClient {
  unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
  end: () => Promise<void>;
}

export type ApplyResult = {
  applied: string[];
  skipped: string[];
  total_files: number;
};

const LOCAL_HOST_RE = /^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:|\/)/i;

export function isLocalUrl(url: string): boolean {
  return LOCAL_HOST_RE.test(url);
}

export function computeChecksum(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function listMigrationFiles(dir: string, fs = { readdirSync }): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export async function applyPending(opts: ApplyOptions): Promise<ApplyResult> {
  const fs = opts.fs ?? { readdirSync, readFileSync, existsSync };
  const log = opts.log ?? ((s: string) => console.log(s));
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const url = opts.databaseUrl;

  if (!url) throw new Error("[apply-pending] DATABASE_URL is required");

  // Safety gate (AC-A2-2 contract): refuse non-local URLs without --prod.
  if (!isLocalUrl(url) && !opts.isProd) {
    throw new Error(
      "[apply-pending] DATABASE_URL points at a non-local host but --prod was NOT passed. Refusing.",
    );
  }

  const factory = opts.sqlFactory ?? ((u: string) => postgres(u, { max: 1, prepare: false }) as unknown as MinimalSqlClient);
  const sql = factory(url);

  try {
    // Ensure journal table exists. The journal-creation migration may not yet
    // be applied on a brand-new DB; create the bare table here so we have
    // somewhere to record subsequent applies. The backfill rows live in the
    // migration file itself.
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT NOW(),
      applied_by text NOT NULL DEFAULT current_user,
      checksum text
    )`);

    const allFiles = listMigrationFiles(dir, fs);
    const appliedRows = (await sql.unsafe(`SELECT filename FROM ${JOURNAL_TABLE}`)) as Array<{ filename: string }>;
    const appliedSet = new Set(appliedRows.map((r) => r.filename));

    const pending = allFiles.filter((f) => !appliedSet.has(f));
    const skipped = allFiles.filter((f) => appliedSet.has(f));

    log(`[apply-pending] ${allFiles.length} total · ${pending.length} pending · ${skipped.length} already applied`);

    const applied: string[] = [];
    for (const filename of pending) {
      const body = fs.readFileSync(join(dir, filename), "utf8");
      const checksum = computeChecksum(body);
      log(`[apply-pending] applying ${filename} (sha256:${checksum.slice(0, 12)}…)`);
      // Each migration applies in its own implicit transaction; postgres
      // driver wraps multi-statement bodies as a single round-trip. If a
      // statement inside fails, the whole file is rolled back by Postgres.
      await sql.unsafe("BEGIN");
      try {
        await sql.unsafe(body);
        await sql.unsafe(
          `INSERT INTO ${JOURNAL_TABLE} (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING`,
          [filename, checksum],
        );
        await sql.unsafe("COMMIT");
        applied.push(filename);
      } catch (err) {
        await sql.unsafe("ROLLBACK").catch(() => undefined);
        throw new Error(`[apply-pending] failed to apply ${filename}: ${(err as Error).message}`);
      }
    }

    return { applied, skipped, total_files: allFiles.length };
  } finally {
    await sql.end().catch(() => undefined);
  }
}

// CLI entry — only fires when this file is executed directly.
const isDirect = (() => {
  // tsx + node both expose process.argv[1]; compare absolute paths.
  try {
    return resolve(process.argv[1] ?? "") === resolve(__filename);
  } catch {
    return false;
  }
})();

if (isDirect) {
  const isProd = process.argv.includes("--prod");
  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL ?? "";
  applyPending({ databaseUrl: url, isProd })
    .then((res) => {
      console.log(`[apply-pending] DONE — applied ${res.applied.length}/${res.total_files}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
}
