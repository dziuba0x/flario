// ZK-ready settlement receipt (organ 3 of the agent settlement layer).
//
// Every settled x402 payment emits a Receipt structured for future
// consumption in zero-knowledge circuits (agent passport / reputation — NOT
// built here). Design constraints (handoff Principle 3):
//   - fixed schema, versioned and self-describing;
//   - the payer appears ONLY as a cryptographic commitment, never in plaintext;
//   - deterministic serialization + a hash suitable for on-chain anchoring;
//   - no personal data in plaintext.
//
// Two hash worlds, deliberately separated and self-described:
//   - payer_commitment: Poseidon over the BN254 scalar field — the ZK-native
//     hash for the Circom/snarkjs (BabyJubjub + Poseidon) stack the passport
//     project will use. Cheap inside a circuit.
//   - receipt_hash: keccak256 over a deterministic serialization — the
//     Solidity-native hash for on-chain anchoring and tamper-evidence.
//
// HONEST PRIVACY CAVEAT: under the current EIP-3009 settlement the payer
// address is already public on-chain (it is in the transfer calldata/event),
// so payer_commitment provides real hiding only once settlement runs through a
// privacy-preserving path (future work). Emitting it now is structural: it
// costs ~nothing and prevents rewriting the foundation later. `blinded`
// records truthfully whether a payer-supplied secret salt was used.
import { keccak256, toBytes, getAddress, type Hex } from "viem";
import { poseidon2 } from "poseidon-lite";
import type { NetworkType } from "../utils/rpc.js";

export const RECEIPT_SCHEMA_VERSION = "flario-receipt/2" as const;
export const COMMITMENT_SCHEME = "poseidon-bn254/v1" as const;
export const HASH_SCHEME = "keccak256/v1" as const;

// BN254 scalar field modulus (the field poseidon-lite operates over). All
// Poseidon inputs are reduced into [0, P) so the commitment is well-defined
// regardless of the library's internal handling of out-of-range inputs.
export const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Reference to the FDC Payment attestation that proves this settlement. */
export interface FdcAttestationRef {
  network: NetworkType;
  voting_round_id: number;
  request_bytes: Hex;
  merkle_root: Hex;
}

/**
 * DELICTI mandate reference: the on-chain commitment the payer's agent claims to
 * act under (mandate-before-act). Binding it into the receipt makes the receipt a
 * "witness 1" leaf a third party can check against MandateRegistry + FDC.
 * See https://github.com/dziuba0x/delicti
 */
export interface MandateRef {
  chain_id: number;
  registry: `0x${string}`;
  /** Decimal string mandate id in the registry. */
  mandate_id: string;
}

export interface Receipt {
  schema_version: typeof RECEIPT_SCHEMA_VERSION;
  commitment_scheme: typeof COMMITMENT_SCHEME;
  hash_scheme: typeof HASH_SCHEME;
  /** Poseidon([payerField, saltField]) as 32-byte hex. Never the raw address. */
  payer_commitment: Hex;
  /** True iff the payer supplied a secret salt (real hiding); see caveat above. */
  blinded: boolean;
  payee_address: `0x${string}`;
  /** Integer amount in the token's base units, as a decimal string. */
  amount: string;
  /** Payment token address. */
  asset: `0x${string}`;
  network: NetworkType;
  /** Unix seconds. */
  timestamp: number;
  /** Identifier of the paid tool. */
  tool_id: string;
  settlement_tx_hash: Hex;
  /** FDC Payment attestation proving the settlement; null until the FDC path runs. */
  fdc_attestation_ref: FdcAttestationRef | null;
  /** DELICTI mandate the payer acted under; null when the payer supplied none. */
  mandate_ref: MandateRef | null;
  /** keccak256 of the deterministic serialization of all fields above. */
  receipt_hash: Hex;
}

function toField(value: bigint | string): bigint {
  const n = typeof value === "bigint" ? value : BigInt(value);
  const r = n % BN254_FIELD_MODULUS;
  return r < 0n ? r + BN254_FIELD_MODULUS : r;
}

function fieldToHex32(x: bigint): Hex {
  return `0x${x.toString(16).padStart(64, "0")}`;
}

/**
 * payer_commitment = Poseidon([addr, salt]) over BN254.
 * - addr: the payer address as a field element.
 * - salt: a payer-chosen secret (hex/bigint) when hiding is wanted; absent
 *   salt yields an unblinded, publicly recomputable commitment (honest: no
 *   hiding, but a well-formed, ZK-consumable value).
 * The salt is NOT part of the payment's EIP-712 signature; it is payer-chosen
 * receipt metadata and cannot affect fund movement.
 */
