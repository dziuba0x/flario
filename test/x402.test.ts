// Offline tests for the x402 payment layer: a payer key generated in-test
// signs real EIP-712 TransferWithAuthorization payloads; verification runs
// with injected chain deps (no network).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toHex, type Hex } from "viem";
import {
  EIP3009_TYPES,
  buildRequirements,
  verifyPayment,
  settlePayment,
  resetSettledNonces,
  markSettledForTest,
  type PaymentPayload,
  type VerifyDeps,
  type SettleDeps,
} from "../src/x402/facilitator.js";
import type { X402Config } from "../src/x402/config.js";
import { loadX402Config, priceFor } from "../src/x402/config.js";
import { withX402, x402PaymentInput } from "../src/x402/paywall.js";
import {
  checkMandate,
  noteSpend,
  getPendingSpend,
  releasePendingSpend,
  resetPendingSpend,
  type MandateDeps,
} from "../src/x402/mandate.js";

const TOKEN = "0xce13911D4896200b543a61E4ae8E829E661Dd8EB" as const;
const PAYEE = "0x00000000000000000000000000000000000000A1" as const;

const config: X402Config = {
  enabled: true,
  network: "coston2",
  tokenAddress: TOKEN,
  payTo: PAYEE,
  eip712Version: "1",
  tokenDecimals: 6,
  defaultPrice: "0.001",
  toolPrices: { fassets_liquidation_scanner: "0.005" },
};

const payer = privateKeyToAccount(generatePrivateKey());
const NOW = 1_784_300_000;

const deps: VerifyDeps = {
  nonceUsedOnChain: async () => false,
  tokenName: async () => "USDT0",
  nowSeconds: () => NOW,
};

