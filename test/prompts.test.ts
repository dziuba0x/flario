// The prompts are the onboarding surface: they are what a developer sees before
// they know which tool to call. These tests keep them honest — registered,
// discoverable, and actually instructing the model to run live calls rather
// than lecture from memory.
import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";

type PromptEntry = {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; required?: boolean }>;
};

function registeredPrompts(): Record<string, unknown> {
  const server = buildServer();
  // McpServer keeps its registry on the instance; reach it without a transport.
  return (server as unknown as { _registeredPrompts: Record<string, unknown> })
    ._registeredPrompts;
}

const EXPECTED = [
  "flare_tour",
  "verify_a_price",
  "prove_a_web_fact",
  "fassets_health_check",
  "why_flare_for_agents",
  "prove_what_you_acted_on",
  "watch_flare_2_rollout",
];

describe("MCP prompts", () => {
  it("registers every onboarding prompt", () => {
    const prompts = registeredPrompts();
    expect(Object.keys(prompts).sort()).toEqual([...EXPECTED].sort());
  });

  it("gives every prompt a title and a description", () => {
    const prompts = registeredPrompts() as Record<string, PromptEntry>;
    for (const [name, p] of Object.entries(prompts)) {
      expect(p.title, `${name} needs a title`).toBeTruthy();
      expect(p.description?.length ?? 0, `${name} needs a real description`).toBeGreaterThan(40);
    }
  });

  it("flare_tour tells the model to run the calls for real", async () => {
    const prompts = registeredPrompts() as Record<
      string,
      { callback: (args: unknown, extra: unknown) => Promise<{ messages: Array<{ content: { text: string } }> }> }
    >;
    const res = await prompts.flare_tour.callback({ network: undefined }, {});
    const text = res.messages[0].content.text;
    expect(text).toContain("get_ftso_anchor_feed");
    expect(text.toLowerCase()).toContain("do not describe them hypothetically");
  });

  it("verify_a_price names the on-chain root it verifies against", async () => {
    const prompts = registeredPrompts() as Record<
      string,
      { callback: (args: unknown, extra: unknown) => Promise<{ messages: Array<{ content: { text: string } }> }> }
    >;
    const res = await prompts.verify_a_price.callback({ feed: "BTC/USD" }, {});
    const text = res.messages[0].content.text;
    expect(text).toContain("BTC/USD");
    expect(text).toContain("get_ftso_anchor_feed");
  });

  it("prove_a_web_fact warns about the unbound-proof trap", async () => {
    const prompts = registeredPrompts() as Record<
      string,
      { callback: (args: unknown, extra: unknown) => Promise<{ messages: Array<{ content: { text: string } }> }> }
    >;
    const res = await prompts.prove_a_web_fact.callback({}, {});
    const text = res.messages[0].content.text;
    expect(text).toContain("expect_source");
    expect(text).toContain("source_bound: false");
  });

  it("prompts default to a network instead of demanding one", async () => {
    const prompts = registeredPrompts() as Record<
      string,
      { callback: (args: unknown, extra: unknown) => Promise<{ messages: Array<{ content: { text: string } }> }> }
    >;
    for (const name of ["flare_tour", "verify_a_price", "fassets_health_check"]) {
      const res = await prompts[name].callback({}, {});
      expect(res.messages[0].content.text, `${name} should fall back to mainnet`).toContain("mainnet");
    }
  });
});
