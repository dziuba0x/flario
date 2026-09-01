// The selector map is the load-bearing part of fcc_deployment_status: it is
// what lets the tool report capabilities without an official ABI. These tests
// keep it honest and offline.
import { describe, it, expect } from "vitest";
import {
  FCC_SELECTORS,
  CAPABILITY_LABELS,
  type FccCapability,
} from "../src/utils/fcc-selectors.js";
import { fccDeploymentStatus } from "../src/tools/fcc-deployment.js";

describe("FCC selector map", () => {
  it("covers every selector observed on the deployed diamond", () => {
    expect(Object.keys(FCC_SELECTORS).length).toBe(198);
  });

  it("uses well-formed 4-byte selectors as keys", () => {
    for (const sel of Object.keys(FCC_SELECTORS)) {
      expect(sel, `${sel} is not a 4-byte selector`).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });

  it("gives every entry a signature and a known capability", () => {
    for (const [sel, [sig, cap]] of Object.entries(FCC_SELECTORS)) {
      expect(sig, `${sel} has no signature`).toMatch(/^[a-zA-Z_][\w]*\(/);
      expect(CAPABILITY_LABELS[cap as FccCapability], `${sel} has capability "${cap}" with no label`).toBeTruthy();
    }
  });

  it("has no duplicate selectors", () => {
    const sigs = Object.values(FCC_SELECTORS).map(([s]) => s);
    expect(new Set(Object.keys(FCC_SELECTORS)).size).toBe(sigs.length);
  });

  it("records the capabilities that make this deployment interesting", () => {
    const caps = new Set(Object.values(FCC_SELECTORS).map(([, c]) => c));
    // These four are the substance of Flare 2.0's confidential compute.
    for (const expected of ["managed_wallets", "vrf", "machine_attestation", "fdc_v2"]) {
      expect(caps.has(expected as FccCapability), `missing capability ${expected}`).toBe(true);
    }
  });

  it("maps the FDC V2 getters, which is how the wiring read finds them", () => {
    const sigs = Object.values(FCC_SELECTORS).map(([s]) => s);
    expect(sigs).toContain("fdc2Hub()");
    expect(sigs).toContain("fdc2Verification()");
  });

  it("keeps VRF distinct from managed wallets", () => {
    const vrf = Object.values(FCC_SELECTORS).filter(([, c]) => c === "vrf");
    expect(vrf.length).toBeGreaterThan(0);
    for (const [sig] of vrf) expect(sig.toLowerCase()).toContain("vrf");
  });
});

describe("fcc_deployment_status input handling", () => {
  it("rejects an unknown network cleanly rather than throwing", async () => {
    const r = await fccDeploymentStatus({ network: "nonesuch" as never });
    expect(r.isError).toBe(true);
  });
});
