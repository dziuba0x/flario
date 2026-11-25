// FDC-verified settlement (handoff Principle 4 — the headline differentiator).
//
// Proves an x402 settlement using Flare's *enshrined* FDC, not the
// facilitator's word: an FDC EVMTransaction attestation over the settlement
// transaction, locally Merkle-verified against the on-chain Relay root, is then
// BOUND to the payment claim — we confirm the attested tx actually contains an
// ERC-20 Transfer of >= `amount` of `asset` to `payee`. "tx X is confirmed" is
// not enough; it must be the payment the receipt claims.
//
// On-Flare settlement is an ERC-20 transfer, so the correct FDC primitive is
// EVMTransaction (source: the Flare network itself), NOT Payment — Payment
// attests native BTC/DOGE/XRP payments. See DECISIONS §10.
//
// Security posture: this tool NEVER submits an FdcHub transaction. The attest
// request is permissionless — the caller submits it with their own key (via
// `fdc_request_attestation`) so a hosted hub cannot be griefed into spending the
// operator's gas. Phase 1 here only *prepares* (verifier API, no chain write);
// phase 2 retrieves + verifies + binds.
import { z } from "zod";
import { keccak256, toBytes, getAddress, type Hex } from "viem";
import type { NetworkType } from "../utils/rpc.js";
import {
  prepareAttestationRequest,
  encodeAttestationName,
  sourceIdName,
  type SourceChain,
} from "../utils/fdc.js";
import { retrieveAndVerifyProof } from "./fdc-v2.js";
import type { FdcAttestationRef } from "../x402/receipt.js";

// keccak256("Transfer(address,address,uint256)")
export const ERC20_TRANSFER_TOPIC = keccak256(
  toBytes("Transfer(address,address,uint256)"),
).toLowerCase();

// Flare network → EVMTransaction source chain. Coston2/Coston get the testnet
// sourceId ("testFLR"/"testSGB") applied by prepareAttestationRequest. Verified
// live: EVMTransaction/flr on coston2 → VALID.
const EVM_SOURCE: Record<NetworkType, SourceChain> = {
  mainnet: "flr",
  coston2: "flr",
  songbird: "sgb",
  coston: "sgb",
};

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

/** Last 20 bytes of a 32-byte indexed-address topic → checksummed address. */
function topicToAddress(topic: string): `0x${string}` {
  return getAddress(`0x${topic.slice(-40)}`);
}

export interface TransferCriteria {
  asset: `0x${string}`;
  payee: `0x${string}`;
  amount: string; // integer base units
  payer?: `0x${string}`;
}

interface EvmEvent {
  logIndex?: number | string;
  emitterAddress?: string;
  topics?: string[];
  data?: string;
  removed?: boolean;
}

export interface BindingResult {
  matched: boolean;
  reason?: string;
  matched_log_index?: number;
  observed_value?: string;
  from?: `0x${string}`;
}

/**
 * Security core: scan the attested EVMTransaction's events for an ERC-20
 * Transfer that satisfies the payment claim (right token, right recipient,
 * value >= amount, and — if given — right payer). Returns the first match.
 */
