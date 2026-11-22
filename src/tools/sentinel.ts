// Contract Sentinel (x402-gated): static EVM bytecode & EIP-1967/EIP-1167 proxy
// risk analyzer for Flare networks. With X402_ENABLED unset the paywall wrapper
// is a passthrough.
import { z } from "zod";
import { formatEther, getAddress } from "viem";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient, type NetworkType } from "../utils/rpc.js";
import { withX402, x402PaymentInput } from "../x402/paywall.js";

/** EIP-1967 implementation storage slot: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1) */
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** EIP-1967 admin storage slot: bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1) */
export const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

/** Standard EIP-1167 minimal proxy runtime bytecode prefix (10 bytes). */
const EIP1167_PREFIX = "363d3d373d3d3d363d73";

const ZERO_ADDRESS_HEX = "0".repeat(40);

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ProxyType = "NONE" | "EIP-1167" | "EIP-1967";

export interface OpcodeCounts {
  selfdestruct: number;
  delegatecall: number;
  create2: number;
  create: number;
  origin: number;
}

export interface DetectedSelector {
  selector: `0x${string}`;
  signature: string;
  category: string;
}

export interface BytecodeRiskExtra {
  eip1967Impl?: string | null;
  eip1967Admin?: string | null;
}

export interface ImplementationAnalysis {
  is_contract: boolean;
  bytecode_bytes: number;
  opcodes: OpcodeCounts;
  detected_selectors: DetectedSelector[];
  red_flags: string[];
  risk_score: number;
  risk_level: RiskLevel;
}

export interface BytecodeRiskAnalysis {
  is_contract: boolean;
  bytecode_bytes: number;
  proxy_type: ProxyType;
  proxy_implementation: string | null;
  proxy_admin: string | null;
  opcodes: OpcodeCounts;
  detected_selectors: DetectedSelector[];
  red_flags: string[];
  risk_score: number;
  risk_level: RiskLevel;
  verdict: string;
  implementation_analysis?: ImplementationAnalysis;
}

interface SelectorSpec {
  hex: string;
  signature: string;
  category: string;
}

const KNOWN_SELECTORS: readonly SelectorSpec[] = [
  { hex: "a9059cbb", signature: "transfer(address,uint256)", category: "ERC-20" },
  { hex: "23b872dd", signature: "transferFrom(address,address,uint256)", category: "ERC-20" },
  { hex: "095ea7b3", signature: "approve(address,uint256)", category: "ERC-20" },
  {
    hex: "e3ee160e",
    signature:
      "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
    category: "EIP-3009",
  },
  {
    hex: "cf092995",
    signature:
      "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
    category: "EIP-3009",
  },
  {
    hex: "ef55bec6",
    signature:
      "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
    category: "EIP-3009",
  },
  { hex: "8da5cb5b", signature: "owner()", category: "Ownable" },
  { hex: "f2fde38b", signature: "transferOwnership(address)", category: "Ownable" },
  { hex: "8456cb59", signature: "pause()", category: "Pausable" },
  { hex: "3f4ba83a", signature: "unpause()", category: "Pausable" },
  { hex: "5c975abb", signature: "paused()", category: "Pausable" },
  { hex: "3659cfe6", signature: "upgradeTo(address)", category: "Upgradeable" },
  { hex: "4f1ef286", signature: "upgradeToAndCall(address,bytes)", category: "Upgradeable" },
  { hex: "40c10f19", signature: "mint(address,uint256)", category: "Mintable" },
  { hex: "9dc29fac", signature: "burn(address,uint256)", category: "Burnable" },
];

function toolError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

function toolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          data,
          (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
          2,
        ),
      },
    ],
  };
}

