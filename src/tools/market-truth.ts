// Proof-of-Market-Truth bundle: a single tamper-evident certificate aggregating
// up to 8 locally Merkle-verified FTSO Scaling anchor feeds.
//
// Each feed is verified locally against the on-chain Relay Merkle root
// (protocol 100) via the shared ftso-da helpers — no trust in the DA API.
// The resulting certificate is bound by a deterministic keccak256 hash over
// its canonical JSON representation so any post-hoc edit to a price, round,
// proof, or claim_note is immediately detected.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { keccak256, toHex, type Hex } from "viem";
import type { NetworkType } from "../utils/rpc.js";
import { FTSO_FEEDS } from "../utils/contracts.js";
import {
  resolveAnchorFeedId,
  fetchAnchorFeeds,
  fetchLatestFinalizedAnchor,
  verifyAnchorFeed,
  anchorFeedPrice,
  type AnchorFeedWithProof,
} from "../utils/ftso-da.js";
import { withX402, x402PaymentInput } from "../x402/paywall.js";

export const MARKET_TRUTH_SCHEMA_VERSION = "flario-market-truth/1" as const;
export const MAX_MARKET_TRUTH_FEEDS = 8;

const VALID_NETWORKS: ReadonlySet<string> = new Set<NetworkType>([
  "mainnet",
  "coston2",
  "songbird",
  "coston",
]);
const BYTES32_HEX_RE = /^0x[0-9a-fA-F]{64}$/;

export interface VerifiedMarketFeed {
  name: string;
  feed_id?: Hex;
  price: number;
  value?: number;
  decimals?: number;
  turnout_bips?: number;
  voting_round_id: number;
  merkle_root: Hex;
  proof: Hex[];
  verified: true;
}

export interface MarketTruthCertificate {
  schema_version: typeof MARKET_TRUTH_SCHEMA_VERSION;
  network: NetworkType;
  created_at: number;
  claim_note?: string;
  feeds: VerifiedMarketFeed[];
  feed_count: number;
  all_verified: boolean;
  certificate_hash: Hex;
}

export interface BuildMarketTruthCertificateParams {
  network: NetworkType;
  feeds: VerifiedMarketFeed[];
  created_at?: number;
  claim_note?: string;
}

export interface CertificateVerificationResult {
  valid: boolean;
  reason?: string;
}

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

/**
 * Deterministic JSON serialization: object keys sorted lexicographically at
 * every nesting level, `undefined` properties omitted, no whitespace.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeJson(v)}`).join(",")}}`;
}

/** keccak256 over the canonical JSON representation of the unsigned certificate. */
export function computeCertificateHash(
  unsigned: Omit<MarketTruthCertificate, "certificate_hash">,
): Hex {
  return keccak256(toHex(canonicalizeJson(unsigned)));
}

/**
 * Assemble a Proof-of-Market-Truth certificate with a deterministic
 * `certificate_hash` covering all fields except `certificate_hash`.
 */
export function buildMarketTruthCertificate(
  params: BuildMarketTruthCertificateParams,
): MarketTruthCertificate {
  const unsigned: Omit<MarketTruthCertificate, "certificate_hash"> = {
    schema_version: MARKET_TRUTH_SCHEMA_VERSION,
    network: params.network,
    created_at: params.created_at ?? Math.floor(Date.now() / 1000),
    ...(params.claim_note !== undefined ? { claim_note: params.claim_note } : {}),
    feeds: params.feeds,
    feed_count: params.feeds.length,
    all_verified:
      params.feeds.length > 0 && params.feeds.every((f) => f.verified === true),
  };

  return {
    ...unsigned,
    certificate_hash: computeCertificateHash(unsigned),
  };
}

/**
 * Offline structural and tamper-evidence verification of a
 * Proof-of-Market-Truth certificate. Detects schema mismatches, missing
 * proofs/feeds, and any modification to prices, rounds, claim_note, or hash.
 */
