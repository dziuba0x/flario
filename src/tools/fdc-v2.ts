// FDC v2 tools: fdc_request_attestation, fdc_get_attestation_proof
//
// Workflow per https://dev.flare.network/fdc/guides/fdc-by-hand:
//   verifier prepareRequest → FdcRequestFeeConfigurations.getRequestFee →
//   FdcHub.requestAttestation (payable) → wait for round finalization →
//   DA layer proof-by-request-round → Merkle-verify against the Relay root.
import { z } from "zod";
import { getAddress, type Hex } from "viem";
import { getClient, getSigner, type NetworkType } from "../utils/rpc.js";
import { getContractAddress, getInterfaceAbi } from "../utils/contracts.js";
import {
  ATTESTATION_TYPES,
  VERIFIABLE_TYPES,
  SOURCE_CHAINS,
  TYPE_SOURCES,
  FDC_PROTOCOL_ID,
  type AttestationType,
  type VerifiableType,
  type SourceChain,
  prepareAttestationRequest,
  fetchProofFromDaLayer,
  responseAbiParameter,
  computeResponseLeaf,
  foldMerkleProof,
  daLayerBase,
} from "../utils/fdc.js";
import { isSubmitAllowed, SUBMIT_BLOCKED_REASON } from "../utils/runtime.js";

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

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

export const fdcRequestAttestationInput = {
  attestation_type: z.enum(ATTESTATION_TYPES),
  source_chain: z.enum(SOURCE_CHAINS),
  request_body: z.record(z.string(), z.unknown()),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
};

export async function fdcRequestAttestation(args: {
  attestation_type: AttestationType;
  source_chain: SourceChain;
  request_body: Record<string, unknown>;
  network: NetworkType;
}) {
  const { attestation_type, source_chain, request_body, network } = args;
  try {
    if (!TYPE_SOURCES[attestation_type].includes(source_chain)) {
      return toolError(
        `Source chain "${source_chain}" is not valid for ${attestation_type}. Valid sources: ${TYPE_SOURCES[attestation_type].join(", ")}.`,
      );
    }

    const prepared = await prepareAttestationRequest(
      attestation_type,
      source_chain,
      request_body,
      network,
    );
    if (prepared.status !== "VALID" || !prepared.abiEncodedRequest) {
      return toolError(
        `Verifier rejected the request (status: ${prepared.status}). Check the request_body fields for ${attestation_type} at https://dev.flare.network/fdc/attestation-types.`,
      );
    }
    const abiEncodedRequest = prepared.abiEncodedRequest;

    const client = getClient(network);
    const feeConfigAddress = getAddress(
      await getContractAddress("FdcRequestFeeConfigurations", network),
    );
    const fee = (await client.readContract({
      address: feeConfigAddress,
      abi: getInterfaceAbi("IFdcRequestFeeConfigurations", network),
      functionName: "getRequestFee",
      args: [abiEncodedRequest],
    })) as bigint;

    const fdcHubAddress = getAddress(await getContractAddress("FdcHub", network));

    const signer = getSigner(network);
    if (!signer || !isSubmitAllowed()) {
      // Read-only mode: return everything needed to submit the request with
      // the user's own signer. No key, no transaction.
      return toolResult({
        mode: "prepared_only",
        note: !signer
          ? "No FLARE_PRIVATE_KEY configured, so the request was prepared but not submitted. Submit abi_encoded_request to FdcHub.requestAttestation with value = request_fee_wei, or set FLARE_PRIVATE_KEY to let this tool submit it."
          : SUBMIT_BLOCKED_REASON,
        attestation_type,
        source_chain,
        network,
        abi_encoded_request: abiEncodedRequest,
        request_fee_wei: fee.toString(),
        fdc_hub_address: fdcHubAddress,
      });
    }

    const fdcHubAbi = getInterfaceAbi("IFdcHub", network);
    const { request } = await client.simulateContract({
      address: fdcHubAddress,
      abi: fdcHubAbi,
      functionName: "requestAttestation",
      args: [abiEncodedRequest],
      value: fee,
      account: signer.account,
    });
    const txHash = await signer.wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });

    // Voting round of the request, from the Relay contract (no hardcoded
    // epoch constants). Source: https://dev.flare.network/network/fsp
    const relayAddress = getAddress(await getContractAddress("Relay", network));
    const votingRoundId = (await client.readContract({
      address: relayAddress,
      abi: getInterfaceAbi("IRelay", network),
      functionName: "getVotingRoundId",
      args: [block.timestamp],
    })) as bigint;

    return toolResult({
      mode: "submitted",
      attestation_type,
      source_chain,
      network,
      tx_hash: txHash,
      tx_status: receipt.status,
      block_number: receipt.blockNumber.toString(),
      voting_round_id: Number(votingRoundId),
      request_fee_wei: fee.toString(),
      abi_encoded_request: abiEncodedRequest,
      next_step:
        "Wait for the voting round to finalize (~90-180s), then call fdc_get_attestation_proof with voting_round_id and abi_encoded_request.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(
      `Failed to request ${attestation_type} attestation on ${network}: ${message}`,
    );
  }
}

