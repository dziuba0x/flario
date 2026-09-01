// Evidence bundles. The security claim is narrow and worth testing precisely:
// the bundle hash is tamper-EVIDENCE only, and per-fact Merkle verification is
// what actually holds. These tests cover the offline half — canonicalization,
// hashing, and the refusals that happen before any network call.
import { describe, it, expect } from "vitest";
import {
  bundleHash,
  evidenceBundle,
  evidenceVerify,
  EVIDENCE_SCHEMA,
} from "../src/tools/evidence.js";

const baseBundle = {
  schema: EVIDENCE_SCHEMA,
  claim: "test",
  network: "mainnet" as const,
  chain_id: 14,
  relay_address: "0xCcF3ff9E6F8FD9C7BEC5b1e0D3d0C6D3a1234567" as `0x${string}`,
  created_at: 1788000000,
  facts: [],
  verify_with: "…",
};

describe("bundleHash", () => {
  it("is stable across key order", () => {
    const a = bundleHash({ ...baseBundle } as never);
    const reordered = {
      verify_with: "…",
      facts: [],
      created_at: 1788000000,
      relay_address: baseBundle.relay_address,
      chain_id: 14,
      network: "mainnet" as const,
      claim: "test",
      schema: EVIDENCE_SCHEMA,
    };
    expect(bundleHash(reordered as never)).toBe(a);
  });

  it("changes when any field changes", () => {
    const a = bundleHash({ ...baseBundle } as never);
    const b = bundleHash({ ...baseBundle, claim: "test " } as never);
    expect(b).not.toBe(a);
  });

  it("distinguishes nested changes, not just top-level ones", () => {
    const withFact = {
      ...baseBundle,
      facts: [{ kind: "ftso_anchor", body: { value: 100 } }],
    };
    const changed = {
      ...baseBundle,
      facts: [{ kind: "ftso_anchor", body: { value: 101 } }],
    };
    expect(bundleHash(changed as never)).not.toBe(bundleHash(withFact as never));
  });
});

describe("evidence_verify rejects malformed input before touching the chain", () => {
  it("refuses an object that is not an evidence bundle", async () => {
    const r = await evidenceVerify({ bundle: { hello: "world" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(EVIDENCE_SCHEMA);
  });

  it("refuses a bundle carrying the wrong schema version", async () => {
    const r = await evidenceVerify({
      bundle: { ...baseBundle, schema: "flario-evidence/99" },
    });
    expect(r.isError).toBe(true);
  });

  it("refuses a bundle with no facts", async () => {
    const r = await evidenceVerify({ bundle: { ...baseBundle } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("no facts");
  });
});

describe("evidence_bundle input guards", () => {
  it("refuses to build an empty bundle", async () => {
    const r = await evidenceBundle({ network: "mainnet" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Nothing to bundle");
  });
});
