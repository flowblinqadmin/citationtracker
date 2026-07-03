/**
 * CLI credentials tests — R-1 through R-9.
 *
 * Tests geo/cli/credentials.ts in isolation (no network, no real FS).
 *
 * Discovery order tested:
 *   1. CLI flags (--client-id, --client-secret)
 *   2. Environment variables (FLOWBLINQ_CLIENT_ID, FLOWBLINQ_CLIENT_SECRET)
 *   3. Config files: ~/.flowblinq/config.json → ./.flowblinq.json (CWD)
 *
 * Mocks:
 *   - node:fs (readFileSync for config file reading)
 *   - node:os (homedir → '/mock/home')
 *   - process.exit (spy — verified it's called with code 1 on failure)
 *   - process.env (set/restore per test)
 *   - console.error (spy — verify error messages)
 *   - console.warn (spy — verify malformed JSON warning)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  default: { readFileSync: vi.fn(), existsSync: vi.fn() },
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: { homedir: vi.fn().mockReturnValue("/mock/home") },
  homedir: vi.fn().mockReturnValue("/mock/home"),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal ParsedArgs-shaped object as returned by node:util parseArgs. */
function makeArgs(flags: Record<string, string | boolean | undefined> = {}) {
  return {
    values: {
      "client-id": undefined as string | undefined,
      "client-secret": undefined as string | undefined,
      "base-url": undefined as string | undefined,
      json: false as boolean,
      help: false as boolean,
      ...flags,
    },
    positionals: [] as string[],
  };
}

/** Simulate no config files being present (readFileSync throws ENOENT for all paths). */
function mockNoConfigFiles() {
  vi.mocked(readFileSync).mockImplementation(() => {
    const err = new Error("ENOENT: no such file or directory");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  });
}

/** Simulate home config file returning valid JSON. */
function mockHomeConfig(content: object) {
  vi.mocked(readFileSync).mockImplementation((filePath) => {
    if (String(filePath).includes("/mock/home")) {
      return JSON.stringify(content);
    }
    const err = new Error("ENOENT");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  });
}

/** Simulate CWD config file returning valid JSON (home file missing). */
function mockCwdConfig(content: object) {
  vi.mocked(readFileSync).mockImplementation((filePath) => {
    const p = String(filePath);
    if (p.includes(".flowblinq.json") && !p.includes("/mock/home")) {
      return JSON.stringify(content);
    }
    const err = new Error("ENOENT");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let savedEnv: Record<string, string | undefined>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Save and clear credential-related env vars
  savedEnv = {
    FLOWBLINQ_CLIENT_ID: process.env.FLOWBLINQ_CLIENT_ID,
    FLOWBLINQ_CLIENT_SECRET: process.env.FLOWBLINQ_CLIENT_SECRET,
    FLOWBLINQ_BASE_URL: process.env.FLOWBLINQ_BASE_URL,
  };
  delete process.env.FLOWBLINQ_CLIENT_ID;
  delete process.env.FLOWBLINQ_CLIENT_SECRET;
  delete process.env.FLOWBLINQ_BASE_URL;

  // Mock process.exit to not actually exit (return undefined so execution continues)
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    // no-op — let execution continue so tests can verify what was called
  }) as never);

  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  // Default: no config files
  mockNoConfigFiles();
  vi.mocked(homedir).mockReturnValue("/mock/home");
});

afterEach(() => {
  // Restore env vars
  if (savedEnv.FLOWBLINQ_CLIENT_ID !== undefined) {
    process.env.FLOWBLINQ_CLIENT_ID = savedEnv.FLOWBLINQ_CLIENT_ID;
  } else {
    delete process.env.FLOWBLINQ_CLIENT_ID;
  }
  if (savedEnv.FLOWBLINQ_CLIENT_SECRET !== undefined) {
    process.env.FLOWBLINQ_CLIENT_SECRET = savedEnv.FLOWBLINQ_CLIENT_SECRET;
  } else {
    delete process.env.FLOWBLINQ_CLIENT_SECRET;
  }
  if (savedEnv.FLOWBLINQ_BASE_URL !== undefined) {
    process.env.FLOWBLINQ_BASE_URL = savedEnv.FLOWBLINQ_BASE_URL;
  } else {
    delete process.env.FLOWBLINQ_BASE_URL;
  }

  vi.restoreAllMocks();
});

// ─── R-1 through R-9 ──────────────────────────────────────────────────────────