function normalizeHex(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const body = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (body.length === 0) return "";
  if (body.length % 2 !== 0 || !/^[0-9a-f]+$/.test(body)) {
    throw new Error("Invalid hex bytecode string");
  }
  return body;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Extracts a non-zero checksummed 20-byte EVM address from either a 32-byte
 * storage slot value or a 20-byte address hex string. Returns null for empty
 * or zero values.
 */
function extractNonZeroAddress(slotOrAddress?: string | null): string | null {
  if (!slotOrAddress) return null;
  const trimmed = slotOrAddress.trim().toLowerCase();
  const body = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (body.length === 0 || !/^[0-9a-f]+$/.test(body)) return null;
  const padded = body.padStart(40, "0");
  const last40 = padded.slice(-40);
  if (last40 === ZERO_ADDRESS_HEX) return null;
  return getAddress(`0x${last40}`);
}

/** Byte-aligned search for a 4-byte selector inside raw bytecode bytes. */
function containsSelectorBytes(bytecode: Uint8Array, selectorHex: string): boolean {
  if (bytecode.length < 4) return false;
  const b0 = parseInt(selectorHex.slice(0, 2), 16);
  const b1 = parseInt(selectorHex.slice(2, 4), 16);
  const b2 = parseInt(selectorHex.slice(4, 6), 16);
  const b3 = parseInt(selectorHex.slice(6, 8), 16);
  for (let i = 0; i <= bytecode.length - 4; i++) {
    if (
      bytecode[i] === b0 &&
      bytecode[i + 1] === b1 &&
      bytecode[i + 2] === b2 &&
      bytecode[i + 3] === b3
    ) {
      return true;
    }
  }
  return false;
}

function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 75) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

function verdictFromRiskLevel(level: RiskLevel): string {
  const verdictByLevel: Record<RiskLevel, string> = {
    LOW: "Low static bytecode risk: no high-severity opcodes or upgradeability risks detected.",
    MEDIUM: "Moderate risk: proxy delegation, factory creation, or privileged controls detected — review before interacting.",
    HIGH: "High risk: dangerous opcodes (e.g. SELFDESTRUCT / tx.origin / unverified DELEGATECALL) or upgradeable privileges detected.",
    CRITICAL: "Critical risk: multiple severe bytecode/upgradeability red flags detected — treat with extreme caution.",
  };
  return verdictByLevel[level];
}

/**
 * Pure, deterministic static analyzer for EVM runtime bytecode and optional
 * EIP-1967 storage slots. Skips immediate data bytes following PUSH1..PUSH32
 * (0x60..0x7f) so embedded constants never trigger false opcode alerts.
 */
