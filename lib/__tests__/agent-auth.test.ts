import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { agentBearerValid, assertAgentAuth } from "@/lib/agent-auth";

const TOKEN = "a".repeat(40); // ≥ MIN_LEN (32)

function req(auth?: string): Request {
  return new Request("https://x/api/agent/one-shot-citation", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("agent-auth", () => {
  const saved = process.env.AGENT_SERVICE_TOKEN;
  beforeEach(() => { process.env.AGENT_SERVICE_TOKEN = TOKEN; });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_SERVICE_TOKEN;
    else process.env.AGENT_SERVICE_TOKEN = saved;
  });

  it("accepts the exact Bearer token", () => {
    expect(agentBearerValid(req(`Bearer ${TOKEN}`))).toBe(true);
    expect(assertAgentAuth(req(`Bearer ${TOKEN}`))).toBeNull();
  });

  it("rejects a wrong token with 401", async () => {
    expect(agentBearerValid(req(`Bearer ${"b".repeat(40)}`))).toBe(false);
    const res = assertAgentAuth(req(`Bearer ${"b".repeat(40)}`))!;
    expect(res.status).toBe(401);
  });

  it("rejects a missing header with 401", () => {
    expect(assertAgentAuth(req())!.status).toBe(401);
  });

  it("rejects a non-Bearer scheme with 401", () => {
    expect(assertAgentAuth(req(`Basic ${TOKEN}`))!.status).toBe(401);
  });

  it("rejects a token of the wrong length (no length-leak crash) with 401", () => {
    expect(agentBearerValid(req("Bearer short"))).toBe(false);
    expect(assertAgentAuth(req("Bearer short"))!.status).toBe(401);
  });

  it("returns 503 when AGENT_SERVICE_TOKEN is unset", () => {
    delete process.env.AGENT_SERVICE_TOKEN;
    expect(assertAgentAuth(req(`Bearer ${TOKEN}`))!.status).toBe(503);
    expect(agentBearerValid(req(`Bearer ${TOKEN}`))).toBe(false);
  });

  it("returns 503 when AGENT_SERVICE_TOKEN is too short", () => {
    process.env.AGENT_SERVICE_TOKEN = "tooshort";
    expect(assertAgentAuth(req("Bearer tooshort"))!.status).toBe(503);
  });
});
