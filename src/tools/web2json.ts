// Web2Json tools: fdc_web2json_request, fdc_verify_web2json
//
// Web2Json is the FDC attestation type that fetches JSON over HTTP, runs a jq
// filter over it, and returns ABI-encoded data. In plain terms: it turns any
// public web API into a fact a smart contract can verify. That is the piece
// that lets an agent bring the outside world onto Flare with a proof attached.
//
// Source: https://dev.flare.network/fdc/attestation-types/web2-json
//         https://dev.flare.network/fdc/reference/IWeb2Json
//
// THE SECURITY POINT, straight from Flare's own guide
// (https://dev.flare.network/fdc/guides/url-parsing-security):
//
//   "A valid FDC proof only guarantees the data came from the URL in the
//    proof. It does not guarantee the URL is trustworthy."
//
// So a Merkle-valid proof is only half the job. An attacker can stand up their
// own endpoint, get a perfectly valid attestation for it, and hand you that
// proof. `fdc_verify_web2json` therefore does what this server does everywhere
// else: it verifies AND binds. You declare the source you expected (host
// allowlist, path prefix, HTTPS, method) and the proof is only accepted if the
// attested request actually matches it.
//
// Binding here uses the WHATWG URL parser rather than the string slicing the
// Solidity guide has to fall back on, which closes three bypasses that naive
// prefix matching misses: userinfo ("https://api.trusted.com@evil.com/"),
// mixed case, and punycode/IDN homographs.
import { z } from "zod";
import { decodeAbiParameters, getAddress, type AbiParameter, type Hex } from "viem";
import { getClient, getSigner, type NetworkType } from "../utils/rpc.js";
import { getContractAddress, getInterfaceAbi } from "../utils/contracts.js";
import {
  prepareWeb2JsonRequest,
  WEB2JSON_TYPE,
  WEB2JSON_SOURCE_ID,
  type Web2JsonRequestBody,
} from "../utils/fdc.js";
import { retrieveAndVerifyProof } from "./fdc-v2.js";
import { isSubmitAllowed, SUBMIT_BLOCKED_REASON } from "../utils/runtime.js";

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

// --- source binding (the security core; pure and unit-tested) ---------------

export interface SourceExpectation {
  /** Hostnames the data may come from, compared exactly, case-insensitively. */
  hosts: string[];
  /** Required path prefix, matched with startsWith to stop prefix injection. */
  path_prefix?: string;
  /** Require https. Default true; only turn this off for local testing. */
  require_https?: boolean;
  /** Require a specific HTTP method. */
  http_method?: string;
}

export interface BindingResult {
  bound: boolean;
  reason?: string;
  parsed?: {
    protocol: string;
    host: string;
    port: string;
    path: string;
  };
}

/**
 * Check that an attested Web2Json request really came from the source the
 * caller expected. Returns a reason instead of throwing so callers can report
 * precisely why a cryptographically valid proof was still rejected.
 */
export function bindWeb2JsonSource(
  requestUrl: string,
  httpMethod: string,
  expect: SourceExpectation,
): BindingResult {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return { bound: false, reason: `the attested URL is not parseable: ${requestUrl}` };
  }

  // WHATWG parsing already lowercases protocol and hostname, resolves
  // userinfo away from the host, and converts IDN to punycode.
  const info = {
    protocol: parsed.protocol.replace(":", ""),
    host: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname,
  };

  const requireHttps = expect.require_https ?? true;
  if (requireHttps && parsed.protocol !== "https:") {
    return {
      bound: false,
      reason: `expected https but the attested URL uses "${info.protocol}", so the fetch could have been intercepted`,
      parsed: info,
    };
  }

  if (!expect.hosts || expect.hosts.length === 0) {
    return { bound: false, reason: "no expected hosts were given, so the source cannot be bound", parsed: info };
  }
  const allowed = expect.hosts.map((h) => h.trim().toLowerCase());
  if (!allowed.includes(info.host)) {
    return {
      bound: false,
      reason: `attested host "${info.host}" is not in the expected list (${allowed.join(", ")})`,
      parsed: info,
    };
  }

  if (expect.path_prefix !== undefined && !info.path.startsWith(expect.path_prefix)) {
    return {
      bound: false,
      reason: `attested path "${info.path}" does not start with the expected prefix "${expect.path_prefix}"`,
      parsed: info,
    };
  }

  if (
    expect.http_method !== undefined &&
    httpMethod.toUpperCase() !== expect.http_method.toUpperCase()
  ) {
    return {
      bound: false,
      reason: `attested HTTP method "${httpMethod}" does not match the expected "${expect.http_method}"`,
      parsed: info,
    };
  }

  return { bound: true, parsed: info };
}

