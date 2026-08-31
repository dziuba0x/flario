// FTSO tools: get_ftso_feed, get_ftso_feeds_all, get_ftso_anchor_feed, get_ftso_history
import { z } from "zod";
import { getClient, type NetworkType } from "../utils/rpc.js";
import {
  getContractAddress,
  getInterfaceAbi,
  FTSO_FEEDS,
} from "../utils/contracts.js";
import { getAddress } from "viem";
import {
  resolveAnchorFeedId,
  fetchAnchorFeeds,
  fetchLatestFinalizedAnchor,
  verifyAnchorFeed,
  anchorFeedPrice,
  latestVotingRound,
  type AnchorFeedWithProof,
} from "../utils/ftso-da.js";

const FTSO_V2_ABI = [
  {
    name: "getFeedById",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "_feedId", type: "bytes21" }],
    outputs: [
      { name: "_value", type: "uint256" },
      { name: "_decimals", type: "int8" },
      { name: "_timestamp", type: "uint64" },
    ],
  },
] as const;

// Resolve a user-supplied feed identifier ("FLR/USD" name or raw hex id) to
// its on-chain bytes21 feed id and canonical display name.
function resolveFeed(feedId: string): { id: `0x${string}`; name: string } {
  if (/^0x[a-fA-F0-9]{42}$/.test(feedId)) {
    const known = FTSO_FEEDS.find(
      (f) => f.id.toLowerCase() === feedId.toLowerCase(),
    );
    return { id: feedId as `0x${string}`, name: known?.name ?? feedId };
  }
  const match = FTSO_FEEDS.find(
    (f) => f.name.toLowerCase() === feedId.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `Unknown feed "${feedId}". Use a known feed name (e.g. "FLR/USD") or a raw bytes21 feed id.`,
    );
  }
  return { id: match.id as `0x${string}`, name: match.name };
}

export const getFtsoFeedInput = {
  feed_id: z.string(),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
};

export async function getFtsoFeed(args: {
  feed_id: string;
  network: NetworkType;
}) {
  const { feed_id, network } = args;
  try {
    const { id, name } = resolveFeed(feed_id);
    const client = getClient(network);
    const ftsoV2 = await getContractAddress("FtsoV2", network);

    const [value, decimals, timestamp] = (await client.readContract({
      address: ftsoV2 as `0x${string}`,
      abi: FTSO_V2_ABI,
      functionName: "getFeedById",
      args: [id],
    })) as [bigint, number, bigint];

    const price = Number(value) / 10 ** Number(decimals);

    const result = {
      feed_id: id,
      name,
      price,
      decimals: Number(decimals),
      timestamp: Number(timestamp),
      network,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to fetch FTSO feed "${feed_id}" on ${network}: ${message}`,
        },
      ],
    };
  }
}

export const getFtsoProvidersInput = {
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
  reward_epoch_id: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Reward epoch to read. Defaults to the current one."),
  limit: z.number().int().min(1).max(200).default(50),
};

/**
 * The set of FTSO data providers, read straight off the chain.
 *
 * A provider is a voter registered in the VoterRegistry for a reward epoch.
 * `getRegisteredVotersAndNormalisedWeights` returns both the addresses and
 * their normalised vote weights, so the signing power distribution comes from
 * consensus state rather than from anyone's indexer.
 *
 * Human-readable provider names are genuinely off-chain: they live in
 * community metadata, not in a contract. If FLARE_PROVIDERS_API is set we
 * decorate the on-chain rows with names from it, but the tool works fully
 * without it and never fails because it is missing. That is the honest split:
 * consensus data on-chain, cosmetic labels optional.
 */
export async function getFtsoProviders(args: {
  network: NetworkType;
  reward_epoch_id?: number;
  limit?: number;
}) {
  const { network, reward_epoch_id, limit = 50 } = args;

  try {
    const client = getClient(network);

    const systemsManager = getAddress(
      await getContractAddress("FlareSystemsManager", network),
    );
    const epoch =
      reward_epoch_id !== undefined
        ? BigInt(reward_epoch_id)
        : BigInt(
            (await client.readContract({
              address: systemsManager,
              abi: getInterfaceAbi("IFlareSystemsManager", network),
              functionName: "getCurrentRewardEpochId",
            })) as bigint | number,
          );

    const voterRegistry = getAddress(
      await getContractAddress("VoterRegistry", network),
    );
    const registryAbi = getInterfaceAbi("IIVoterRegistry", network);

    const [voters, weights] = (await client.readContract({
      address: voterRegistry,
      abi: registryAbi,
      functionName: "getRegisteredVotersAndNormalisedWeights",
      args: [epoch],
    })) as [readonly `0x${string}`[], readonly number[]];

    const [, normalisedWeightsSum] = (await client.readContract({
      address: voterRegistry,
      abi: registryAbi,
      functionName: "getWeightsSums",
      args: [epoch],
    })) as [bigint, number, number];

    const names = await fetchProviderNames(network);

    const ranked = voters
      .map((address, i) => {
        const weight = Number(weights[i] ?? 0);
        return {
          address,
          name: names.get(address.toLowerCase()) ?? null,
          normalised_weight: weight,
          share_percent:
            normalisedWeightsSum > 0
              ? Number(((weight / normalisedWeightsSum) * 100).toFixed(4))
              : null,
        };
      })
      .sort((a, b) => b.normalised_weight - a.normalised_weight);

    const top = ranked.slice(0, limit);
    const cumulative = top.reduce((acc, p) => acc + (p.share_percent ?? 0), 0);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              network,
              reward_epoch_id: Number(epoch),
              registered_providers: voters.length,
              returned: top.length,
              normalised_weights_sum: normalisedWeightsSum,
              source: "on-chain VoterRegistry (no external indexer)",
              names_source: names.size
                ? "FLARE_PROVIDERS_API"
                : "not configured — addresses only, which is normal",
              cumulative_share_percent_of_returned: Number(cumulative.toFixed(4)),
              voter_registry: voterRegistry,
              providers: top,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to read FTSO providers on ${network}: ${message}`,
        },
      ],
    };
  }
}

