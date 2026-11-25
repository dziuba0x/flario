// DELICTI mandate gate for the x402 effector.
//
// DELICTI (https://github.com/dziuba0x/delicti) is a corroboration-and-consequence
// layer for agent deeds: a principal commits a mandate on-chain BEFORE the agent
// acts; effectors bind receipts to that mandate; Flare's FDC corroborates the
// effect; a bond is slashed on proof of a contradicted deed or a budget overrun.
//
// flario's role is "witness 1": the effector. Two things happen here.
//   1. mandateRefFor()  — binds the payer-supplied mandate id into the receipt so
//      the receipt becomes a DELICTI leaf (kind 2, EVM tx) a third party can check.
//   3. noteSpend()      — the running tally (DELICTI_SPEND_METER). Read before the payment so
//      structuring is refused while it is happening; written after, so the tally is a record of
//      deeds rather than of intentions.
//   2. checkMandate()   — OPTIONAL brake. If DELICTI_REGISTRY is set, the mandate
//      must be live in that registry or the payment is refused before funds move.
//      If DELICTI_REQUIRE_MANDATE=1, a payment with no mandate id is refused too:
//      a deed with no mandate is "a muscle moving with no signal".
//
// Nothing here touches the EIP-712 authorization; a wrong mandate can never move
// funds, it can only get the deed refused or later proven false.
import { getAddress, type Hex } from "viem";
import { getClient, getSigner, type NetworkType } from "../utils/rpc.js";
import type { PaymentPayload } from "./facilitator.js";
import type { MandateRef } from "./receipt.js";

const CHAIN_IDS: Record<NetworkType, number> = {
  mainnet: 14,
  coston2: 114,
  songbird: 19,
  coston: 16,
};

const METER_ABI = [
  {
    type: "function",
    name: "wouldExceed",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "headroom",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "note",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const REGISTRY_ABI = [
  {
    type: "function",
    name: "isLive",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "get",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "principal", type: "address" },
          { name: "agent", type: "address" },
          { name: "mandateHash", type: "bytes32" },
          { name: "authorityRef", type: "bytes32" },
          { name: "parentId", type: "uint256" },
          { name: "budget", type: "uint256" },
          { name: "validFrom", type: "uint64" },
          { name: "validUntil", type: "uint64" },
          { name: "revoked", type: "bool" },
        ],
      },
    ],
  },
] as const;

function meterAddress(): `0x${string}` | undefined {
  const m = process.env.DELICTI_SPEND_METER as `0x${string}` | undefined;
  return m ? getAddress(m) : undefined;
}

function configuredRegistry(): `0x${string}` | undefined {
  const fromEnv = process.env.DELICTI_REGISTRY as `0x${string}` | undefined;
  return fromEnv ? getAddress(fromEnv) : undefined;
}

// Local in-flight spend reservation per (network, mandate_id). Closes the
// concurrent structuring race between checkMandate() reading on-chain
// headroom() and noteSpend() landing on-chain after settlement.
const pendingSpend = new Map<string, bigint>();

function pendingKey(network: NetworkType, id: bigint): string {
  return `${network}:${id.toString()}`;
}

/** Release previously reserved pending spend (on settlement failure or after noteSpend). */
export function releasePendingSpend(
  network: NetworkType,
  payload: PaymentPayload,
  amount?: bigint,
): void {
  if (!payload.mandate_id) return;
  let id: bigint;
  let amt: bigint;
  try {
    id = BigInt(payload.mandate_id);
    amt = amount ?? BigInt(payload.value);
  } catch {
    return;
  }
  const key = pendingKey(network, id);
  const current = pendingSpend.get(key) ?? 0n;
  if (current <= amt) {
    pendingSpend.delete(key);
  } else {
    pendingSpend.set(key, current - amt);
  }
}

/** Test-only / diagnostic: read the locally reserved pending spend for a mandate. */
export function getPendingSpend(network: NetworkType, mandateId: string | bigint): bigint {
  return pendingSpend.get(pendingKey(network, BigInt(mandateId))) ?? 0n;
}

/** Test-only: clear all locally reserved pending spend entries. */
export function resetPendingSpend(): void {
  pendingSpend.clear();
}

/** Build the receipt's mandate_ref (null when the payer supplied no mandate). */
export function mandateRefFor(network: NetworkType, payload: PaymentPayload): MandateRef | null {
  // Never allow an unsigned payload.mandate_registry to override DELICTI_REGISTRY.
  const registry = configuredRegistry() ?? (payload.mandate_registry ? getAddress(payload.mandate_registry) : undefined);
  if (!payload.mandate_id || !registry) return null;
  return { chain_id: CHAIN_IDS[network], registry, mandate_id: String(BigInt(payload.mandate_id)) };
}

export interface MandateCheck {
  ok: boolean;
  reason?: string;
  mandate_id?: string;
  registry?: `0x${string}`;
  agent?: `0x${string}`;
}

export interface MandateDeps {
  isLive: (registry: `0x${string}`, id: bigint) => Promise<boolean>;
  getMandate: (registry: `0x${string}`, id: bigint) => Promise<{ agent: `0x${string}` }>;
  wouldExceed: (meter: `0x${string}`, id: bigint, amount: bigint) => Promise<boolean>;
  headroom: (meter: `0x${string}`, id: bigint) => Promise<bigint>;
}

function defaultMandateDeps(network: NetworkType): MandateDeps {
  const client = getClient(network);
  return {
    isLive: (registry, id) =>
      client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "isLive", args: [id] }),
    getMandate: (registry, id) =>
      client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "get", args: [id] }),
    wouldExceed: (meter, id, amount) =>
      client.readContract({ address: meter, abi: METER_ABI, functionName: "wouldExceed", args: [id, amount] }),
    headroom: (meter, id) =>
      client.readContract({ address: meter, abi: METER_ABI, functionName: "headroom", args: [id] }),
  };
}