export function analyzeBytecodeRisk(
  bytecodeHex: string,
  extra?: BytecodeRiskExtra,
): BytecodeRiskAnalysis {
  const hex = normalizeHex(bytecodeHex);
  const emptyOpcodes: OpcodeCounts = {
    selfdestruct: 0,
    delegatecall: 0,
    create2: 0,
    create: 0,
    origin: 0,
  };

  if (hex.length === 0) {
    return {
      is_contract: false,
      bytecode_bytes: 0,
      proxy_type: "NONE",
      proxy_implementation: null,
      proxy_admin: null,
      opcodes: emptyOpcodes,
      detected_selectors: [],
      red_flags: [],
      risk_score: 0,
      risk_level: "LOW",
      verdict: "EOA (no contract bytecode deployed at this address).",
    };
  }

  const bytes = hexToBytes(hex);
  const opcodes: OpcodeCounts = { ...emptyOpcodes };

  // Walk EVM instructions while skipping immediate push data (PUSH1=0x60 .. PUSH32=0x7f).
  for (let i = 0; i < bytes.length; ) {
    const op = bytes[i];
    if (op >= 0x60 && op <= 0x7f) {
      const pushBytes = op - 0x5f;
      i += 1 + pushBytes;
      continue;
    }
    switch (op) {
      case 0xff:
        opcodes.selfdestruct += 1;
        break;
      case 0xf4:
        opcodes.delegatecall += 1;
        break;
      case 0xf5:
        opcodes.create2 += 1;
        break;
      case 0xf0:
        opcodes.create += 1;
        break;
      case 0x32:
        opcodes.origin += 1;
        break;
      default:
        break;
    }
    i += 1;
  }

  // Proxy detection: EIP-1167 minimal proxy in bytecode, or EIP-1967 storage slots.
  const eip1967Impl = extractNonZeroAddress(extra?.eip1967Impl);
  const eip1967Admin = extractNonZeroAddress(extra?.eip1967Admin);

  let proxyType: ProxyType = "NONE";
  let proxyImplementation: string | null = null;
  let proxyAdmin: string | null = eip1967Admin;

  if (hex.startsWith(EIP1167_PREFIX) && hex.length >= EIP1167_PREFIX.length + 40) {
    proxyType = "EIP-1167";
    proxyImplementation = extractNonZeroAddress(
      hex.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40),
    );
  } else if (eip1967Impl) {
    proxyType = "EIP-1967";
    proxyImplementation = eip1967Impl;
  }

  // Detect known 4-byte function selectors (byte-aligned).
  const detectedSelectors: DetectedSelector[] = [];
  for (const spec of KNOWN_SELECTORS) {
    if (containsSelectorBytes(bytes, spec.hex)) {
      detectedSelectors.push({
        selector: `0x${spec.hex}`,
        signature: spec.signature,
        category: spec.category,
      });
    }
  }

  const selectorSet = new Set(detectedSelectors.map((s) => s.selector));
  const redFlags: string[] = [];
  let score = 0;

  if (opcodes.selfdestruct > 0) {
    score += 45;
    redFlags.push(
      `Contains SELFDESTRUCT (0xff) opcode (${opcodes.selfdestruct}x): contract code or funds may be destroyed/drained.`,
    );
  }

  if (opcodes.origin > 0) {
    score += 20;
    redFlags.push(
      `Uses ORIGIN / tx.origin (0x32) opcode (${opcodes.origin}x): potential phishing / authorization bypass risk.`,
    );
  }

  if (opcodes.delegatecall > 0) {
    if (proxyType === "NONE") {
      score += 25;
      redFlags.push(
        `Contains DELEGATECALL (0xf4) (${opcodes.delegatecall}x) without standard EIP-1167/EIP-1967 proxy pattern: arbitrary code execution in contract storage context.`,
      );
    } else {
      score += 15;
      redFlags.push(
        `Delegates execution via DELEGATECALL (0xf4) (${opcodes.delegatecall}x) as ${proxyType} proxy.`,
      );
    }
  }

  if (proxyType === "EIP-1167") {
    score += 10;
    redFlags.push(
      `EIP-1167 minimal proxy forwarding calls to implementation ${proxyImplementation ?? "unknown"}: audit the implementation contract too.`,
    );
  } else if (proxyType === "EIP-1967") {
    score += 15;
    redFlags.push(
      `Upgradeable EIP-1967 proxy pointing to implementation ${proxyImplementation}: logic can be replaced.`,
    );
    if (proxyAdmin) {
      score += 10;
      redFlags.push(
        `Active EIP-1967 proxy admin (${proxyAdmin}) can upgrade the implementation contract.`,
      );
    }
  }

  if (opcodes.create2 > 0) {
    score += 15;
    redFlags.push(
      `Contains CREATE2 (0xf5) (${opcodes.create2}x): deterministic deployment (check for metamorphic contract patterns).`,
    );
  }

  if (opcodes.create > 0) {
    score += 5;
    redFlags.push(
      `Contains CREATE (0xf0) (${opcodes.create}x): contract can deploy child contracts dynamically.`,
    );
  }

  if (selectorSet.has("0x3659cfe6") || selectorSet.has("0x4f1ef286")) {
    score += 15;
    redFlags.push(
      "Exposes upgradeability selector (upgradeTo / upgradeToAndCall): contract logic may be upgraded.",
    );
  }

  if (selectorSet.has("0x40c10f19")) {
    score += 10;
    redFlags.push("Exposes mint(address,uint256) selector: privileged supply inflation possible.");
  }

  if (selectorSet.has("0x8456cb59")) {
    score += 10;
    redFlags.push("Exposes pause() selector: privileged actor can halt contract operations.");
  }

  if (selectorSet.has("0x8da5cb5b") || selectorSet.has("0xf2fde38b")) {
    score += 5;
    redFlags.push("Uses Ownable pattern (owner / transferOwnership): privileged admin control.");
  }

  const clampedScore = Math.min(100, Math.max(0, score));
  const riskLevel = riskLevelFromScore(clampedScore);

  return {
    is_contract: true,
    bytecode_bytes: bytes.length,
    proxy_type: proxyType,
    proxy_implementation: proxyImplementation,
    proxy_admin: proxyAdmin,
    opcodes,
    detected_selectors: detectedSelectors,
    red_flags: redFlags,
    risk_score: clampedScore,
    risk_level: riskLevel,
    verdict: verdictFromRiskLevel(riskLevel),
  };
}

