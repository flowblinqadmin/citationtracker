/**
 * ES-wave-3 §A2 — apply-pending runner UT.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from "vitest";
import { applyPending, isLocalUrl, computeChecksum, listMigrationFiles, type MinimalSqlClient } from "@/scripts/migrations/apply-pending";

function makeFs(files: Record<string, string>) {
  return {
    readdirSync: vi.fn((_dir: string) => Object.keys(files)),
    readFileSync: vi.fn((p: string) => {
      const name = p.split("/").pop() ?? "";
      const body = files[name];
      if (body === undefined) throw new Error(`ENOENT: ${p}`);
      return body;
    }),
    existsSync: vi.fn(() => true),
  } as unknown as Parameters<typeof applyPending>[0]["fs"];
}

function makeSql(initialApplied: string[]): { client: MinimalSqlClient; calls: Array<{ q: string; p?: unknown[] }>; applied: Set<string> } {
  const calls: Array<{ q: string; p?: unknown[] }> = [];
  const applied = new Set(initialApplied);
  const client: MinimalSqlClient = {
    unsafe: vi.fn(async (q: string, p?: unknown[]) => {
      calls.push({ q, p });
      const trimmed = q.trim().toUpperCase();
      if (trimmed.startsWith("SELECT FILENAME FROM __SCHEMA_MIGRATIONS")) {
        return Array.from(applied, (filename) => ({ filename }));
      }
      if (trimmed.startsWith("INSERT INTO __SCHEMA_MIGRATIONS")) {
        const filename = (p as string[])?.[0];
        if (filename) applied.add(filename);
        return [];
      }
      return [];
    }),
    end: vi.fn().mockResolvedValue(undefined),
  };
  return { client, calls, applied };
}

describe("apply-pending — local-host gate", () => {
  it("isLocalUrl true for 127.0.0.1 and localhost", () => {
    expect(isLocalUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toBe(true);
    expect(isLocalUrl("postgres://u:p@localhost:5432/db")).toBe(true);
  });

  it("isLocalUrl false for prod-style hosts", () => {
    expect(isLocalUrl("postgres://u:p@db.example.com:5432/db")).toBe(false);
    expect(isLocalUrl("postgres://u:p@10.0.0.5:5432/db")).toBe(false);
  });

  it("refuses non-local URL without --prod", async () => {
    await expect(
      applyPending({
        databaseUrl: "postgres://u:p@db.example.com/x",
        sqlFactory: () => makeSql([]).client,
        fs: makeFs({}),
      }),
    ).rejects.toThrow(/non-local host but --prod was NOT passed/);
  });

  it("permits non-local URL when --prod is set (isProd=true)", async () => {
    const sql = makeSql([]);
    const res = await applyPending({
      databaseUrl: "postgres://u:p@db.example.com/x",
      isProd: true,
      sqlFactory: () => sql.client,
      fs: makeFs({}),
      log: () => undefined,
    });
    expect(res.applied).toEqual([]);
  });
});

describe("apply-pending — pending computation + ordered apply + journal write", () => {
  it("applies only pending files in lex order; skips already-applied", async () => {
    const files = {
      "20260101-a.sql": "CREATE TABLE a();",
      "20260102-b.sql": "CREATE TABLE b();",
      "20260103-c.sql": "CREATE TABLE c();",
    };
    const sql = makeSql(["20260101-a.sql"]); // a already applied
    const res = await applyPending({
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      sqlFactory: () => sql.client,
      fs: makeFs(files),
      migrationsDir: "/fake",
      log: () => undefined,
    });
    expect(res.applied).toEqual(["20260102-b.sql", "20260103-c.sql"]);
    expect(res.skipped).toEqual(["20260101-a.sql"]);
    expect(res.total_files).toBe(3);

    // Each applied file must have triggered: BEGIN → body → INSERT INTO journal → COMMIT.
    const begins = sql.calls.filter((c) => c.q.trim().toUpperCase() === "BEGIN").length;
    const commits = sql.calls.filter((c) => c.q.trim().toUpperCase() === "COMMIT").length;
    const inserts = sql.calls.filter((c) => /INSERT INTO __SCHEMA_MIGRATIONS/i.test(c.q)).length;
    expect(begins).toBe(2);
    expect(commits).toBe(2);
    expect(inserts).toBe(2);
  });

  it("re-running after success is a no-op (idempotent)", async () => {
    const files = { "20260101-a.sql": "CREATE TABLE a();" };
    const sql = makeSql(["20260101-a.sql"]);
    const res = await applyPending({
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      sqlFactory: () => sql.client,
      fs: makeFs(files),
      log: () => undefined,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toEqual(["20260101-a.sql"]);
  });

  it("rolls back the failed file's transaction; re-throws with filename context", async () => {
    const files = {
      "20260101-a.sql": "GOOD;",
      "20260102-b.sql": "BAD;",
    };
    const sql = makeSql([]);
    const original = sql.client.unsafe;
    sql.client.unsafe = vi.fn(async (q: string, p?: unknown[]) => {
      if (q.trim() === "BAD;") throw new Error("syntax error");
      return original(q, p);
    });
    await expect(
      applyPending({
        databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        sqlFactory: () => sql.client,
        fs: makeFs(files),
        log: () => undefined,
      }),
    ).rejects.toThrow(/20260102-b\.sql/);
    const rollbacks = (sql.client.unsafe as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as string).trim().toUpperCase() === "ROLLBACK",
    );
    expect(rollbacks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("apply-pending — checksum + listing helpers", () => {
  it("computeChecksum is sha256 hex (64 chars)", () => {
    const c = computeChecksum("ALTER TABLE t SET NOT NULL;");
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    // Stable across calls
    expect(c).toBe(computeChecksum("ALTER TABLE t SET NOT NULL;"));
  });

  it("listMigrationFiles filters non-sql + sorts lex", () => {
    const fs = {
      readdirSync: vi.fn(() => ["b.sql", "a.sql", "README.md", "c.sql"]),
    } as unknown as { readdirSync: typeof import("fs").readdirSync };
    const files = listMigrationFiles("/fake", fs);
    expect(files).toEqual(["a.sql", "b.sql", "c.sql"]);
  });
});

describe("ES-wave-3 file artifacts", () => {
  it("AC-A1-3 SET NOT NULL migration file exists with the correct DDL", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const p = path.resolve(process.cwd(), "lib/db/migrations/20260426-pre-analyze-done-set-not-null.sql");
    expect(fs.existsSync(p)).toBe(true);
    const body = fs.readFileSync(p, "utf8");
    expect(body).toMatch(/ALTER TABLE geo_sites ALTER COLUMN pre_analyze_done SET NOT NULL/);
    expect(body).toMatch(/Idempotency/i);
    expect(body).toMatch(/Rollback/i);
  });

  it("AC-A2-1 journal migration file exists with CREATE TABLE + ON CONFLICT DO NOTHING backfill (HP-W3-MIN-1)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const p = path.resolve(process.cwd(), "lib/db/migrations/20260426-schema-migrations-journal.sql");
    expect(fs.existsSync(p)).toBe(true);
    const body = fs.readFileSync(p, "utf8");
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS __schema_migrations/);
    expect(body).toMatch(/filename\s+text\s+PRIMARY KEY/);
    expect(body).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(body).toMatch(/HP-W3-MIN-1|backfill-2026-04-26/);
  });

  it("AC-A2-3 npm script `db:migrate:apply-pending` is wired", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
    expect(pkg.scripts["db:migrate:apply-pending"]).toMatch(/tsx scripts\/migrations\/apply-pending\.ts/);
  });

  it("AC-A2-4 runbook doc exists and references the pending-migrations workflow", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const p = path.resolve(process.cwd(), "docs/specs/ops/migration-runner.md");
    expect(fs.existsSync(p)).toBe(true);
    const body = fs.readFileSync(p, "utf8");
    expect(body).toMatch(/db:migrate:apply-pending/);
    expect(body).toMatch(/__schema_migrations/);
    expect(body).toMatch(/--prod/);
  });
});
