// Tests for FDC-verified settlement. The security core is bindTransfer:
// an attestation that "tx X is confirmed" must not verify a payment unless
// tx X actually contains the claimed ERC-20 Transfer.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  bindTransfer,
  bindSettlementTxHash,
  fdcVerifySettlement,
  ERC20_TRANSFER_TOPIC,
  type TransferCriteria,
} from "../src/tools/fdc-settlement.js";
import * as fdcV2 from "../src/tools/fdc-v2.js";
import { encodeAttestationName, sourceIdName } from "../src/utils/fdc.js";
import { buildReceipt, attachFdcRef, verifyReceiptHash } from "../src/x402/receipt.js";

const ASSET = "0x3c71Fb2b7da7CE85dd1aF0A54174668e41BcD176";
const PAYEE = "0x1067faee3511aB7454EC79A1F2868E3Dd26574d1";
const PAYER = "0x4E76db22BaD9a40AF6068b187cFD77509933fcb8";
const OTHER = "0x000000000000000000000000000000000000dEaD";

function padAddr(a: string): string {
  return "0x" + a.slice(2).toLowerCase().padStart(64, "0");
}
function valueHex(v: bigint): string {
  return "0x" + v.toString(16).padStart(64, "0");
}
function transferEvent(
  emitter: string,
  from: string,
  to: string,
  value: bigint,
  logIndex = 0,
) {
  return {
    logIndex,
    emitterAddress: emitter,
    topics: [ERC20_TRANSFER_TOPIC, padAddr(from), padAddr(to)],
    data: valueHex(value),
    removed: false,
  };
}

const criteria: TransferCriteria = { asset: ASSET, payee: PAYEE, amount: "1000" };

describe("ERC20_TRANSFER_TOPIC", () => {
  it("is the canonical Transfer signature hash", () => {
    expect(ERC20_TRANSFER_TOPIC).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
  });
});

describe("bindTransfer (settlement ↔ attestation binding)", () => {
  it("matches a correct Transfer and reports the value/from", () => {
    const r = bindTransfer([transferEvent(ASSET, PAYER, PAYEE, 1000n)], criteria);
    expect(r.matched).toBe(true);
    expect(r.observed_value).toBe("1000");
    expect(r.from?.toLowerCase()).toBe(PAYER.toLowerCase());
  });

  it("accepts overpayment (value > amount)", () => {
    const r = bindTransfer([transferEvent(ASSET, PAYER, PAYEE, 5000n)], criteria);
    expect(r.matched).toBe(true);
  });

  it("rejects underpayment (value < amount)", () => {
    const r = bindTransfer([transferEvent(ASSET, PAYER, PAYEE, 999n)], criteria);
    expect(r.matched).toBe(false);
  });

  it("rejects a Transfer of a DIFFERENT token (wrong emitter)", () => {
    const r = bindTransfer([transferEvent(OTHER, PAYER, PAYEE, 1000n)], criteria);
    expect(r.matched).toBe(false);
    expect(r.reason).toContain("no ERC-20 Transfer of the given asset");
  });

  it("rejects a Transfer to the WRONG recipient", () => {
    const r = bindTransfer([transferEvent(ASSET, PAYER, OTHER, 1000n)], criteria);
    expect(r.matched).toBe(false);
    expect(r.reason).toContain("none matched");
  });

  it("enforces the payer when one is required", () => {
    const withPayer = { ...criteria, payer: PAYER as `0x${string}` };
    expect(bindTransfer([transferEvent(ASSET, PAYER, PAYEE, 1000n)], withPayer).matched).toBe(true);
    expect(bindTransfer([transferEvent(ASSET, OTHER, PAYEE, 1000n)], withPayer).matched).toBe(false);
  });

  it("ignores non-Transfer events and finds the real one among noise", () => {
    const noise = {
      logIndex: 0,
      emitterAddress: ASSET,
      topics: ["0x" + "11".repeat(32)], // some other event
      data: "0x",
      removed: false,
    };
    const r = bindTransfer(
      [noise, transferEvent(ASSET, PAYER, PAYEE, 1000n, 1)],
      criteria,
    );
    expect(r.matched).toBe(true);
    expect(r.matched_log_index).toBe(1);
  });

  it("returns not-matched (not a throw) on empty/garbage events", () => {
    expect(bindTransfer([], criteria).matched).toBe(false);
    expect(bindTransfer([{ topics: [], data: undefined }], criteria).matched).toBe(false);
  });
});

