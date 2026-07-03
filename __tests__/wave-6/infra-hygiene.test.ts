/**
 * ES-wave-6 §D1/§D2/§D5 — infra hygiene artifact contracts.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.resolve(ROOT, rel), "utf8");
}
function exists(rel: string): boolean {
  return fs.existsSync(path.resolve(ROOT, rel));
}

describe("AC-D1-1 — clean-vercel-env.sh: operator-gated, no auto-run", () => {
  it("script exists, is executable, sets shell-strict, gates with read confirm", () => {
    const rel = "scripts/ops/clean-vercel-env.sh";
    expect(exists(rel)).toBe(true);
    const stat = fs.statSync(path.resolve(ROOT, rel));
    // Owner-execute bit set.
    expect((stat.mode & 0o100) !== 0).toBe(true);
    const body = read(rel);
    expect(body).toMatch(/set -euo pipefail/);
    expect(body).toMatch(/REQUIRES OPERATOR APPROVAL/);
    expect(body).toMatch(/read -r -p/);
    // The corruption fix must use printf for the actual `vercel env add`
    // invocation (AC-D1-3 invariant). The repo-wide grep guard in the next
    // describe enforces the no-echo rule across non-comment code.
    expect(body).toMatch(/printf '%s'.+vercel env add/);
  });
});

describe("AC-D1-3 — repo-wide grep guard: no `echo \"...\" | vercel env add`", () => {
  it("scripts/**/*.{sh,ts} contains zero offending patterns", () => {
    const offenders: string[] = [];
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(sh|ts)$/.test(entry.name)) {
          const src = fs.readFileSync(full, "utf8");
          // Strip line-comments (lines starting with # or //) before scanning
          // so docs-only references (like in this very test, hypothetically)
          // don't trip the guard.
          const code = src
            .split("\n")
            .filter((l) => !/^\s*#/.test(l) && !/^\s*\/\//.test(l))
            .join("\n");
          if (/echo\s+"[^"]*"\s*\|\s*vercel\s+env\s+add\b/.test(code)) {
            offenders.push(full);
          }
        }
      }
    }
    walk(path.resolve(ROOT, "scripts"));
    expect(offenders).toEqual([]);
  });
});

describe("AC-D2-1/2/3 — refresh-docker-env + patch-env-docker", () => {
  it("AC-D2-1: package.json wires `env:refresh-docker`", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["env:refresh-docker"]).toMatch(/scripts\/ops\/refresh-docker-env\.sh/);
  });

  it("AC-D2-2: refresh-docker-env.sh pulls + patches + reminds about down/up", () => {
    const body = read("scripts/ops/refresh-docker-env.sh");
    expect(body).toMatch(/vercel env pull/);
    expect(body).toMatch(/python3 .*patch-env-docker\.py/);
    expect(body).toMatch(/docker compose down && docker compose up/);
  });

  it("AC-D2-3: patch-env-docker.py preserves target-only keys + never prints values", () => {
    const body = read("scripts/ops/patch-env-docker.py");
    expect(body).toMatch(/preserved target-only keys/);
    expect(body).toMatch(/Never print values/i);
    // Defensive: the script must not print arbitrary line contents from
    // the env files. We check it never references the *value* group of the
    // KEY_RE regex via print() — only the *key* (group 1) is printed.
    expect(body).not.toMatch(/print\(.*m\.group\(2\)/);
  });
});

describe("AC-D5-1 — setup-named-tunnel.sh", () => {
  it("idempotent, prompts for hostname, writes per-tunnel config", () => {
    const body = read("scripts/ops/setup-named-tunnel.sh");
    expect(body).toMatch(/cloudflared tunnel create/);
    expect(body).toMatch(/cloudflared tunnel route dns/);
    expect(body).toMatch(/already exists/);
    expect(body).toMatch(/QSTASH_CALLBACK_BASE/);
  });
});

describe("D6/D7/E4/E5 — runbook coverage", () => {
  it("docker-uat-runbook.md covers the four documentation gaps", () => {
    const body = read("docs/specs/ops/docker-uat-runbook.md");
    // D6: env_file path resolution
    expect(body).toMatch(/env_file/);
    expect(body).toMatch(/project dir/);
    // D7: NEXT_PUBLIC_* LAN-IP gotcha
    expect(body).toMatch(/NEXT_PUBLIC_/);
    expect(body).toMatch(/LAN/);
    // E4: docker compose config redaction
    expect(body).toMatch(/docker compose.*config/);
    // E5: env-debug awk pattern (no od -c value leak)
    expect(body).toMatch(/awk -F=/);
  });

  it("runbook scripts table references the four scripts/ops/ artifacts", () => {
    const body = read("docs/specs/ops/docker-uat-runbook.md");
    expect(body).toMatch(/scripts\/ops\/clean-vercel-env\.sh/);
    expect(body).toMatch(/scripts\/ops\/refresh-docker-env\.sh/);
    expect(body).toMatch(/scripts\/ops\/patch-env-docker\.py/);
    expect(body).toMatch(/scripts\/ops\/setup-named-tunnel\.sh/);
  });
});
