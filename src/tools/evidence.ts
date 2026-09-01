// Evidence bundles: proof-carrying facts an agent can hand to someone else.
//
// The rest of Flario verifies a fact at the moment you ask for it, and then the
// verification evaporates — it lives on as a sentence in a tool response that
// nobody can re-check later. That is the gap this module closes.
//
// An evidence bundle collects several already-verifiable facts (FTSO Scaling
// anchor feeds, FDC attestations including Web2Json) together with the Merkle
// proofs that back them, so a *recipient* can establish that each one is true
// without trusting the agent that produced it, this server, the DA layer, or
// anyone's API. All they need is an RPC endpoint.
//
// What this is NOT
// ----------------
// `bundle_hash` is tamper-EVIDENCE, not a signature. It detects accidental
// corruption and casual edits. Someone who edits a bundle on purpose can
// recompute it, and nothing here stops them. The real guarantee is per-fact:
// change an attested value and its Merkle fold stops matching the on-chain
// root, which `evidence_verify` catches regardless of what the hash says.
//
// A bundle also proves nothing about *why* an agent acted, or that these were
// the only facts it saw. It proves that these specific facts were true, and in
// which voting round. That is a narrower claim than "audit trail", and stating
// it narrowly is the point.
import { z } from "zod";
import { keccak256, toHex, getAddress, type Hex } from "viem";
import { getClient, type NetworkType } from "../utils/rpc.js";
import { getContractAddress, getInterfaceAbi } from "../utils/contracts.js";
import {
  FDC_PROTOCOL_ID,
  VERIFIABLE_TYPES,
  type VerifiableType,
  fetchProofFromDaLayer,
  responseAbiParameter,
  computeResponseLeaf,
  foldMerkleProof,
  encodeAttestationName,
  type DaProofResponse,
} from "../utils/fdc.js";
import {
  FTSO_SCALING_PROTOCOL_ID,
  resolveAnchorFeedId,
  fetchAnchorFeeds,
  latestVotingRound,
  anchorFeedLeaf,
  anchorFeedPrice,
  type AnchorFeedBody,
} from "../utils/ftso-da.js";
import { bindWeb2JsonSource, type SourceExpectation } from "./web2json.js";

export const EVIDENCE_SCHEMA = "flario-evidence/1" as const;
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

type FtsoFact = {
  kind: "ftso_anchor";
  protocol_id: typeof FTSO_SCALING_PROTOCOL_ID;
  voting_round_id: number;
  feed_id: Hex;
  feed_name?: string;
  body: AnchorFeedBody;
  proof: Hex[];
  reads: string;
};

type FdcFact = {
  kind: "fdc_attestation";
  protocol_id: typeof FDC_PROTOCOL_ID;
  attestation_type: VerifiableType;
  voting_round_id: number;
  abi_encoded_request: Hex;
  response: DaProofResponse["response"];
  proof: Hex[];
  expect_source?: SourceExpectation;
  source_bound?: boolean;
  reads: string;
};

type Fact = FtsoFact | FdcFact;

export interface EvidenceBundle {
  schema: typeof EVIDENCE_SCHEMA;
  claim: string | null;
  network: NetworkType;
  chain_id: number;
  relay_address: Hex;
  created_at: number;
  facts: Fact[];
  verify_with: string;
  bundle_hash: Hex;
}

/** Deterministic serialization: keys sorted at every level, no whitespace. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** keccak256 over the canonical form of everything except the hash field. */
export function bundleHash(bundle: Omit<EvidenceBundle, "bundle_hash">): Hex {
  return keccak256(toHex(canonical(bundle)));
}

async function relayAddress(network: NetworkType): Promise<Hex> {
  return getAddress(await getContractAddress("Relay", network)) as Hex;
}

async function merkleRoot(
  network: NetworkType,
  protocolId: number,
  votingRoundId: number,
): Promise<Hex> {
  const relay = await relayAddress(network);
  return (await getClient(network).readContract({
    address: relay,
    abi: getInterfaceAbi("IRelay", network),
    functionName: "merkleRoots",
    args: [BigInt(protocolId), BigInt(votingRoundId)],
  })) as Hex;
}