describe("CLI credentials: flag source", () => {
  it("R-1: --client-id and --client-secret flags → returns config with flag values", async () => {
    const { loadCredentials } = await import("@/cli/credentials");
    const args = makeArgs({ "client-id": "flag-id", "client-secret": "flag-secret" });

    const config = loadCredentials(args);

    expect(config.clientId).toBe("flag-id");
    expect(config.clientSecret).toBe("flag-secret");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("R-7: --base-url flag → returned config has baseUrl set", async () => {
    const { loadCredentials } = await import("@/cli/credentials");
    const args = makeArgs({
      "client-id": "flag-id",
      "client-secret": "flag-secret",
      "base-url": "https://staging.flowblinq.com",
    });

    const config = loadCredentials(args);

    expect(config.baseUrl).toBe("https://staging.flowblinq.com");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("CLI credentials: env var source", () => {
  it("R-2: no flags, env vars set → returns config from env vars", async () => {
    const { loadCredentials } = await import("@/cli/credentials");
    process.env.FLOWBLINQ_CLIENT_ID = "env-id";
    process.env.FLOWBLINQ_CLIENT_SECRET = "env-secret";

    const config = loadCredentials(makeArgs());

    expect(config.clientId).toBe("env-id");
    expect(config.clientSecret).toBe("env-secret");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("R-5: flags present override env vars → flag values win", async () => {
    const { loadCredentials } = await import("@/cli/credentials");
    process.env.FLOWBLINQ_CLIENT_ID = "env-id";
    process.env.FLOWBLINQ_CLIENT_SECRET = "env-secret";

    const args = makeArgs({ "client-id": "flag-id", "client-secret": "flag-secret" });
    const config = loadCredentials(args);

    expect(config.clientId).toBe("flag-id");
    expect(config.clientSecret).toBe("flag-secret");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("CLI credentials: config file source", () => {
  it("R-3: no flags/env, ~/.flowblinq/config.json exists → returns config from home file", async () => {
    const { loadCredentials } = await import("@/cli/credentials");
    mockHomeConfig({ client_id: "home-id", client_secret: "home-secret" });

    const config = loadCredentials(makeArgs());

    expect(config.clientId).toBe("home-id");
    expect(config.clientSecret).toBe("home-secret");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it(
    "R-4: no flags/env, home file missing, .flowblinq.json in CWD exists → returns CWD config",
    async () => {
      const { loadCredentials } = await import("@/cli/credentials");
      mockCwdConfig({ client_id: "cwd-id", client_secret: "cwd-secret" });

      const config = loadCredentials(makeArgs());

      expect(config.clientId).toBe("cwd-id");
      expect(config.clientSecret).toBe("cwd-secret");
      expect(exitSpy).not.toHaveBeenCalled();
    }
  );

  it("R-8: config file has base_url field, no flag → returned config has baseUrl from file", async () => {
    const { loadCredentials } = await import("@/cli/credentials");
    mockHomeConfig({
      client_id: "home-id",
      client_secret: "home-secret",
      base_url: "https://staging.flowblinq.com",
    });

    const config = loadCredentials(makeArgs());

    expect(config.baseUrl).toBe("https://staging.flowblinq.com");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("CLI credentials: failure cases", () => {
  it("R-6: no credentials in any source → process.exit(1) called with setup message", async () => {
    const { loadCredentials } = await import("@/cli/credentials");
    mockNoConfigFiles();

    loadCredentials(makeArgs());

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Should print a multi-line setup message mentioning all 3 credential sources
    const errorOutput = consoleErrorSpy.mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(errorOutput).toContain("No credentials found");
    expect(errorOutput).toMatch(/flag|--client-id/i);
    expect(errorOutput).toMatch(/env|FLOWBLINQ_CLIENT_ID/i);
    expect(errorOutput).toMatch(/config|config\.json/i);
  });

  it(
    "R-9: config file exists but malformed JSON → prints warning, falls through to exit(1)",
    async () => {
      const { loadCredentials } = await import("@/cli/credentials");

      // Home config file exists but is malformed JSON
      vi.mocked(readFileSync).mockImplementation((filePath) => {
        if (String(filePath).includes("/mock/home")) {
          return "{ not valid json !!!";
        }
        const err = new Error("ENOENT");
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      });

      loadCredentials(makeArgs());

      // Warning about malformed JSON
      expect(consoleWarnSpy).toHaveBeenCalled();
      const warnOutput = consoleWarnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnOutput).toMatch(/malformed|invalid|parse|JSON/i);

      // Eventually exits with 1 (no valid credentials found)
      expect(exitSpy).toHaveBeenCalledWith(1);
    }
  );
});