describe("attachFdcRef (receipt upgrade to FDC-verified)", () => {
  it("populates the ref, recomputes the hash, and stays self-verifying", () => {
    const receipt = buildReceipt({
      payer: PAYER,
      payee: PAYEE,
      amount: "1000",
      asset: ASSET,
      network: "coston2",
      toolId: "fassets_liquidation_scanner",
      settlementTxHash: "0xb380cb3560144d6443dec897a6169649ec5dfea5533f3e855f7684d47d959184",
      timestamp: 1784300000,
    });
    expect(receipt.fdc_attestation_ref).toBeNull();

    const upgraded = attachFdcRef(receipt, {
      network: "coston2",
      voting_round_id: 1398000,
      request_bytes: "0xabcd",
      merkle_root: "0x" + "12".repeat(32),
    });
    expect(upgraded.fdc_attestation_ref?.voting_round_id).toBe(1398000);
    expect(upgraded.receipt_hash).not.toBe(receipt.receipt_hash);
    expect(verifyReceiptHash(upgraded)).toBe(true);
    // payer_commitment and every other field preserved
    expect(upgraded.payer_commitment).toBe(receipt.payer_commitment);
    expect(upgraded.amount).toBe(receipt.amount);
  });
});

describe("bindSettlementTxHash & fdcVerifySettlement stage 2 (Red-Team CRITICAL #2)", () => {
  const TX_A =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const TX_B =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("matches identical transactionHash case-insensitively", () => {
    expect(
      bindSettlementTxHash({ transactionHash: TX_A.toUpperCase().replace("0X", "0x") }, TX_A)
        .matched,
    ).toBe(true);
  });

  it("rejects mismatched or missing transactionHash", () => {
    const mismatch = bindSettlementTxHash({ transactionHash: TX_A }, TX_B);
    expect(mismatch.matched).toBe(false);
    expect(mismatch.reason).toContain("does not match expected settlement_tx_hash");

    const missing = bindSettlementTxHash({}, TX_B);
    expect(missing.matched).toBe(false);
    expect(missing.reason).toContain("missing a valid 32-byte transactionHash");
  });

  it("rejects replaying a valid proof for TX_A when verifying settlement_tx_hash=TX_B", async () => {
    vi.spyOn(fdcV2, "retrieveAndVerifyProof").mockResolvedValue({
      verified: true,
      verification: "mocked",
      network: "coston2",
      voting_round_id: 1398000,
      attestation_type: "EVMTransaction",
      merkle_root: ("0x" + "12".repeat(32)) as `0x${string}`,
      merkle_proof: [],
      relay_address: "0x0000000000000000000000000000000000000001",
      response: {
        attestationType: encodeAttestationName("EVMTransaction"),
        sourceId: encodeAttestationName(sourceIdName("flr", "coston2")),
        votingRound: "1398000",
        lowestUsedTimestamp: "1784300000",
        requestBody: {
          transactionHash: TX_A,
          requiredConfirmations: "1",
          provideInput: false,
          listEvents: true,
          logIndices: [],
        },
        responseBody: {
          status: 1,
          events: [transferEvent(ASSET, PAYER, PAYEE, 1000n)],
        },
      },
    });

    // Replay attack: proof is for TX_A, caller asks to verify TX_B
    const replayRes = await fdcVerifySettlement({
      settlement_tx_hash: TX_B,
      network: "coston2",
      asset: ASSET,
      payee: PAYEE,
      amount: "1000",
      voting_round_id: 1398000,
      abi_encoded_request: "0xabcd",
    });
    expect(replayRes.isError).toBe(true);
    expect(replayRes.content[0].text).toContain("does not match expected settlement_tx_hash");

    // Legitimate call: proof is for TX_A, caller asks to verify TX_A
    const legitRes = await fdcVerifySettlement({
      settlement_tx_hash: TX_A,
      network: "coston2",
      asset: ASSET,
      payee: PAYEE,
      amount: "1000",
      voting_round_id: 1398000,
      abi_encoded_request: "0xabcd",
    });
    expect(legitRes.isError).toBeUndefined();
    const body = JSON.parse(legitRes.content[0].text) as { settlement_verified: boolean };
    expect(body.settlement_verified).toBe(true);
  });

  it("rejects a proof whose sourceId does not match the claimed Flare network", async () => {
    vi.spyOn(fdcV2, "retrieveAndVerifyProof").mockResolvedValue({
      verified: true,
      verification: "mocked",
      network: "mainnet",
      voting_round_id: 1398000,
      attestation_type: "EVMTransaction",
      merkle_root: ("0x" + "12".repeat(32)) as `0x${string}`,
      merkle_proof: [],
      relay_address: "0x0000000000000000000000000000000000000001",
      response: {
        attestationType: encodeAttestationName("EVMTransaction"),
        sourceId: encodeAttestationName(sourceIdName("flr", "coston2")), // testnet proof replayed on mainnet
        votingRound: "1398000",
        lowestUsedTimestamp: "1784300000",
        requestBody: {
          transactionHash: TX_A,
          requiredConfirmations: "1",
          provideInput: false,
          listEvents: true,
          logIndices: [],
        },
        responseBody: {
          status: 1,
          events: [transferEvent(ASSET, PAYER, PAYEE, 1000n)],
        },
      },
    });

    const res = await fdcVerifySettlement({
      settlement_tx_hash: TX_A,
      network: "mainnet",
      asset: ASSET,
      payee: PAYEE,
      amount: "1000",
      voting_round_id: 1398000,
      abi_encoded_request: "0xabcd",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("sourceId");
  });
});