/**
 * Optional, best-effort address -> name map. Never throws: a missing or broken
 * names endpoint must not take down a tool whose real payload is on-chain.
 */
async function fetchProviderNames(
  network: NetworkType,
): Promise<Map<string, string>> {
  const endpoint = process.env.FLARE_PROVIDERS_API;
  const out = new Map<string, string>();
  if (!endpoint) return out;

  try {
    const url = endpoint.includes("?")
      ? `${endpoint}&network=${encodeURIComponent(network)}`
      : `${endpoint}?network=${encodeURIComponent(network)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return out;

    const raw = (await res.json()) as unknown;
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { providers?: unknown }).providers)
        ? (raw as { providers: unknown[] }).providers
        : [];

    for (const entry of list) {
      const r = entry as Record<string, unknown>;
      const address = (r.address ?? r.providerAddress) as string | undefined;
      const name = (r.name ?? r.providerName) as string | undefined;
      if (typeof address === "string" && typeof name === "string") {
        out.set(address.toLowerCase(), name);
      }
    }
  } catch {
    // Cosmetic enrichment only; on-chain data already stands on its own.
  }
  return out;
}

export const getFtsoAnchorFeedInput = {
  feed_id: z.string(),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
  voting_round_id: z.number().int().positive().optional(),
};

/**
 * Proof-carrying FTSO Scaling anchor feed: the price plus a Merkle proof
 * verified LOCALLY against the on-chain Relay root (FTSO Scaling protocol id
 * 100). The returned value is trust-minimized — an agent or a downstream
 * contract can rely on it without trusting the DA API.
 */
export async function getFtsoAnchorFeed(args: {
  feed_id: string;
  network: NetworkType;
  voting_round_id?: number;
}) {
  const { feed_id, network, voting_round_id } = args;
  try {
    const id = await resolveAnchorFeedId(feed_id, network);
    const known = FTSO_FEEDS.find((f) => f.id.toLowerCase() === id);

    let feed: AnchorFeedWithProof | undefined;
    let round: number;
    if (voting_round_id !== undefined) {
      round = voting_round_id;
      feed = (await fetchAnchorFeeds([id], round, network))[0];
    } else {
      const latest = await fetchLatestFinalizedAnchor([id], network);
      round = latest.votingRoundId;
      feed = latest.feeds.find((f) => f.body.id.toLowerCase() === id) ?? latest.feeds[0];
    }
    if (!feed) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `No anchor feed for "${feed_id}" (${id}) in voting round ${round} on ${network}. The round may not be finalized yet.`,
          },
        ],
      };
    }

    const { verified, merkleRoot } = await verifyAnchorFeed(feed, network);
    if (!verified) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Merkle verification FAILED for "${feed_id}" in round ${round} on ${network}: the DA-layer proof does not match the on-chain FTSO Scaling root (${merkleRoot}). Do not trust this value.`,
          },
        ],
      };
    }

    const result = {
      verified: true,
      verification:
        "Local: keccak256(abi.encode(feed body)) folded through the Merkle proof equals Relay.merkleRoots(100, round) read on-chain.",
      feed_id: id,
      name: known?.name ?? feed_id,
      price: anchorFeedPrice(feed.body),
      value: feed.body.value,
      decimals: feed.body.decimals,
      turnout_bips: feed.body.turnoutBIPS,
      voting_round_id: round,
      network,
      merkle_root: merkleRoot,
      proof: feed.proof,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to fetch anchor feed "${feed_id}" on ${network}: ${message}`,
        },
      ],
    };
  }
}

export const getFtsoHistoryInput = {
  feed_id: z.string(),
  rounds: z.number().int().min(1).max(30).default(10),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
  verify: z.boolean().default(true),
};

/**
 * Recent FTSO Scaling anchor-feed history for one feed, straight from the
 * public DA layer (no external indexer needed). Each point is optionally
 * Merkle-verified against the on-chain Relay root.
 */
export async function getFtsoHistory(args: {
  feed_id: string;
  rounds?: number;
  network: NetworkType;
  verify?: boolean;
}) {
  const { feed_id, rounds = 10, network, verify = true } = args;
  try {
    const id = await resolveAnchorFeedId(feed_id, network);
    const known = FTSO_FEEDS.find((f) => f.id.toLowerCase() === id);
    const latest = await latestVotingRound(network);

    // One anchor query per round; skip the very latest (may be unfinalized).
    const roundIds: number[] = [];
    for (let r = latest - 1; r > latest - 1 - rounds && r > 0; r--) {
      roundIds.push(r);
    }

    const history: Array<Record<string, unknown>> = [];
    const batchSize = 5;
    for (let i = 0; i < roundIds.length; i += batchSize) {
      const batch = roundIds.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (round) => {
          try {
            const feeds = await fetchAnchorFeeds([id], round, network);
            const feed = feeds.find((f) => f.body.id.toLowerCase() === id);
            if (!feed) return null;
            let verified: boolean | undefined;
            if (verify) {
              verified = (await verifyAnchorFeed(feed, network)).verified;
            }
            return {
              round_id: feed.body.votingRoundId,
              price: anchorFeedPrice(feed.body),
              value: feed.body.value,
              decimals: feed.body.decimals,
              turnout_bips: feed.body.turnoutBIPS,
              ...(verify ? { verified } : {}),
            };
          } catch {
            return null;
          }
        }),
      );
      for (const r of results) {
        if (r) history.push(r);
      }
    }

    const result = {
      feed_id: id,
      name: known?.name ?? feed_id,
      network,
      rounds_requested: rounds,
      rounds_returned: history.length,
      source: verify
        ? "Flare DA layer; each point Merkle-verified against the on-chain Relay root (protocol 100)"
        : "Flare DA layer (unverified series; set verify=true for proofs)",
      history,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to fetch FTSO history for "${feed_id}" on ${network}: ${message}`,
        },
      ],
    };
  }
}

export const getFtsoFeedsAllInput = {
  network: z.enum(["mainnet", "coston2"]),
};

export async function getFtsoFeedsAll(args: { network: NetworkType }) {
  const { network } = args;
  try {
    const results = await Promise.all(
      FTSO_FEEDS.map(async (feed) => {
        const res = await getFtsoFeed({ feed_id: feed.name, network });
        const text = res.content[0]?.text ?? "{}";
        if (res.isError) {
          return { feed_id: feed.id, name: feed.name, error: text };
        }
        return JSON.parse(text);
      }),
    );

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(results, null, 2) },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to fetch all FTSO feeds on ${network}: ${message}`,
        },
      ],
    };
  }
}