/**
 * Pure, deterministic combiner that merges proxy shell bytecode analysis with
 * the unwrapped implementation contract analysis (EIP-1967 / EIP-1167).
 * Deduplicates detected selectors, attaches `implementation_analysis`, propagates
 * implementation red flags, and recomputes clamped risk_score / risk_level / verdict.
 */
export function mergeProxyAndImplRisk(
  proxyAnalysis: BytecodeRiskAnalysis,
  implAnalysis: BytecodeRiskAnalysis,
): BytecodeRiskAnalysis {
  // Merge and deduplicate detected selectors by 4-byte selector hex.
  const seenSelectors = new Set<string>();
  const mergedSelectors: DetectedSelector[] = [];
  for (const s of [...proxyAnalysis.detected_selectors, ...implAnalysis.detected_selectors]) {
    const key = s.selector.toLowerCase();
    if (!seenSelectors.has(key)) {
      seenSelectors.add(key);
      mergedSelectors.push(s);
    }
  }

  const proxySelectorSet = new Set(
    proxyAnalysis.detected_selectors.map((s) => s.selector.toLowerCase()),
  );
  const implSelectorSet = new Set(
    implAnalysis.detected_selectors.map((s) => s.selector.toLowerCase()),
  );

  const mergedRedFlags = [...proxyAnalysis.red_flags];
  let score = proxyAnalysis.risk_score;

  if (!implAnalysis.is_contract) {
    score += 20;
    mergedRedFlags.push(
      "[Implementation] Target implementation address has no deployed bytecode (EOA or self-destructed).",
    );
  } else {
    // Propagate opcode risks discovered in the implementation contract.
    if (implAnalysis.opcodes.selfdestruct > 0) {
      score += 45;
    }
    if (implAnalysis.opcodes.origin > 0) {
      score += 20;
    }
    if (implAnalysis.opcodes.delegatecall > 0) {
      score += implAnalysis.proxy_type === "NONE" ? 25 : 15;
    }
    if (implAnalysis.opcodes.create2 > 0) {
      score += 15;
    }
    if (implAnalysis.opcodes.create > 0) {
      score += 5;
    }

    // Propagate privileged selector risks not already counted on the proxy shell.
    const proxyHasUpgrade =
      proxySelectorSet.has("0x3659cfe6") || proxySelectorSet.has("0x4f1ef286");
    const implHasUpgrade =
      implSelectorSet.has("0x3659cfe6") || implSelectorSet.has("0x4f1ef286");
    if (implHasUpgrade && !proxyHasUpgrade) {
      score += 15;
    }

    if (implSelectorSet.has("0x40c10f19") && !proxySelectorSet.has("0x40c10f19")) {
      score += 10;
    }

    if (implSelectorSet.has("0x8456cb59") && !proxySelectorSet.has("0x8456cb59")) {
      score += 10;
    }

    const proxyHasOwner =
      proxySelectorSet.has("0x8da5cb5b") || proxySelectorSet.has("0xf2fde38b");
    const implHasOwner =
      implSelectorSet.has("0x8da5cb5b") || implSelectorSet.has("0xf2fde38b");
    if (implHasOwner && !proxyHasOwner) {
      score += 5;
    }

    for (const flag of implAnalysis.red_flags) {
      const tagged = `[Implementation] ${flag}`;
      if (!mergedRedFlags.includes(tagged)) {
        mergedRedFlags.push(tagged);
      }
    }
  }

  const clampedScore = Math.min(100, Math.max(0, score));
  const riskLevel = riskLevelFromScore(clampedScore);

  const implementationAnalysis: ImplementationAnalysis = {
    is_contract: implAnalysis.is_contract,
    bytecode_bytes: implAnalysis.bytecode_bytes,
    opcodes: { ...implAnalysis.opcodes },
    detected_selectors: [...implAnalysis.detected_selectors],
    red_flags: [...implAnalysis.red_flags],
    risk_score: implAnalysis.risk_score,
    risk_level: implAnalysis.risk_level,
  };

  return {
    ...proxyAnalysis,
    detected_selectors: mergedSelectors,
    red_flags: mergedRedFlags,
    risk_score: clampedScore,
    risk_level: riskLevel,
    verdict: verdictFromRiskLevel(riskLevel),
    implementation_analysis: implementationAnalysis,
  };
}