export function verifyMarketTruthCertificate(
  cert: unknown,
): CertificateVerificationResult {
  if (typeof cert !== "object" || cert === null || Array.isArray(cert)) {
    return { valid: false, reason: "certificate must be a non-null object" };
  }

  const c = cert as Record<string, unknown>;

  if (c.schema_version !== MARKET_TRUTH_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `invalid schema_version: expected "${MARKET_TRUTH_SCHEMA_VERSION}", got "${String(c.schema_version)}"`,
    };
  }

  if (typeof c.network !== "string" || !VALID_NETWORKS.has(c.network)) {
    return {
      valid: false,
      reason: `invalid network: "${String(c.network)}"`,
    };
  }

  if (
    typeof c.created_at !== "number" ||
    !Number.isFinite(c.created_at) ||
    c.created_at < 0
  ) {
    return {
      valid: false,
      reason: "created_at must be a non-negative finite number",
    };
  }

  if (c.claim_note !== undefined && typeof c.claim_note !== "string") {
    return {
      valid: false,
      reason: "claim_note must be a string when present",
    };
  }

  if (!Array.isArray(c.feeds) || c.feeds.length === 0) {
    return {
      valid: false,
      reason: "feeds must be a non-empty array of verified feeds",
    };
  }

  for (let i = 0; i < c.feeds.length; i++) {
    const feed = c.feeds[i];
    if (typeof feed !== "object" || feed === null || Array.isArray(feed)) {
      return { valid: false, reason: `feeds[${i}] must be an object` };
    }
    const f = feed as Record<string, unknown>;
    if (typeof f.name !== "string" || f.name.length === 0) {
      return { valid: false, reason: `feeds[${i}].name must be a non-empty string` };
    }
    if (typeof f.price !== "number" || !Number.isFinite(f.price)) {
      return { valid: false, reason: `feeds[${i}].price must be a finite number` };
    }
    if (
      typeof f.voting_round_id !== "number" ||
      !Number.isInteger(f.voting_round_id) ||
      f.voting_round_id < 0
    ) {
      return {
        valid: false,
        reason: `feeds[${i}].voting_round_id must be a non-negative integer`,
      };
    }
    if (typeof f.merkle_root !== "string" || !BYTES32_HEX_RE.test(f.merkle_root)) {
      return {
        valid: false,
        reason: `feeds[${i}].merkle_root must be a 32-byte hex string`,
      };
    }
    if (
      !Array.isArray(f.proof) ||
      f.proof.length === 0 ||
      !f.proof.every((p) => typeof p === "string" && BYTES32_HEX_RE.test(p))
    ) {
      return {
        valid: false,
        reason: `feeds[${i}].proof must be a non-empty array of 32-byte hex hashes`,
      };
    }
    if (f.verified !== true) {
      return {
        valid: false,
        reason: `feeds[${i}].verified must be true`,
      };
    }
  }

  if (c.feed_count !== c.feeds.length) {
    return {
      valid: false,
      reason: `feed_count mismatch: expected ${c.feeds.length}, got ${String(c.feed_count)}`,
    };
  }

  if (c.all_verified !== true) {
    return {
      valid: false,
      reason: "all_verified must be true",
    };
  }

  if (
    typeof c.certificate_hash !== "string" ||
    !BYTES32_HEX_RE.test(c.certificate_hash)
  ) {
    return {
      valid: false,
      reason: "certificate_hash must be a 32-byte hex string",
    };
  }

  const { certificate_hash, ...unsigned } = c;
  const expectedHash = computeCertificateHash(
    unsigned as unknown as Omit<MarketTruthCertificate, "certificate_hash">,
  );

  if (expectedHash.toLowerCase() !== certificate_hash.toLowerCase()) {
    return {
      valid: false,
      reason: "certificate_hash mismatch: certificate content has been altered",
    };
  }

  return { valid: true };
}

export const marketTruthBundleInput = {
  feeds: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_MARKET_TRUTH_FEEDS)
    .describe(
      '1 to 8 FTSO feed names or bytes21 ids, e.g. ["FLR/USD", "XRP/USD", "BTC/USD"].',
    ),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
  voting_round_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Voting round id to anchor. Defaults to the latest finalized FTSO Scaling round.",
    ),
  claim_note: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional plain-language note or claim bound into the certificate hash.",
    ),
  ...x402PaymentInput,
};