const CHAIN_IDS: Record<NetworkType, number> = {
  mainnet: 14,
  coston2: 114,
  songbird: 19,
  coston: 16,
};

// ---------------------------------------------------------------------------
// evidence_bundle
// ---------------------------------------------------------------------------

export const evidenceBundleInput = {
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
  claim: z
    .string()
    .max(500)
    .optional()
    .describe("Plain-language statement of what these facts are being used to support."),
  ftso_feeds: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('Feed names or bytes21 ids to anchor, e.g. ["FLR/USD", "BTC/USD"].'),
  voting_round_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Round for the FTSO feeds. Defaults to the latest finalized round."),
  attestations: z
    .array(
      z.object({
        attestation_type: z.enum(VERIFIABLE_TYPES),
        voting_round_id: z.number().int().nonnegative(),
        abi_encoded_request: z.string().startsWith("0x"),
        expect_source: z
          .object({
            hosts: z.array(z.string()).min(1),
            path_prefix: z.string().optional(),
            require_https: z.boolean().optional(),
            method: z.string().optional(),
          })
          .optional()
          .describe("Web2Json only: bind the proof to the source you expected."),
      }),
    )
    .max(10)
    .optional()
    .describe("Finalized FDC attestations to include, by round and request bytes."),
};

/**
 * Build a bundle. Every fact is verified against the on-chain root before it
 * goes in — a fact that does not verify is refused, not flagged, because a
 * bundle whose contents might be false is worse than no bundle.
 */