export const flareContractSentinelInput = {
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 20-byte 0x-prefixed EVM address")
    .describe("Contract or EOA address to audit on Flare."),
  network: z
    .enum(["mainnet", "coston2", "songbird", "coston"])
    .default("mainnet")
    .describe("Flare network to query (mainnet, coston2, songbird, or coston)."),
  ...x402PaymentInput,
};

export async function sentinelCore(args: {
  address: string;
  network?: NetworkType;
}) {
  const network: NetworkType = args.network ?? "mainnet";
  try {
    const normalizedAddress = getAddress(args.address);
    const client = getClient(network);

    const [bytecode, balance, implSlot, adminSlot] = await Promise.all([
      client.getCode({ address: normalizedAddress }),
      client.getBalance({ address: normalizedAddress }),
      client.getStorageAt({
        address: normalizedAddress,
        slot: EIP1967_IMPLEMENTATION_SLOT,
      }),
      client.getStorageAt({
        address: normalizedAddress,
        slot: EIP1967_ADMIN_SLOT,
      }),
    ]);

    let analysis = analyzeBytecodeRisk(bytecode ?? "0x", {
      eip1967Impl: implSlot ?? null,
      eip1967Admin: adminSlot ?? null,
    });

    if (
      (analysis.proxy_type === "EIP-1967" || analysis.proxy_type === "EIP-1167") &&
      analysis.proxy_implementation
    ) {
      const implBytecode = await client.getCode({
        address: getAddress(analysis.proxy_implementation),
      });
      const implAnalysis = analyzeBytecodeRisk(implBytecode ?? "0x");
      analysis = mergeProxyAndImplRisk(analysis, implAnalysis);
    }

    return toolResult({
      address: normalizedAddress,
      network,
      balance_wei: balance.toString(),
      balance_native: formatEther(balance),
      ...analysis,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Contract sentinel failed for ${args.address} on ${network}: ${message}`);
  }
}

export const flareContractSentinel = withX402(
  "flare_contract_sentinel",
  sentinelCore,
);

export function registerSentinelTool(server: McpServer): void {
  server.tool(
    "flare_contract_sentinel",
    "Static EVM bytecode & proxy risk analyzer for any address on Flare (mainnet, coston2, songbird, coston). Detects EOA vs contract, automatically unwraps EIP-1167/EIP-1967 proxy implementations, scans risky opcodes (SELFDESTRUCT, DELEGATECALL, CREATE2, CREATE, ORIGIN) with PUSH-safe disassembly, detects common function selectors (ERC-20, EIP-3009, Ownable, Pausable, UUPS, Mintable), and returns a 0-100 risk score with red flags.",
    flareContractSentinelInput,
    flareContractSentinel,
  );
}
