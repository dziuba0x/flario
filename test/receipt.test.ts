// Tests for the ZK-ready receipt (organ 3). Crypto-critical: commitment
// determinism, field reduction, no plaintext payer, tamper-evidence.
import { describe, it, expect, afterEach } from "vitest";
import {
  buildReceipt,
  computePayerCommitment,
  canonicalize,
  verifyReceiptHash,
  BN254_FIELD_MODULUS,
  RECEIPT_SCHEMA_VERSION,
  COMMITMENT_SCHEME,
  type BuildReceiptParams,
} from "../src/x402/receipt.js";

const PAYER = "0x4E76db22BaD9a40AF6068b187cFD77509933fcb8";
const PAYEE = "0x1067faee3511aB7454EC79A1F2868E3Dd26574d1";
const TOKEN = "0x3c71Fb2b7da7CE85dd1aF0A54174668e41BcD176";
const TX = "0xf23038f1d7f32e429e3116ae93e248f316dcfe9f15e91f9b88e1c17bc773cab2";

const baseParams: BuildReceiptParams = {
  payer: PAYER,
  payee: PAYEE,
  amount: "1000",
  asset: TOKEN,
  network: "coston2",
  toolId: "fassets_liquidation_scanner",
  settlementTxHash: TX,
  timestamp: 1784300000,
};

describe("payer_commitment (Poseidon/BN254)", () => {
  it("is deterministic and a 32-byte hex, not the raw address", () => {
    const a = computePayerCommitment(PAYER, "0x01");
    const b = computePayerCommitment(PAYER, "0x01");
    expect(a.commitment).toBe(b.commitment);
    expect(a.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.commitment.toLowerCase()).not.toContain(PAYER.slice(2).toLowerCase());
  });

  it("blinds: different salts → different commitments; marks blinded", () => {
    const s1 = computePayerCommitment(PAYER, "0xdead");
    const s2 = computePayerCommitment(PAYER, "0xbeef");
    expect(s1.commitment).not.toBe(s2.commitment);
    expect(s1.blinded).toBe(true);
  });

  it("is unblinded and honestly flagged when no salt is given", () => {
    const c = computePayerCommitment(PAYER);
    expect(c.blinded).toBe(false);
    // unblinded == salt 0, publicly recomputable
    expect(c.commitment).toBe(computePayerCommitment(PAYER, "0x0").commitment);
  });

  it("reduces salts >= field modulus (well-defined, no silent divergence)", () => {
    const salt = 42n;
    const wrapped = BN254_FIELD_MODULUS + salt;
    const a = computePayerCommitment(PAYER, "0x" + salt.toString(16));
    const b = computePayerCommitment(PAYER, "0x" + wrapped.toString(16));
    expect(a.commitment).toBe(b.commitment);
  });

  it("commitment lands inside the BN254 field", () => {
    const { commitment } = computePayerCommitment(PAYER, "0x1234");
    expect(BigInt(commitment) < BN254_FIELD_MODULUS).toBe(true);
  });
});