export function computePayerCommitment(
  payer: `0x${string}`,
  salt?: string,
): { commitment: Hex; blinded: boolean } {
  const addrField = toField(BigInt(payer));
  const saltField = salt !== undefined ? toField(salt) : 0n;
  const digest = poseidon2([addrField, saltField]);
  return { commitment: fieldToHex32(digest), blinded: salt !== undefined };
}

/**
 * Deterministic serialization of the receipt for hashing/anchoring. Fixed
 * field order (JS preserves string-key insertion order), addresses checksummed,
 * hashes lowercased, receipt_hash excluded. Any consumer that recomputes this
 * exact string and keccak256s it must obtain receipt_hash.
 */
export function canonicalize(receipt: Omit<Receipt, "receipt_hash">): string {
  const ordered = {
    schema_version: receipt.schema_version,
    commitment_scheme: receipt.commitment_scheme,
    hash_scheme: receipt.hash_scheme,
    payer_commitment: receipt.payer_commitment.toLowerCase(),
    blinded: receipt.blinded,
    payee_address: getAddress(receipt.payee_address),
    amount: receipt.amount,
    asset: getAddress(receipt.asset),
    network: receipt.network,
    timestamp: receipt.timestamp,
    tool_id: receipt.tool_id,
    settlement_tx_hash: receipt.settlement_tx_hash.toLowerCase(),
    fdc_attestation_ref: receipt.fdc_attestation_ref
      ? {
          network: receipt.fdc_attestation_ref.network,
          voting_round_id: receipt.fdc_attestation_ref.voting_round_id,
          request_bytes: receipt.fdc_attestation_ref.request_bytes.toLowerCase(),
          merkle_root: receipt.fdc_attestation_ref.merkle_root.toLowerCase(),
        }
      : null,
    mandate_ref: receipt.mandate_ref
      ? {
          chain_id: receipt.mandate_ref.chain_id,
          registry: getAddress(receipt.mandate_ref.registry),
          mandate_id: receipt.mandate_ref.mandate_id,
        }
      : null,
  };
  return JSON.stringify(ordered);
}

export interface BuildReceiptParams {
  payer: `0x${string}`;
  payee: `0x${string}`;
  amount: string;
  asset: `0x${string}`;
  network: NetworkType;
  toolId: string;
  settlementTxHash: Hex;
  timestamp?: number;
  commitmentSalt?: string;
  fdcAttestationRef?: FdcAttestationRef | null;
  mandateRef?: MandateRef | null;
}

export function buildReceipt(params: BuildReceiptParams): Receipt {
  const { commitment, blinded } = computePayerCommitment(
    params.payer,
    params.commitmentSalt,
  );
  const base: Omit<Receipt, "receipt_hash"> = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    commitment_scheme: COMMITMENT_SCHEME,
    hash_scheme: HASH_SCHEME,
    payer_commitment: commitment,
    blinded,
    payee_address: getAddress(params.payee),
    amount: params.amount,
    asset: getAddress(params.asset),
    network: params.network,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    tool_id: params.toolId,
    settlement_tx_hash: params.settlementTxHash,
    fdc_attestation_ref: params.fdcAttestationRef ?? null,
    mandate_ref: params.mandateRef ?? null,
  };
  const receipt_hash = keccak256(toBytes(canonicalize(base)));
  return { ...base, receipt_hash };
}

/** Recompute and check a receipt's hash (tamper-evidence for any holder). */
export function verifyReceiptHash(receipt: Receipt): boolean {
  const { receipt_hash, ...rest } = receipt;
  return keccak256(toBytes(canonicalize(rest))) === receipt_hash;
}

/**
 * Upgrade a receipt to its FDC-verified form: attach the enshrined-FDC
 * attestation reference and recompute receipt_hash. The result is a distinct,
 * trust-minimized receipt (different hash) — the settlement is now provable
 * without trusting the facilitator. Every other field is preserved.
 */
export function attachFdcRef(receipt: Receipt, ref: FdcAttestationRef): Receipt {
  const { receipt_hash: _old, ...rest } = receipt;
  const base: Omit<Receipt, "receipt_hash"> = { ...rest, fdc_attestation_ref: ref };
  return { ...base, receipt_hash: keccak256(toBytes(canonicalize(base))) };
}