export async function marketTruthCore(args: {
  feeds: string[];
  network: NetworkType;
  voting_round_id?: number;
  claim_note?: string;
}) {
  const { feeds, network, voting_round_id, claim_note } = args;

  if (!Array.isArray(feeds) || feeds.length === 0) {
    return toolError("At least one FTSO feed is required.");
  }
  if (feeds.length > MAX_MARKET_TRUTH_FEEDS) {
    return toolError(
      `At most ${MAX_MARKET_TRUTH_FEEDS} feeds can be bundled per certificate (received ${feeds.length}).`,
    );
  }

  try {
    // 1. Resolve all requested feed names/ids in parallel.
    const resolved = await Promise.all(
      feeds.map(async (input) => {
        const id = await resolveAnchorFeedId(input, network);
        const known = FTSO_FEEDS.find((f) => f.id.toLowerCase() === id);
        return {
          input,
          id,
          name: known?.name ?? input,
        };
      }),
    );

    const uniqueIds = Array.from(new Set(resolved.map((r) => r.id)));

    // 2. Fetch anchor feeds with proofs from the DA layer.
    let round: number;
    let available: AnchorFeedWithProof[];
    if (voting_round_id !== undefined) {
      round = voting_round_id;
      available = await fetchAnchorFeeds(uniqueIds, round, network);
    } else {
      const latest = await fetchLatestFinalizedAnchor(uniqueIds, network);
      round = latest.votingRoundId;
      available = latest.feeds;
    }

    const byId = new Map(
      available.map((item) => [item.body.id.toLowerCase(), item]),
    );

    // 3. Verify every requested feed locally against Relay.merkleRoots(100, round).
    const failures: string[] = [];
    const verifiedFeeds = (
      await Promise.all(
        resolved.map(async ({ name, id }): Promise<VerifiedMarketFeed | null> => {
          const anchor = byId.get(id.toLowerCase());
          if (!anchor) {
            failures.push(`${name} (${id}): not published in voting round ${round}`);
            return null;
          }
          const { verified, merkleRoot } = await verifyAnchorFeed(anchor, network);
          if (!verified) {
            failures.push(
              `${name} (${id}): Merkle verification failed against on-chain root ${merkleRoot}`,
            );
            return null;
          }
          return {
            name,
            feed_id: anchor.body.id,
            price: anchorFeedPrice(anchor.body),
            value: anchor.body.value,
            decimals: anchor.body.decimals,
            turnout_bips: anchor.body.turnoutBIPS,
            voting_round_id: anchor.body.votingRoundId,
            merkle_root: merkleRoot,
            proof: anchor.proof,
            verified: true,
          };
        }),
      )
    ).filter((f): f is VerifiedMarketFeed => f !== null);

    if (failures.length > 0) {
      return toolError(
        `Market truth bundle refused on ${network} (round ${round}): ${failures.join("; ")}`,
      );
    }

    const certificate = buildMarketTruthCertificate({
      network,
      claim_note,
      feeds: verifiedFeeds,
    });

    return toolResult({
      certificate,
      verification:
        "Every feed was verified locally: keccak256(abi.encode(feed body)) folded through its Merkle proof equals Relay.merkleRoots(100, voting_round_id) read on-chain. certificate_hash is keccak256 over the canonical JSON of the certificate.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(
      `Failed to build market truth bundle on ${network}: ${message}`,
    );
  }
}

export const marketTruthBundle = withX402(
  "market_truth_bundle",
  marketTruthCore,
);

export function registerMarketTruthTool(server: McpServer): void {
  server.tool(
    "market_truth_bundle",
    "Build a Proof-of-Market-Truth certificate for 1-8 FTSO Scaling anchor feeds, each locally Merkle-verified against the on-chain Relay root and bound by a deterministic keccak256 certificate_hash.",
    marketTruthBundleInput,
    marketTruthBundle,
  );
}