async function signPayment(
  overrides: Partial<PaymentPayload> = {},
  signer = payer,
): Promise<PaymentPayload> {
  const message = {
    from: payer.address,
    to: PAYEE,
    value: 1000n, // 0.001 with 6 decimals
    validAfter: BigInt(NOW - 60),
    validBefore: BigInt(NOW + 300),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await signer.signTypedData({
    domain: {
      name: "USDT0",
      version: "1",
      chainId: 114,
      verifyingContract: TOKEN,
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });
  const r = signature.slice(0, 66) as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = parseInt(signature.slice(130, 132), 16);
  return {
    from: message.from,
    to: message.to,
    value: message.value.toString(),
    validAfter: message.validAfter.toString(),
    validBefore: message.validBefore.toString(),
    nonce: message.nonce,
    v,
    r,
    s,
    ...overrides,
  };
}

beforeEach(() => resetSettledNonces());

describe("x402 verifyPayment", () => {
  it("accepts a correctly signed authorization", async () => {
    const payload = await signPayment();
    await expect(
      verifyPayment(config, "fdc_bulk_proof_bundle", payload, deps),
    ).resolves.toBeUndefined();
  });

  it("rejects a signature from a different key", async () => {
    const attacker = privateKeyToAccount(generatePrivateKey());
    const payload = await signPayment({}, attacker); // signed by attacker, from=payer
    await expect(
      verifyPayment(config, "fdc_bulk_proof_bundle", payload, deps),
    ).rejects.toThrow(/signature does not match/);
  });

  it("rejects a payment to the wrong payee", async () => {
    const payload = await signPayment({
      to: "0x00000000000000000000000000000000000000B2",
    });
    await expect(
      verifyPayment(config, "fdc_bulk_proof_bundle", payload, deps),
    ).rejects.toThrow(/not the configured payee/);
  });

  it("rejects an underpayment against a per-tool price", async () => {
    // 0.001 signed, but the scanner costs 0.005
    const payload = await signPayment();
    await expect(
      verifyPayment(config, "fassets_liquidation_scanner", payload, deps),
    ).rejects.toThrow(/below the required/);
  });

  it("rejects an expired authorization", async () => {
    const payload = await signPayment();
    await expect(
      verifyPayment(config, "fdc_bulk_proof_bundle", payload, {
        ...deps,
        nowSeconds: () => NOW + 3600,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("rejects a nonce already used on-chain", async () => {
    const payload = await signPayment();
    await expect(
      verifyPayment(config, "fdc_bulk_proof_bundle", payload, {
        ...deps,
        nonceUsedOnChain: async () => true,
      }),
    ).rejects.toThrow(/already used on-chain/);
  });

  it("rejects a replay of a payload settled by this server", async () => {
    const payload = await signPayment();
    await verifyPayment(config, "fdc_bulk_proof_bundle", payload, deps);
    markSettledForTest(payload);
    await expect(
      verifyPayment(config, "fdc_bulk_proof_bundle", payload, deps),
    ).rejects.toThrow(/already settled by this server/);
  });
});

describe("x402 requirements + config", () => {
  it("builds x402 requirements with per-tool pricing", () => {
    const req = buildRequirements(config, "fassets_liquidation_scanner");
    expect(req.scheme).toBe("exact");
    expect(req.asset).toBe(TOKEN);
    expect(req.payTo).toBe(PAYEE);
    expect(req.maxAmountRequired).toBe("5000"); // 0.005 @ 6 decimals
    expect(req.extra.chainId).toBe(114);
    expect(req.extra.standard).toBe("EIP-3009");
    expect(priceFor(config, "fdc_bulk_proof_bundle")).toBe("0.001");
  });
});

describe("x402 paywall (MCP adapter)", () => {
  const envKeys = [
    "X402_ENABLED",
    "X402_PAY_TO",
    "X402_NETWORK",
    "X402_ALLOW_MAINNET",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of envKeys) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const echoTool = withX402("echo_tool", async (args: { q: string }) => ({
    content: [{ type: "text" as const, text: JSON.stringify({ echoed: args.q }) }],
  }));

  it("is a passthrough when X402_ENABLED is unset", async () => {
    delete process.env.X402_ENABLED;
    const res = await echoTool({ q: "hi" });
    expect(JSON.parse(res.content[0].text)).toEqual({ echoed: "hi" });
  });

  it("returns payment requirements when enabled and unpaid", async () => {
    process.env.X402_ENABLED = "true";
    process.env.X402_NETWORK = "coston2";
    process.env.X402_PAY_TO = PAYEE;
    const res = await echoTool({ q: "hi" });
    const body = JSON.parse(res.content[0].text);
    expect(body.x402_payment_required).toBe(true);
    expect(body.accepts[0].payTo).toBe(PAYEE);
    expect(body.accepts[0].network).toBe("coston2");
  });

  it("rejects a malformed x402_payment without touching the network", async () => {
    process.env.X402_ENABLED = "true";
    process.env.X402_NETWORK = "coston2";
    process.env.X402_PAY_TO = PAYEE;
    const res = await echoTool({
      q: "hi",
      x402_payment: Buffer.from('{"from":"0x1"}').toString("base64"),
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("missing");
  });

  it("refuses mainnet without the explicit allow flag", () => {
    process.env.X402_ENABLED = "true";
    process.env.X402_NETWORK = "mainnet";
    process.env.X402_PAY_TO = PAYEE;
    delete process.env.X402_ALLOW_MAINNET;
    expect(loadX402Config()).toBeNull();
  });

  it("exposes the optional x402_payment input", () => {
    expect(Object.keys(x402PaymentInput)).toEqual(["x402_payment"]);
  });
});

describe("x402 security regressions (Red-Team #43)", () => {
  const REGISTRY = "0x73109d769878cA2Cf0Ba180CF4f1a24b404F3f48" as const;
  const ATTACKER_REGISTRY = "0x000000000000000000000000000000000000dEaD" as const;
  const METER = "0x1111111111111111111111111111111111111111" as const;

  const delictiEnvKeys = [
    "DELICTI_REGISTRY",
    "DELICTI_SPEND_METER",
    "DELICTI_REQUIRE_MANDATE",
  ];
  const savedDelicti: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetSettledNonces();
    resetPendingSpend();
    for (const k of delictiEnvKeys) {
      savedDelicti[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    resetSettledNonces();
    resetPendingSpend();
    for (const k of delictiEnvKeys) {
      if (savedDelicti[k] === undefined) delete process.env[k];
      else process.env[k] = savedDelicti[k];
    }
  });

  // CRITICAL #1: unsigned payload.mandate_registry must never override DELICTI_REGISTRY
  it("CRITICAL #1: rejects payload.mandate_registry differing from DELICTI_REGISTRY", async () => {
    process.env.DELICTI_REGISTRY = REGISTRY;
    const payload = await signPayment({
      mandate_id: "42",
      mandate_registry: ATTACKER_REGISTRY,
    });
    const isLive = vi.fn(async () => true);
    const getMandate = vi.fn(async () => ({ agent: payer.address }));
    const mandateDeps: MandateDeps = {
      isLive,
      getMandate,
      wouldExceed: async () => false,
      headroom: async () => 1_000_000n,
    };

    const gate = await checkMandate("coston2", payload, mandateDeps);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/does not match configured DELICTI_REGISTRY/);
    expect(isLive).not.toHaveBeenCalled();
    expect(getMandate).not.toHaveBeenCalled();
  });

  it("CRITICAL #1: noteSpend does not write to DELICTI_SPEND_METER when DELICTI_REGISTRY is unset", async () => {
    process.env.DELICTI_SPEND_METER = METER;
    delete process.env.DELICTI_REGISTRY;
    const payload = await signPayment({
      mandate_id: "42",
      mandate_registry: ATTACKER_REGISTRY,
    });
    const writeNote = vi.fn(async () => ("0x" + "aa".repeat(32)) as Hex);
    await noteSpend("coston2", payload, "1000", { writeNote });
    expect(writeNote).not.toHaveBeenCalled();
  });

  // MEDIUM #6: local EIP-712 verification must run before on-chain nonceUsedOnChain RPC
  it("MEDIUM #6: verifies EIP-712 signature locally before calling nonceUsedOnChain", async () => {
    const attacker = privateKeyToAccount(generatePrivateKey());
    const forged = await signPayment({}, attacker);
    const nonceUsedOnChain = vi.fn(async () => false);

    await expect(
      verifyPayment(config, "fdc_bulk_proof_bundle", forged, {
        ...deps,
        nonceUsedOnChain,
      }),
    ).rejects.toThrow(/signature does not match/);
    expect(nonceUsedOnChain).not.toHaveBeenCalled();
  });

  // HIGH #2: synchronous inFlightNonces closes TOCTOU concurrent replay window
  it("HIGH #2: blocks concurrent replay of the same from:nonce before broadcasting a 2nd tx", async () => {
    const payload = await signPayment();
    const txHash = ("0x" + "ab".repeat(32)) as Hex;
    let releaseReceipt!: () => void;
    const receiptBarrier = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });

    const writeContract = vi.fn(async () => txHash);
    const settleDeps: SettleDeps = {
      simulateVrs: async () => ({ mocked: true }),
      simulatePacked: async () => ({ mocked: true }),
      writeContract,
      waitForReceipt: async (hash) => {
        await receiptBarrier;
        return { status: "success", blockNumber: 123n, transactionHash: hash };
      },
    };

    const first = settlePayment(config, payload, settleDeps);
    const second = settlePayment(config, payload, settleDeps);

    await expect(second).rejects.toThrow(/in flight|already settled/i);
    expect(writeContract).toHaveBeenCalledTimes(1);

    releaseReceipt();
    const settled = await first;
    expect(settled.tx_hash).toBe(txHash);
  });

  // HIGH #3: fallback to packed-signature only on simulation error, never on writeContract error;
  // and reject replaced receipts whose transactionHash !== txHash
  it("HIGH #3: does not fall back to packed signature after writeContract fails", async () => {
    const payload = await signPayment();
    const simulatePacked = vi.fn(async () => ({ packed: true }));
    const writeContract = vi.fn(async () => {
      throw new Error("rpc timeout after broadcast");
    });
    const settleDeps: SettleDeps = {
      simulateVrs: async () => ({ vrs: true }),
      simulatePacked,
      writeContract,
      waitForReceipt: async (hash) => ({
        status: "success",
        blockNumber: 1n,
        transactionHash: hash,
      }),
    };

    await expect(settlePayment(config, payload, settleDeps)).rejects.toThrow(
      /rpc timeout after broadcast/,
    );
    expect(simulatePacked).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("HIGH #3: rejects a replaced transaction receipt with mismatched transactionHash", async () => {
    const payload = await signPayment();
    const broadcastHash = ("0x" + "11".repeat(32)) as Hex;
    const foreignHash = ("0x" + "22".repeat(32)) as Hex;

    const settleDeps: SettleDeps = {
      simulateVrs: async () => ({ vrs: true }),
      simulatePacked: async () => ({ packed: true }),
      writeContract: async () => broadcastHash,
      waitForReceipt: async () => ({
        status: "success",
        blockNumber: 42n,
        transactionHash: foreignHash,
      }),
    };

    await expect(settlePayment(config, payload, settleDeps)).rejects.toThrow(
      /replaced|mismatched receipt/i,
    );
  });

  // HIGH #4: local pendingSpend reservation blocks concurrent structuring on DELICTI_SPEND_METER
  it("HIGH #4: blocks concurrent structuring via local pendingSpend reservation", async () => {
    process.env.DELICTI_REGISTRY = REGISTRY;
    process.env.DELICTI_SPEND_METER = METER;

    // Two concurrent payments of 600 each against on-chain headroom of 1000.
    const p1 = await signPayment({ value: "600", mandate_id: "7" });
    const p2 = await signPayment({ value: "600", mandate_id: "7" });

    const mandateDeps: MandateDeps = {
      isLive: async () => true,
      getMandate: async () => ({ agent: payer.address }),
      wouldExceed: async (_meter, _id, amount) => amount > 1000n,
      headroom: async () => 1000n,
    };

    const [g1, g2] = await Promise.all([
      checkMandate("coston2", p1, mandateDeps),
      checkMandate("coston2", p2, mandateDeps),
    ]);

    expect([g1.ok, g2.ok].filter(Boolean)).toHaveLength(1);
    const rejected = g1.ok ? g2 : g1;
    expect(rejected.reason).toMatch(/pending|would exceed/i);
    expect(getPendingSpend("coston2", "7")).toBe(600n);

    // Releasing (e.g. after noteSpend or settlement failure) frees the reservation.
    releasePendingSpend("coston2", p1);
    expect(getPendingSpend("coston2", "7")).toBe(0n);
  });
});
