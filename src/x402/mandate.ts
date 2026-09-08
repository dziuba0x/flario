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
//   2. checkMandate()   — OPTIONAL brake. If DELICTI_REGISTRY is set, the mandate
//      must be live in that registry or the payment is refused before funds move.
//      If DELICTI_REQUIRE_MANDATE=1, a payment with no mandate id is refused too:
//      a deed with no mandate is "a muscle moving with no signal".
//
// Nothing here touches the EIP-712 authorization; a wrong mandate can never move
// funds, it can only get the deed refused or later proven false.
import { getAddress, type Hex } from "viem";
import { getClient, type NetworkType } from "../utils/rpc.js";
import type { PaymentPayload } from "./facilitator.js";
import type { MandateRef } from "./receipt.js";

const CHAIN_IDS: Record<NetworkType, number> = {
  mainnet: 14,
  coston2: 114,
  songbird: 19,
  coston: 16,
};

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

function registryFor(payload: PaymentPayload): `0x${string}` | undefined {
  const fromPayload = payload.mandate_registry;
  const fromEnv = process.env.DELICTI_REGISTRY as `0x${string}` | undefined;
  const r = fromPayload ?? fromEnv;
  return r ? getAddress(r) : undefined;
}

/** Build the receipt's mandate_ref (null when the payer supplied no mandate). */
export function mandateRefFor(network: NetworkType, payload: PaymentPayload): MandateRef | null {
  const registry = registryFor(payload);
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

/**
 * Optional effector-side brake. Active only when DELICTI_REGISTRY is set (or the
 * payer names a registry). Checks: mandate is live (unrevoked, inside its window,
 * every ancestor live) and the payer IS the mandated agent — so an agent cannot
 * borrow someone else's mandate.
 */
export async function checkMandate(network: NetworkType, payload: PaymentPayload): Promise<MandateCheck> {
  const registry = registryFor(payload);
  const requireMandate = process.env.DELICTI_REQUIRE_MANDATE === "1";
  if (!payload.mandate_id) {
    return requireMandate
      ? { ok: false, reason: "DELICTI: this effector requires a mandate_id (deed without mandate refused)" }
      : { ok: true };
  }
  if (!registry) return { ok: true }; // id supplied but nowhere to check it: bind only, don't gate
  const id = BigInt(payload.mandate_id);
  const client = getClient(network);
  const [live, m] = await Promise.all([
    client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "isLive", args: [id] }),
    client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "get", args: [id] }),
  ]);
  const base = { mandate_id: id.toString(), registry, agent: m.agent as `0x${string}` };
  if (!live) return { ok: false, reason: `DELICTI: mandate #${id} is not live (revoked, expired, or ancestor dead)`, ...base };
  if (getAddress(m.agent) !== getAddress(payload.from)) {
    return { ok: false, reason: `DELICTI: payer ${payload.from} is not the agent bound by mandate #${id}`, ...base };
  }
  return { ok: true, ...base };
}

export type { Hex };