export async function evidenceBundle(args: {
  network: NetworkType;
  claim?: string;
  ftso_feeds?: string[];
  voting_round_id?: number;
  attestations?: Array<{
    attestation_type: VerifiableType;
    voting_round_id: number;
    abi_encoded_request: string;
    expect_source?: SourceExpectation;
  }>;
}) {
  const { network, claim, ftso_feeds = [], attestations = [] } = args;

  if (ftso_feeds.length === 0 && attestations.length === 0) {
    return err("Nothing to bundle. Give ftso_feeds, attestations, or both.");
  }

  const facts: Fact[] = [];
  const refused: string[] = [];

  try {
    // --- FTSO Scaling anchor feeds (protocol 100) ---
    if (ftso_feeds.length > 0) {
      const round =
        args.voting_round_id ?? (await latestVotingRound(network)) - 1;
      const root = await merkleRoot(network, FTSO_SCALING_PROTOCOL_ID, round);

      if (root.toLowerCase() === ZERO_BYTES32) {
        refused.push(
          `every FTSO feed: round ${round} has no finalized FTSO Scaling root yet`,
        );
      } else {
        // Resolve names to ids first: the DA endpoint takes the id list.
        const resolved = await Promise.all(
          ftso_feeds.map(async (name) => ({
            name,
            id: await resolveAnchorFeedId(name, network),
          })),
        );
        const available = await fetchAnchorFeeds(
          resolved.map((r) => r.id),
          round,
          network,
        );

        for (const { name, id: feedId } of resolved) {
          const feed = available.find(
            (f) => f.body.id.toLowerCase() === feedId.toLowerCase(),
          );
          if (!feed) {
            refused.push(`${name}: not published in round ${round}`);
            continue;
          }
          const folded = foldMerkleProof(anchorFeedLeaf(feed.body), feed.proof);
          if (folded.toLowerCase() !== root.toLowerCase()) {
            refused.push(`${name}: proof does not fold to the on-chain root`);
            continue;
          }
          facts.push({
            kind: "ftso_anchor",
            protocol_id: FTSO_SCALING_PROTOCOL_ID,
            voting_round_id: round,
            feed_id: feed.body.id,
            feed_name: name,
            body: feed.body,
            proof: feed.proof,
            reads: `${name} = ${anchorFeedPrice(feed.body)}`,
          });
        }
      }
    }

    // --- FDC attestations (protocol 200), Web2Json included ---
    for (const a of attestations) {
      const label = `${a.attestation_type} round ${a.voting_round_id}`;
      const root = await merkleRoot(network, FDC_PROTOCOL_ID, a.voting_round_id);
      if (root.toLowerCase() === ZERO_BYTES32) {
        refused.push(`${label}: round is not finalized`);
        continue;
      }

      const da = await fetchProofFromDaLayer(
        a.voting_round_id,
        a.abi_encoded_request as Hex,
        network,
      );
      const leaf = computeResponseLeaf(
        responseAbiParameter(a.attestation_type, network),
        da.response,
      );
      if (foldMerkleProof(leaf, da.proof).toLowerCase() !== root.toLowerCase()) {
        refused.push(`${label}: proof does not fold to the on-chain root`);
        continue;
      }

      // Web2Json without binding is a valid proof for an arbitrary URL. Refuse
      // it rather than shipping something that looks authoritative and is not.
      let sourceBound: boolean | undefined;
      if (a.attestation_type === "Web2Json") {
        if (!a.expect_source) {
          refused.push(
            `${label}: Web2Json needs expect_source, otherwise the proof binds to whatever URL it contains`,
          );
          continue;
        }
        const url = String(da.response.requestBody?.url ?? "");
        const method = String(da.response.requestBody?.httpMethod ?? "GET");
        const binding = bindWeb2JsonSource(url, method, a.expect_source);
        if (!binding.bound) {
          refused.push(`${label}: ${binding.reason}`);
          continue;
        }
        sourceBound = true;
      }

      facts.push({
        kind: "fdc_attestation",
        protocol_id: FDC_PROTOCOL_ID,
        attestation_type: a.attestation_type,
        voting_round_id: a.voting_round_id,
        abi_encoded_request: a.abi_encoded_request as Hex,
        response: da.response,
        proof: da.proof,
        expect_source: a.expect_source,
        source_bound: sourceBound,
        reads: describeAttestation(a.attestation_type, da.response),
      });
    }

    if (facts.length === 0) {
      return err(
        `Nothing could be bundled. ${refused.join("; ") || "No facts resolved."}`,
      );
    }

    const withoutHash: Omit<EvidenceBundle, "bundle_hash"> = {
      schema: EVIDENCE_SCHEMA,
      claim: claim ?? null,
      network,
      chain_id: CHAIN_IDS[network],
      relay_address: await relayAddress(network),
      created_at: Math.floor(Date.now() / 1000),
      facts,
      verify_with:
        "Pass this whole object to evidence_verify, or check it yourself: rebuild each leaf, fold it through its proof, and compare against Relay.merkleRoots(protocol_id, voting_round_id) read from any Flare RPC. No part of this requires trusting Flario.",
    };

    const bundle: EvidenceBundle = {
      ...withoutHash,
      bundle_hash: bundleHash(withoutHash),
    };

    return ok({
      bundle,
      facts_included: facts.length,
      facts_refused: refused.length ? refused : undefined,
      note: "Every fact here was folded against the on-chain root before inclusion. Facts that failed were refused, not flagged.",
    });
  } catch (e) {
    return err(
      `Failed to build the evidence bundle on ${network}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// evidence_verify
// ---------------------------------------------------------------------------

export const evidenceVerifyInput = {
  bundle: z
    .record(z.string(), z.unknown())
    .describe("An evidence bundle produced by evidence_bundle."),
  recheck_source_binding: z
    .boolean()
    .default(true)
    .describe("Re-bind Web2Json facts to the expect_source recorded in the bundle."),
};

/**
 * Verify a bundle from scratch. Reads roots from the chain now; nothing is
 * taken from the bundle on faith, including its own hash.
 */
export async function evidenceVerify(args: {
  bundle: Record<string, unknown>;
  recheck_source_binding?: boolean;
}) {
  const { recheck_source_binding = true } = args;
  const b = args.bundle as unknown as EvidenceBundle;

  if (b?.schema !== EVIDENCE_SCHEMA) {
    return err(
      `Not an evidence bundle: expected schema "${EVIDENCE_SCHEMA}", got "${String(b?.schema)}".`,
    );
  }
  if (!Array.isArray(b.facts) || b.facts.length === 0) {
    return err("The bundle contains no facts.");
  }

  const network = b.network;
  const results: Array<Record<string, unknown>> = [];

  try {
    const { bundle_hash, ...rest } = b;
    const recomputed = bundleHash(rest as Omit<EvidenceBundle, "bundle_hash">);
    const hashIntact = recomputed.toLowerCase() === String(bundle_hash).toLowerCase();

    for (const fact of b.facts) {
      const root = await merkleRoot(network, fact.protocol_id, fact.voting_round_id);
      const rootLive = root.toLowerCase() !== ZERO_BYTES32;

      if (fact.kind === "ftso_anchor") {
        const folded = foldMerkleProof(anchorFeedLeaf(fact.body), fact.proof);
        const verified = rootLive && folded.toLowerCase() === root.toLowerCase();
        results.push({
          kind: fact.kind,
          feed: fact.feed_name ?? fact.feed_id,
          voting_round_id: fact.voting_round_id,
          verified,
          reads: verified ? `${fact.feed_name ?? fact.feed_id} = ${anchorFeedPrice(fact.body)}` : null,
          reason: verified
            ? null
            : rootLive
              ? "the proof does not fold to the on-chain FTSO Scaling root"
              : "no finalized root on chain for this round",
        });
        continue;
      }

      const leaf = computeResponseLeaf(
        responseAbiParameter(fact.attestation_type, network),
        fact.response,
      );
      const folded = foldMerkleProof(leaf, fact.proof);
      let verified = rootLive && folded.toLowerCase() === root.toLowerCase();
      let reason: string | null = verified
        ? null
        : rootLive
          ? "the proof does not fold to the on-chain FDC root"
          : "no finalized root on chain for this round";

      // A cryptographically valid Web2Json proof is meaningless if it attests
      // to somebody else's URL, so binding is re-checked, not assumed.
      let bound: boolean | undefined;
      if (verified && fact.attestation_type === "Web2Json") {
        if (!fact.expect_source) {
          verified = false;
          reason = "Web2Json fact carries no expect_source, so it is not bound to any source";
        } else if (recheck_source_binding) {
          const url = String(fact.response.requestBody?.url ?? "");
          const method = String(fact.response.requestBody?.httpMethod ?? "GET");
          const r = bindWeb2JsonSource(url, method, fact.expect_source);
          bound = r.bound;
          if (!r.bound) {
            verified = false;
            reason = `proof is valid but not bound to the expected source: ${r.reason}`;
          }
        }
      }

      results.push({
        kind: fact.kind,
        attestation_type: fact.attestation_type,
        voting_round_id: fact.voting_round_id,
        verified,
        source_bound: bound,
        reads: verified ? fact.reads : null,
        reason,
      });
    }

    const allVerified = results.every((r) => r.verified === true);

    return ok({
      verified: allVerified,
      facts_checked: results.length,
      facts_failed: results.filter((r) => r.verified !== true).length,
      bundle_hash_intact: hashIntact,
      claim: b.claim,
      network,
      relay_address: await relayAddress(network),
      verification: allVerified
        ? "Every fact was rebuilt from its own body, folded through its Merkle proof, and matched against Relay.merkleRoots(protocol, round) read on-chain just now. This did not rely on the bundle's hash, on Flario, or on any API."
        : "At least one fact failed. See per-fact reasons; do not rely on this bundle.",
      hash_note: hashIntact
        ? "bundle_hash matches, so the bundle is byte-identical to when it was built."
        : "bundle_hash does NOT match — the bundle was edited after it was built. Note that per-fact verification above is what actually matters; an attacker can recompute this hash.",
      facts: results,
    });
  } catch (e) {
    return err(
      `Failed to verify the evidence bundle: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function describeAttestation(
  type: VerifiableType,
  response: DaProofResponse["response"],
): string {
  const rb = response.responseBody ?? {};
  if (type === "Web2Json") {
    return `Web2Json from ${String(response.requestBody?.url ?? "unknown URL")}`;
  }
  if (type === "EVMTransaction") {
    return `EVM transaction ${String(response.requestBody?.transactionHash ?? "?")}`;
  }
  return `${type}: ${JSON.stringify(rb).slice(0, 160)}`;
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function err(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