/** Decode the attested payload using the abiSignature carried in the request. */
export function decodeWeb2JsonPayload(
  abiSignature: string,
  abiEncodedData: Hex,
): unknown {
  let param: AbiParameter;
  try {
    param = JSON.parse(abiSignature) as AbiParameter;
  } catch {
    throw new Error("the abiSignature in the attested request is not valid JSON");
  }
  const [decoded] = decodeAbiParameters([param], abiEncodedData);
  return decoded;
}

// --- fdc_web2json_request ---------------------------------------------------

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const fdcWeb2JsonRequestInput = {
  url: z.string().url(),
  post_process_jq: z
    .string()
    .describe('jq filter applied to the JSON response, e.g. "{price: .price|tonumber}"'),
  abi_signature: z
    .string()
    .describe(
      'JSON ABI tuple describing the decoded struct, e.g. {"components":[{"internalType":"uint256","name":"price","type":"uint256"}],"name":"dto","type":"tuple"}',
    ),
  http_method: z.enum(HTTP_METHODS).default("GET"),
  headers: z.string().default("{}"),
  query_params: z.string().default("{}"),
  body: z.string().default("{}"),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
};

export async function fdcWeb2JsonRequest(args: {
  url: string;
  post_process_jq: string;
  abi_signature: string;
  http_method?: (typeof HTTP_METHODS)[number];
  headers?: string;
  query_params?: string;
  body?: string;
  network: NetworkType;
}) {
  const { url, network } = args;
  try {
    const requestBody: Web2JsonRequestBody = {
      url,
      httpMethod: args.http_method ?? "GET",
      headers: args.headers ?? "{}",
      queryParams: args.query_params ?? "{}",
      body: args.body ?? "{}",
      postProcessJq: args.post_process_jq,
      abiSignature: args.abi_signature,
    };

    const prepared = await prepareWeb2JsonRequest(requestBody, network);
    if (prepared.status !== "VALID" || !prepared.abiEncodedRequest) {
      return toolError(
        `The verifier rejected this Web2Json request (status: ${prepared.status}). Check that the URL responds with JSON, that the jq filter matches its shape, and that abi_signature is a valid ABI tuple. Spec: https://dev.flare.network/fdc/attestation-types/web2-json`,
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
    const submitAllowed = isSubmitAllowed();

    if (!signer || !submitAllowed) {
      return toolResult({
        mode: "prepared_only",
        note: !signer
          ? "No FLARE_PRIVATE_KEY is set, so the request was prepared but not submitted. Send abi_encoded_request to FdcHub.requestAttestation with value = request_fee_wei using your own signer."
          : SUBMIT_BLOCKED_REASON,
        attestation_type: WEB2JSON_TYPE,
        source_id: WEB2JSON_SOURCE_ID,
        network,
        url,
        abi_encoded_request: abiEncodedRequest,
        request_fee_wei: fee.toString(),
        fdc_hub_address: fdcHubAddress,
        next_step:
          "After submitting, wait for the voting round to finalize (~90 to 180 s), then call fdc_verify_web2json with voting_round_id, abi_encoded_request and the source you expect.",
      });
    }

    const { request } = await client.simulateContract({
      address: fdcHubAddress,
      abi: getInterfaceAbi("IFdcHub", network),
      functionName: "requestAttestation",
      args: [abiEncodedRequest],
      value: fee,
      account: signer.account,
    });
    const txHash = await signer.wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });

    const relayAddress = getAddress(await getContractAddress("Relay", network));
    const votingRoundId = (await client.readContract({
      address: relayAddress,
      abi: getInterfaceAbi("IRelay", network),
      functionName: "getVotingRoundId",
      args: [block.timestamp],
    })) as bigint;

    return toolResult({
      mode: "submitted",
      attestation_type: WEB2JSON_TYPE,
      network,
      url,
      tx_hash: txHash,
      tx_status: receipt.status,
      voting_round_id: Number(votingRoundId),
      request_fee_wei: fee.toString(),
      abi_encoded_request: abiEncodedRequest,
      next_step:
        "Wait for the voting round to finalize (~90 to 180 s), then call fdc_verify_web2json with this voting_round_id and abi_encoded_request, plus expect_source so the proof is bound to the API you meant to use.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Failed to prepare a Web2Json attestation for ${url} on ${network}: ${message}`);
  }
}

// --- fdc_verify_web2json ----------------------------------------------------

export const fdcVerifyWeb2JsonInput = {
  voting_round_id: z.number().int().nonnegative(),
  abi_encoded_request: z.string().regex(/^0x[0-9a-fA-F]+$/),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
  expect_source: z
    .object({
      hosts: z.array(z.string()).min(1),
      path_prefix: z.string().optional(),
      require_https: z.boolean().optional(),
      http_method: z.string().optional(),
    })
    .optional()
    .describe(
      "The source you expected. Without it the proof is verified but NOT bound, which leaves you open to a valid proof from an attacker's endpoint.",
    ),
};

export async function fdcVerifyWeb2Json(args: {
  voting_round_id: number;
  abi_encoded_request: string;
  network: NetworkType;
  expect_source?: SourceExpectation;
}) {
  const { voting_round_id, abi_encoded_request, network, expect_source } = args;
  try {
    const proof = await retrieveAndVerifyProof(
      voting_round_id,
      abi_encoded_request,
      network,
    );
    if (proof.attestation_type !== WEB2JSON_TYPE) {
      return toolError(
        `This attestation is ${proof.attestation_type}, not Web2Json. Use fdc_get_attestation_proof for other types.`,
      );
    }

    const requestBody = proof.response.requestBody as unknown as Web2JsonRequestBody;
    const responseBody = proof.response.responseBody as { abiEncodedData?: Hex };

    // Bind the cryptographically valid proof to the source the caller meant.
    let binding: BindingResult | null = null;
    if (expect_source) {
      binding = bindWeb2JsonSource(
        requestBody.url,
        requestBody.httpMethod ?? "GET",
        expect_source,
      );
      if (!binding.bound) {
        return toolError(
          `The FDC proof is VALID (Merkle-verified against the on-chain Relay root) but it does NOT come from the source you expected: ${binding.reason}. Treat this data as untrusted. A valid proof only says the data came from the URL inside it, not that the URL is one you trust.`,
        );
      }
    }

    // Decode the attested payload with the abiSignature from the request.
    let decoded: unknown = null;
    let decodeError: string | null = null;
    if (responseBody.abiEncodedData) {
      try {
        decoded = decodeWeb2JsonPayload(
          requestBody.abiSignature,
          responseBody.abiEncodedData,
        );
      } catch (e) {
        decodeError = e instanceof Error ? e.message : String(e);
      }
    }

    return toolResult({
      verified: true,
      source_bound: binding?.bound ?? false,
      verification: binding?.bound
        ? "Two checks passed. The Merkle proof folds to Relay.merkleRoots(200, round) read on-chain, and the attested request matches the source you expected (protocol, host, path, method)."
        : "The Merkle proof folds to Relay.merkleRoots(200, round) read on-chain. WARNING: no expect_source was given, so this proof is NOT bound to a source you trust. Anyone can obtain a valid proof for their own endpoint. Pass expect_source before acting on this data. See https://dev.flare.network/fdc/guides/url-parsing-security",
      network,
      voting_round_id,
      source: {
        url: requestBody.url,
        http_method: requestBody.httpMethod,
        post_process_jq: requestBody.postProcessJq,
        ...(binding?.parsed ? { parsed: binding.parsed } : {}),
      },
      data: decoded,
      ...(decodeError ? { decode_error: decodeError } : {}),
      abi_signature: requestBody.abiSignature,
      abi_encoded_data: responseBody.abiEncodedData ?? null,
      merkle_root: proof.merkle_root,
      merkle_proof: proof.merkle_proof,
      relay_address: proof.relay_address,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(
      `Failed to verify the Web2Json attestation for round ${voting_round_id} on ${network}: ${message}`,
    );
  }
}