describe("buildReceipt schema", () => {
  const r = buildReceipt(baseParams);

  it("carries the full ZK-ready schema and never a plaintext payer", () => {
    expect(r.schema_version).toBe(RECEIPT_SCHEMA_VERSION);
    expect(r.commitment_scheme).toBe(COMMITMENT_SCHEME);
    expect(r).not.toHaveProperty("payer");
    expect(r).not.toHaveProperty("from");
    expect(r.payer_commitment).toMatch(/^0x[0-9a-f]{64}$/);
    for (const f of [
      "schema_version", "commitment_scheme", "hash_scheme", "payer_commitment",
      "blinded", "payee_address", "amount", "asset", "network", "timestamp",
      "tool_id", "settlement_tx_hash", "fdc_attestation_ref", "receipt_hash",
    ]) {
      expect(r).toHaveProperty(f);
    }
  });

  it("has a null FDC ref until the FDC settlement path runs", () => {
    expect(r.fdc_attestation_ref).toBeNull();
  });

  it("carries the payee, amount, asset and settlement tx", () => {
    expect(r.payee_address.toLowerCase()).toBe(PAYEE.toLowerCase());
    expect(r.amount).toBe("1000");
    expect(r.asset.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(r.settlement_tx_hash).toBe(TX);
    expect(r.tool_id).toBe("fassets_liquidation_scanner");
  });
});

describe("receipt_hash (keccak256 anchor / tamper-evidence)", () => {
  it("is deterministic and self-verifying", () => {
    const a = buildReceipt(baseParams);
    const b = buildReceipt(baseParams);
    expect(a.receipt_hash).toBe(b.receipt_hash);
    expect(verifyReceiptHash(a)).toBe(true);
  });

  it("detects tampering with any field", () => {
    const r = buildReceipt(baseParams);
    expect(verifyReceiptHash({ ...r, amount: "999999" })).toBe(false);
    expect(verifyReceiptHash({ ...r, payee_address: PAYER })).toBe(false);
    expect(
      verifyReceiptHash({ ...r, receipt_hash: ("0x" + "00".repeat(32)) as `0x${string}` }),
    ).toBe(false);
  });

  it("changes when the FDC attestation ref is added", () => {
    const without = buildReceipt(baseParams);
    const withRef = buildReceipt({
      ...baseParams,
      fdcAttestationRef: {
        network: "coston2",
        voting_round_id: 1397964,
        request_bytes: "0xabcd",
        merkle_root: "0x5fbdc8463844afea63000000000000000000000000000000000000000000000000",
      },
    });
    expect(withRef.receipt_hash).not.toBe(without.receipt_hash);
    expect(verifyReceiptHash(withRef)).toBe(true);
  });

  it("canonicalize excludes receipt_hash and is stable", () => {
    const r = buildReceipt(baseParams);
    const { receipt_hash, ...rest } = r;
    const s1 = canonicalize(rest);
    const s2 = canonicalize(rest);
    expect(s1).toBe(s2);
    expect(s1).not.toContain("receipt_hash");
    expect(receipt_hash).toBeDefined();
  });
});

describe("DELICTI mandate_ref (flario-receipt/2)", () => {
  it("binds a mandate into the receipt and changes the hash", async () => {
    const { buildReceipt, canonicalize } = await import("../src/x402/receipt.js");
    const { mandateRefFor } = await import("../src/x402/mandate.js");
    const base = {
      payer: "0x34D940fb868dbac296311857903C6dA0cbb7C9F1" as const,
      payee: "0x2222222222222222222222222222222222222222" as const,
      amount: "1000000",
      asset: "0x3333333333333333333333333333333333333333" as const,
      network: "coston2" as const,
      toolId: "fassets_liquidation_scanner",
      settlementTxHash: ("0x" + "ab".repeat(32)) as `0x${string}`,
      timestamp: 1788834046,
    };
    const ref = mandateRefFor("coston2", {
      from: base.payer, to: base.payee, value: "1", validAfter: "0", validBefore: "1", nonce: "0x00", v: 27, r: "0x00", s: "0x00",
      mandate_id: "4", mandate_registry: "0x52a61f0b9312042c514b0ac5c053747b0edf0c17",
    });
    expect(ref).toEqual({ chain_id: 114, registry: "0x52A61f0B9312042c514B0aC5C053747B0EdF0C17", mandate_id: "4" });
    const without = buildReceipt(base);
    const withRef = buildReceipt({ ...base, mandateRef: ref });
    expect(without.mandate_ref).toBeNull();
    expect(withRef.mandate_ref?.mandate_id).toBe("4");
    expect(withRef.receipt_hash).not.toBe(without.receipt_hash);
    expect(canonicalize(withRef)).toContain('"mandate_ref":{"chain_id":114');
  });
  it("mandateRefFor is null without an id or registry", async () => {
    const { mandateRefFor } = await import("../src/x402/mandate.js");
    const p = { from: "0x0000000000000000000000000000000000000001" as const, to: "0x0000000000000000000000000000000000000002" as const, value: "1", validAfter: "0", validBefore: "1", nonce: "0x00" as const, v: 27, r: "0x00" as const, s: "0x00" as const };
    expect(mandateRefFor("coston2", p)).toBeNull();
    expect(mandateRefFor("coston2", { ...p, mandate_id: "1" })).toBeNull();
  });
});

describe("receiptFor — one constructor for both effector paths", () => {
  const settlement = {
    tx_hash: "0x" + "ab".repeat(32),
    block_number: "1",
    payer: "0x00000000000000000000000000000000000000A2",
    payee: "0x00000000000000000000000000000000000000A1",
    amount_units: "1000000",
    token: "0x9Eea43feA502609d0D88DAfd1d64B4e929BF18C2",
    network: "coston2",
  } as const;
  const config = {
    enabled: true,
    network: "coston2",
    tokenAddress: settlement.token,
    payTo: settlement.payee,
    eip712Version: "1",
    tokenDecimals: 6,
    defaultPrice: "1",
    toolPrices: {},
  } as const;
  const payload = {
    from: settlement.payer,
    to: settlement.payee,
    value: "1000000",
    validAfter: "0",
    validBefore: "9999999999",
    nonce: ("0x" + "11".repeat(32)) as `0x${string}`,
    v: 27,
    r: ("0x" + "22".repeat(32)) as `0x${string}`,
    s: ("0x" + "33".repeat(32)) as `0x${string}`,
  };

  afterEach(() => {
    delete process.env.DELICTI_REGISTRY;
  });

  it("binds mandate_ref when the payer names a mandate and a registry is configured", async () => {
    const { receiptFor } = await import("../src/x402/emit.js");
    process.env.DELICTI_REGISTRY = "0x73109d769878cA2Cf0Ba180CF4f1a24b404F3f48";
    const r = receiptFor(config as never, { ...payload, mandate_id: "7" } as never, settlement as never, "fassets_liquidation_scanner");
    expect(r.mandate_ref).toEqual({
      chain_id: 114,
      registry: "0x73109d769878cA2Cf0Ba180CF4f1a24b404F3f48",
      mandate_id: "7",
    });
    expect(r.settlement_tx_hash).toBe(settlement.tx_hash);
  });

  it("leaves mandate_ref null when the payer names no mandate", async () => {
    const { receiptFor } = await import("../src/x402/emit.js");
    process.env.DELICTI_REGISTRY = "0x73109d769878cA2Cf0Ba180CF4f1a24b404F3f48";
    const r = receiptFor(config as never, payload as never, settlement as never, "fassets_liquidation_scanner");
    expect(r.mandate_ref).toBeNull();
  });
});

describe("finaliseSettlement — the receipt must survive the tally write", () => {
  afterEach(() => {
    delete process.env.DELICTI_REGISTRY;
    delete process.env.DELICTI_SPEND_METER;
  });

  it("still returns the receipt when no meter is configured", async () => {
    const { finaliseSettlement } = await import("../src/x402/emit.js");
    process.env.DELICTI_REGISTRY = "0x73109d769878cA2Cf0Ba180CF4f1a24b404F3f48";
    const settlement = {
      tx_hash: "0x" + "cd".repeat(32),
      block_number: "2",
      payer: "0x00000000000000000000000000000000000000A2",
      payee: "0x00000000000000000000000000000000000000A1",
      amount_units: "1000000",
      token: "0x9Eea43feA502609d0D88DAfd1d64B4e929BF18C2",
      network: "coston2",
    };
    const config = {
      enabled: true, network: "coston2", tokenAddress: settlement.token, payTo: settlement.payee,
      eip712Version: "1", tokenDecimals: 6, defaultPrice: "1", toolPrices: {},
    };
    const payload = {
      from: settlement.payer, to: settlement.payee, value: "1000000", validAfter: "0",
      validBefore: "9999999999", nonce: ("0x" + "11".repeat(32)) as `0x${string}`, v: 27,
      r: ("0x" + "22".repeat(32)) as `0x${string}`, s: ("0x" + "33".repeat(32)) as `0x${string}`,
      mandate_id: "9",
    };
    const r = finaliseSettlement(config as never, payload as never, settlement as never, "fassets_liquidation_scanner");
    expect(r.mandate_ref?.mandate_id).toBe("9");
    expect(r.settlement_tx_hash).toBe(settlement.tx_hash);
  });
});