export function bindTransfer(
  events: EvmEvent[],
  criteria: TransferCriteria,
): BindingResult {
  const wantAsset = getAddress(criteria.asset);
  const wantPayee = getAddress(criteria.payee);
  const wantAmount = BigInt(criteria.amount);
  const wantPayer = criteria.payer ? getAddress(criteria.payer) : undefined;

  let sawTokenTransfer = false;
  for (const ev of events ?? []) {
    const topics = ev.topics ?? [];
    if ((topics[0] ?? "").toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (topics.length < 3 || ev.emitterAddress == null || ev.data == null) continue;

    let emitter: `0x${string}`;
    try {
      emitter = getAddress(ev.emitterAddress);
    } catch {
      continue;
    }
    if (emitter !== wantAsset) continue;
    sawTokenTransfer = true;

    let to: `0x${string}`;
    let from: `0x${string}`;
    try {
      from = topicToAddress(topics[1]);
      to = topicToAddress(topics[2]);
    } catch {
      continue;
    }
    if (to !== wantPayee) continue;
    if (wantPayer && from !== wantPayer) continue;

    let value: bigint;
    try {
      value = BigInt(ev.data);
    } catch {
      continue;
    }
    if (value < wantAmount) continue;

    return {
      matched: true,
      matched_log_index: Number(ev.logIndex ?? -1),
      observed_value: value.toString(),
      from,
    };
  }

  return {
    matched: false,
    reason: sawTokenTransfer
      ? "the asset emitted a Transfer, but none matched payee/amount(/payer)"
      : "no ERC-20 Transfer of the given asset was found in the attested transaction",
  };
}

export interface TxHashBindingResult {
  matched: boolean;
  attested_tx_hash?: string;
  reason?: string;
}

/**
 * Bind the attested EVMTransaction requestBody.transactionHash strictly to the
 * expected settlement_tx_hash so an attacker cannot replay an attestation from
 * an unrelated (or older) transaction.
 */
export function bindSettlementTxHash(
  requestBody: { transactionHash?: unknown } | undefined,
  expectedTxHash: string,
): TxHashBindingResult {
  const attested = requestBody?.transactionHash;
  if (typeof attested !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(attested)) {
    return {
      matched: false,
      reason: "attested requestBody is missing a valid 32-byte transactionHash",
    };
  }
  if (attested.toLowerCase() !== expectedTxHash.toLowerCase()) {
    return {
      matched: false,
      attested_tx_hash: attested,
      reason: `attested transactionHash (${attested}) does not match expected settlement_tx_hash (${expectedTxHash})`,
    };
  }
  return { matched: true, attested_tx_hash: attested };
}

export const fdcVerifySettlementInput = {
  settlement_tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  payee: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amount: z.string().regex(/^\d+$/),
  payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  required_confirmations: z.number().int().positive().max(100).optional(),
  // Phase 2 (verify + bind): supply the finalized attestation handle.
  voting_round_id: z.number().int().nonnegative().optional(),
  abi_encoded_request: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
};

export async function fdcVerifySettlement(args: {
  settlement_tx_hash: string;
  network: NetworkType;
  asset: string;
  payee: string;
  amount: string;
  payer?: string;
  required_confirmations?: number;
  voting_round_id?: number;
  abi_encoded_request?: string;
}) {
  const { settlement_tx_hash, network } = args;
  const criteria: TransferCriteria = {
    asset: getAddress(args.asset),
    payee: getAddress(args.payee),
    amount: args.amount,
    payer: args.payer ? getAddress(args.payer) : undefined,
  };

  // ---- Phase 2: verify a finalized attestation and bind it to the claim ----
  if (args.voting_round_id !== undefined && args.abi_encoded_request) {
    try {
      const proof = await retrieveAndVerifyProof(
        args.voting_round_id,
        args.abi_encoded_request,
        network,
      );
      if (proof.attestation_type !== "EVMTransaction") {
        return toolError(
          `Attestation is ${proof.attestation_type}, expected EVMTransaction over the settlement tx.`,
        );
      }

      const reqBody = proof.response.requestBody as
        | { transactionHash?: unknown; requiredConfirmations?: number | string }
        | undefined;
      const txBinding = bindSettlementTxHash(reqBody, settlement_tx_hash);
      if (!txBinding.matched) {
        return toolError(
          `FDC attestation is VALID (Merkle-verified against the Relay root), but it is NOT for the claimed settlement transaction: ${txBinding.reason}. Do not treat this settlement as verified.`,
        );
      }

      const expectedSourceId = encodeAttestationName(
        sourceIdName(EVM_SOURCE[network], network),
      );
      if (
        typeof proof.response.sourceId === "string" &&
        proof.response.sourceId.toLowerCase() !== expectedSourceId.toLowerCase()
      ) {
        return toolError(
          `FDC attestation sourceId (${proof.response.sourceId}) does not match expected ${sourceIdName(EVM_SOURCE[network], network)} (${expectedSourceId}) for ${network}.`,
        );
      }

      const body = proof.response.responseBody as {
        events?: EvmEvent[];
        status?: number | string;
      };
      const evmStatus = Number(body.status ?? 0);
      if (evmStatus !== 1) {
        return toolError(
          `The attested transaction did not succeed on-chain (EVM status ${evmStatus}).`,
        );
      }
      const binding = bindTransfer(body.events ?? [], criteria);

      const fdc_attestation_ref: FdcAttestationRef = {
        network,
        voting_round_id: args.voting_round_id,
        request_bytes: args.abi_encoded_request as Hex,
        merkle_root: proof.merkle_root,
      };

      if (!binding.matched) {
        return toolError(
          `FDC attestation is VALID (Merkle-verified against the Relay root), but it does NOT prove the claimed payment: ${binding.reason}. Do not treat this settlement as verified.`,
        );
      }

      return toolResult({
        settlement_verified: true,
        verification:
          "Enshrined FDC EVMTransaction attestation, Merkle-verified locally against the on-chain Relay root, and bound to the payment: the attested tx contains an ERC-20 Transfer of the asset to the payee for at least `amount`.",
        settlement_tx_hash,
        network,
        asset: criteria.asset,
        payee: criteria.payee,
        amount: criteria.amount,
        observed_value: binding.observed_value,
        payer_matched: criteria.payer ? true : "not_checked",
        transfer_from: binding.from,
        fdc_attestation_ref,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toolError(
        `Failed to verify the FDC settlement attestation for round ${args.voting_round_id} on ${network}: ${message}`,
      );
    }
  }

  // ---- Phase 1: prepare the attestation request (free; no chain write) ----
  try {
    const requestBody = {
      transactionHash: settlement_tx_hash,
      requiredConfirmations: args.required_confirmations ?? 1,
      provideInput: false,
      listEvents: true, // events are what we bind against
      logIndices: [] as number[],
    };
    const prepared = await prepareAttestationRequest(
      "EVMTransaction",
      EVM_SOURCE[network],
      requestBody,
      network,
    );
    if (prepared.status !== "VALID" || !prepared.abiEncodedRequest) {
      return toolError(
        `Verifier could not prepare an EVMTransaction attestation for ${settlement_tx_hash} on ${network} (status: ${prepared.status}). The tx may not be confirmed yet.`,
      );
    }
    return toolResult({
      phase: "prepared",
      note: "Submit this attestation request to FdcHub with your own key (e.g. via fdc_request_attestation, attestation_type=EVMTransaction), wait for the voting round to finalize (~90–180s), then call this tool again with voting_round_id + abi_encoded_request to verify and bind. This tool never submits on-chain itself.",
      settlement_tx_hash,
      network,
      source_chain: EVM_SOURCE[network],
      abi_encoded_request: prepared.abiEncodedRequest,
      bind_to: {
        asset: criteria.asset,
        payee: criteria.payee,
        amount: criteria.amount,
        ...(criteria.payer ? { payer: criteria.payer } : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(
      `Failed to prepare an FDC EVMTransaction attestation for ${settlement_tx_hash} on ${network}: ${message}`,
    );
  }
}