/**
 * Optional effector-side brake. Active only when DELICTI_REGISTRY is configured
 * in the environment (an unsigned payload.mandate_registry can NEVER override
 * DELICTI_REGISTRY). Checks: mandate is live (unrevoked, inside its window,
 * every ancestor live), the payer IS the mandated agent, and if
 * DELICTI_SPEND_METER is configured, reserves pending spend locally against
 * on-chain headroom to block concurrent structuring.
 */
export async function checkMandate(
  network: NetworkType,
  payload: PaymentPayload,
  deps?: MandateDeps,
): Promise<MandateCheck> {
  const registry = configuredRegistry();
  const requireMandate = process.env.DELICTI_REQUIRE_MANDATE === "1";

  // If DELICTI_REGISTRY is configured, reject any mismatching payload.mandate_registry.
  if (registry && payload.mandate_registry !== undefined) {
    let supplied: `0x${string}`;
    try {
      supplied = getAddress(payload.mandate_registry);
    } catch {
      return {
        ok: false,
        reason: `DELICTI: invalid payload mandate_registry (${payload.mandate_registry}); expected configured DELICTI_REGISTRY (${registry})`,
        registry,
      };
    }
    if (supplied !== registry) {
      return {
        ok: false,
        reason: `DELICTI: payload mandate_registry (${supplied}) does not match configured DELICTI_REGISTRY (${registry})`,
        registry,
      };
    }
  }

  if (!payload.mandate_id) {
    return requireMandate
      ? { ok: false, reason: "DELICTI: this effector requires a mandate_id (deed without mandate refused)" }
      : { ok: true };
  }
  if (!registry) return { ok: true }; // no configured DELICTI_REGISTRY: bind only, don't gate or meter

  const id = BigInt(payload.mandate_id);
  const rpc = deps ?? defaultMandateDeps(network);
  const [live, m] = await Promise.all([
    rpc.isLive(registry, id),
    rpc.getMandate(registry, id),
  ]);
  const base = { mandate_id: id.toString(), registry, agent: m.agent as `0x${string}` };
  if (!live) return { ok: false, reason: `DELICTI: mandate #${id} is not live (revoked, expired, or ancestor dead)`, ...base };
  if (getAddress(m.agent) !== getAddress(payload.from)) {
    return { ok: false, reason: `DELICTI: payer ${payload.from} is not the agent bound by mandate #${id}`, ...base };
  }

  // The running tally. This is the only part of DELICTI that can stop structuring while it is
  // still happening: an eth_call, no transaction, no waiting on an attestation. Each slice of a
  // salami is inside its own limit, so only the cumulative total (on-chain + local pending) can
  // refuse the next one.
  const meter = meterAddress();
  if (meter) {
    const amount = BigInt(payload.value);
    const [exceeds, left] = await Promise.all([
      rpc.wouldExceed(meter, id, amount),
      rpc.headroom(meter, id),
    ]);
    // Synchronously check and reserve against pendingSpend after awaits so
    // concurrent requests cannot all slip under the same headroom snapshot.
    const key = pendingKey(network, id);
    const pending = pendingSpend.get(key) ?? 0n;
    if (exceeds || pending + amount > left) {
      const effectiveLeft = left > pending ? left - pending : 0n;
      return {
        ok: false,
        reason: `DELICTI: mandate #${id} has ${effectiveLeft} of its budget left (${pending} pending); this payment of ${amount} would exceed it`,
        ...base,
      };
    }
    pendingSpend.set(key, pending + amount);
  }
  return { ok: true, ...base };
}

export interface NoteSpendDeps {
  writeNote: (meter: `0x${string}`, id: bigint, amount: bigint) => Promise<Hex | undefined>;
  waitForReceipt?: (hash: Hex) => Promise<unknown>;
}

/**
 * Record a settled payment against the mandate's running tally.
 *
 * Requires DELICTI_REGISTRY to be configured in the environment so spend can
 * never be recorded against an unverified mandate id.
 *
 * Best-effort by design: the money has already moved, so a failure here must never turn a
 * successful payment into an error for the payer. It is not free of consequence either — an
 * effector whose tally falls behind what the FDC can prove is exactly what
 * `Bond.challengeUnderReportedSpend` convicts. Silence here is a liability, not a shortcut.
 */
export async function noteSpend(
  network: NetworkType,
  payload: PaymentPayload,
  amount: string,
  deps?: NoteSpendDeps,
): Promise<void> {
  const meter = meterAddress();
  const registry = configuredRegistry();
  if (!meter || !registry || !payload.mandate_id) return;
  const id = BigInt(payload.mandate_id);
  const amt = BigInt(amount);
  try {
    if (deps) {
      const txHash = await deps.writeNote(meter, id, amt);
      if (txHash && deps.waitForReceipt) {
        await deps.waitForReceipt(txHash);
      }
      return;
    }
    const signer = getSigner(network);
    if (!signer) {
      process.stderr.write("DELICTI: no FLARE_PRIVATE_KEY, spend not recorded on the meter\n");
      return;
    }
    const txHash = await signer.wallet.writeContract({
      address: meter,
      abi: METER_ABI,
      functionName: "note",
      args: [id, amt],
      chain: null,
      account: signer.account,
    });
    await getClient(network).waitForTransactionReceipt({ hash: txHash });
  } catch (err) {
    process.stderr.write(`DELICTI: failed to record spend on the meter: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    releasePendingSpend(network, payload, amt);
  }
}

export type { Hex };