export const fdcGetAttestationProofInput = {
  voting_round_id: z.number().int().nonnegative(),
  abi_encoded_request: z.string().regex(/^0x[0-9a-fA-F]+$/),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
};

export interface VerifiedProof {
  verified: true;
  verification: string;
  network: NetworkType;
  voting_round_id: number;
  attestation_type: string;
  merkle_root: Hex;
  response: Awaited<ReturnType<typeof fetchProofFromDaLayer>>["response"];
  merkle_proof: Hex[];
  relay_address: `0x${string}`;
}

/**
 * Core of fdc_get_attestation_proof, reused by fdc_bulk_proof_bundle:
 * fetch a proof from the DA layer and verify it locally against the Relay
 * root read on-chain. Throws with a precise reason on any failure.
 */
export async function retrieveAndVerifyProof(
  voting_round_id: number,
  abi_encoded_request: string,
  network: NetworkType,
): Promise<VerifiedProof> {
  const client = getClient(network);
  const relayAddress = getAddress(await getContractAddress("Relay", network));
  const relayAbi = getInterfaceAbi("IRelay", network);

  const onChainRoot = (await client.readContract({
    address: relayAddress,
    abi: relayAbi,
    functionName: "merkleRoots",
    args: [BigInt(FDC_PROTOCOL_ID), BigInt(voting_round_id)],
  })) as Hex;
  if (onChainRoot.toLowerCase() === ZERO_BYTES32) {
    throw new Error(
      `Voting round ${voting_round_id} has no FDC Merkle root on the ${network} Relay yet. The round may not be finalized — try again in ~90s.`,
    );
  }

  const daProof = await fetchProofFromDaLayer(
    voting_round_id,
    abi_encoded_request as Hex,
    network,
  );

  // Decode the attestation type from the response to pick the right struct.
  const typeHex = daProof.response.attestationType;
  const typeName = Buffer.from(typeHex.slice(2), "hex")
    .toString("utf8")
    .replace(/\0+$/, "");
  if (!(VERIFIABLE_TYPES as readonly string[]).includes(typeName)) {
    throw new Error(
      `DA layer returned attestation type "${typeName}", which this tool cannot verify locally (supported: ${VERIFIABLE_TYPES.join(", ")}).`,
    );
  }

  // Local verification: leaf = keccak256(abi.encode(response)), folded
  // through the sorted-pair Merkle proof, must equal the Relay root.
  // This removes trust in the DA layer response.
  const responseAbi = responseAbiParameter(
    typeName as VerifiableType,
    network,
  );
  const leaf = computeResponseLeaf(responseAbi, daProof.response);
  const computedRoot = foldMerkleProof(leaf, daProof.proof);

  if (computedRoot.toLowerCase() !== onChainRoot.toLowerCase()) {
    throw new Error(
      `Merkle verification FAILED for round ${voting_round_id} on ${network}: computed root ${computedRoot} does not match on-chain root ${onChainRoot}. Do not trust this DA response (${daLayerBase(network)}).`,
    );
  }

  return {
    verified: true,
    verification:
      "Local: keccak256(abi.encode(response)) folded through merkle_proof equals the Relay merkleRoots(200, round) read on-chain.",
    network,
    voting_round_id,
    attestation_type: typeName,
    merkle_root: onChainRoot,
    response: daProof.response,
    merkle_proof: daProof.proof,
    relay_address: relayAddress,
  };
}

export async function fdcGetAttestationProof(args: {
  voting_round_id: number;
  abi_encoded_request: string;
  network: NetworkType;
}) {
  const { voting_round_id, abi_encoded_request, network } = args;
  try {
    return toolResult(
      await retrieveAndVerifyProof(voting_round_id, abi_encoded_request, network),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(
      `Failed to fetch/verify FDC proof for round ${voting_round_id} on ${network}: ${message}`,
    );
  }
}
