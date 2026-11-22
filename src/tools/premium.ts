// Premium (x402-gated) tools: fassets_liquidation_scanner, fdc_bulk_proof_bundle.
// With X402_ENABLED unset both run free (the paywall wrapper is a passthrough).
//
// fassets_liquidation_scanner joins two Flare protocols in one computed
// answer: FAssets agent collateral state (IAssetManager.getAgentInfo /
// getCollateralTypes) × live FTSOv2 prices — producing, per agent, the
// underlying-asset price at which liquidation starts and the distance to it.
import { z } from "zod";
import { getAddress, type Address } from "viem";
import { getClient, type NetworkType } from "../utils/rpc.js";
import { getContractAddress, getInterfaceAbi, FTSO_FEEDS } from "../utils/contracts.js";
import {
  resolveAssetManager,
  type AgentInfoStruct,
} from "./fassets-v2.js";
import { retrieveAndVerifyProof } from "./fdc-v2.js";
import { withX402, x402PaymentInput } from "../x402/paywall.js";

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

interface CollateralTypeStruct {
  collateralClass: number;
  token: Address;
  decimals: bigint;
  assetFtsoSymbol: string;
  tokenFtsoSymbol: string;
  minCollateralRatioBIPS: bigint;
  safetyMinCollateralRatioBIPS: bigint;
}

export interface LiquidationRisk {
  agent_vault: string;
  status: string;
  in_liquidation: boolean;
  vault_collateral_ratio: number;
  vault_min_ratio: number;
  pool_collateral_ratio: number;
  pool_min_ratio: number;
  /** min(current CR / min CR) across vault+pool — 1.0 means at threshold. */
  cr_headroom: number;
  /** Underlying asset price (USD) at which the binding CR hits its minimum. */
  asset_price_at_liquidation: number | null;
  /** % the underlying price must RISE for liquidation to start. */
  price_rise_to_liquidation_pct: number | null;
  binding_constraint: "vault" | "pool";
  minted: string;
  /** Minted FAsset exposure valued in USD at live FTSOv2 price. */
  liability_usd: number;
  /** Exact USD collateral deficit to restore binding safety CR (0 if already safe). */
  topup_to_safe_usd: number;
  /** True if a +20% underlying price shock pushes the agent into liquidation. */
  liquidated_at_20pct_shock: boolean;
}

const AGENT_STATUS = ["NORMAL", "CCB", "LIQUIDATION", "FULL_LIQUIDATION", "DESTROYING"] as const;

/**
 * Pure risk computation, unit-tested with recorded structs.
 *
 * Model: collateral is valued in USD; minted FAssets are a liability of
 * (mintedUBA × asset price). CR = collateralUSD / liabilityUSD, so CR falls
 * proportionally as the underlying asset price rises (collateral value held
 * constant — exact for stablecoin vault collateral, approximate for the
 * FLR/SGB pool). Liquidation price = current price × (CR / minCR) of the
 * binding (lower-headroom) constraint.
 */
export function computeLiquidationRisk(
  vault: string,
  info: Pick<
    AgentInfoStruct,
    | "status"
    | "vaultCollateralRatioBIPS"
    | "poolCollateralRatioBIPS"
    | "mintedUBA"
  >,
  minVaultCrBips: bigint,
  minPoolCrBips: bigint,
  assetPriceUsd: number,
  assetDecimals: number,
  safetyVaultCrBips: bigint = minVaultCrBips,
  safetyPoolCrBips: bigint = minPoolCrBips,
): LiquidationRisk {
  const vaultCr = Number(info.vaultCollateralRatioBIPS) / 10_000;
  const poolCr = Number(info.poolCollateralRatioBIPS) / 10_000;
  const vaultMin = Number(minVaultCrBips) / 10_000;
  const poolMin = Number(minPoolCrBips) / 10_000;
  const vaultSafety = Number(safetyVaultCrBips) / 10_000;
  const poolSafety = Number(safetyPoolCrBips) / 10_000;

  const vaultHeadroom = vaultMin > 0 ? vaultCr / vaultMin : Infinity;
  const poolHeadroom = poolMin > 0 ? poolCr / poolMin : Infinity;
  const binding = vaultHeadroom <= poolHeadroom ? "vault" : "pool";
  const headroom = Math.min(vaultHeadroom, poolHeadroom);

  const mintedAmount = Number(info.mintedUBA) / 10 ** assetDecimals;
  const liabilityUsd = mintedAmount * assetPriceUsd;
  const bindingCr = binding === "vault" ? vaultCr : poolCr;
  const bindingSafetyCr = binding === "vault" ? vaultSafety : poolSafety;
  const topupToSafeUsd =
    info.mintedUBA > 0n && bindingSafetyCr > bindingCr
      ? Number((liabilityUsd * (bindingSafetyCr - bindingCr)).toFixed(2))
      : 0;

  const hasExposure = info.mintedUBA > 0n && Number.isFinite(headroom);
  const liquidationPrice = hasExposure ? assetPriceUsd * headroom : null;
  const inLiquidation = info.status === 2 || info.status === 3;

  return {
    agent_vault: vault,
    status: AGENT_STATUS[info.status] ?? `UNKNOWN(${info.status})`,
    in_liquidation: inLiquidation,
    vault_collateral_ratio: vaultCr,
    vault_min_ratio: vaultMin,
    pool_collateral_ratio: poolCr,
    pool_min_ratio: poolMin,
    cr_headroom: Number.isFinite(headroom) ? headroom : -1,
    asset_price_at_liquidation: liquidationPrice,
    price_rise_to_liquidation_pct:
      liquidationPrice !== null ? (headroom - 1) * 100 : null,
    binding_constraint: binding,
    minted: mintedAmount.toString(),
    liability_usd: Number(liabilityUsd.toFixed(2)),
    topup_to_safe_usd: topupToSafeUsd,
    liquidated_at_20pct_shock: inLiquidation || (hasExposure && headroom <= 1.2),
  };
}

const ASSET_FEED: Record<string, string> = {
  FXRP: "XRP/USD",
  FBTC: "BTC/USD",
  FDOGE: "DOGE/USD",
};

export const fassetsLiquidationScannerInput = {
  asset: z.enum(["FXRP", "FBTC", "FDOGE"]),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
  max_agents: z.number().int().positive().max(100).optional(),
  ...x402PaymentInput,
};

export async function liquidationScannerCore(args: {
  asset: "FXRP" | "FBTC" | "FDOGE";
  network: NetworkType;
  max_agents?: number;
}) {
  const { asset, network } = args;
  const maxAgents = args.max_agents ?? 50;
  try {
    const manager = await resolveAssetManager(asset, network);
    if (!manager) {
      return toolError(
        `No AssetManager for ${asset} in the ${network} FlareContractRegistry. As of 2026-07 only FXRP is live.`,
      );
    }
    const client = getClient(network);
    const abi = getInterfaceAbi("IAssetManager", network);

    const [settings, collateralTypes, ftsoV2, [vaults]] = await Promise.all([
      client.readContract({ address: manager, abi, functionName: "getSettings" }) as Promise<{
        assetDecimals: bigint;
      }>,
      client.readContract({ address: manager, abi, functionName: "getCollateralTypes" }) as Promise<
        readonly CollateralTypeStruct[]
      >,
      getContractAddress("FtsoV2", network),
      client.readContract({
        address: manager,
        abi,
        functionName: "getAllAgents",
        args: [0n, BigInt(maxAgents)],
      }) as Promise<readonly [readonly Address[], bigint]>,
    ]);
    const assetDecimals = Number(settings.assetDecimals);

    // Live FTSOv2 price of the underlying asset.
    const feedName = ASSET_FEED[asset];
    const feed = FTSO_FEEDS.find((f) => f.name === feedName);
    if (!feed) {
      return toolError(`No FTSO feed configured for ${asset} (${feedName}).`);
    }
    const [value, decimals, priceTimestamp] = (await client.readContract({
      address: getAddress(ftsoV2),
      abi: FTSO_V2_ABI,
      functionName: "getFeedById",
      args: [feed.id as `0x${string}`],
    })) as [bigint, number, bigint];
    const assetPriceUsd = Number(value) / 10 ** Number(decimals);

    // Minimum & safety CRs per collateral type: pool class (1) applies to all
    // agents' pool collateral; vault minimums are matched per agent token below.
    const poolType = collateralTypes.find((t) => Number(t.collateralClass) === 1);
    const vaultTypeByToken = new Map(
      collateralTypes
        .filter((t) => Number(t.collateralClass) !== 1)
        .map((t) => [t.token.toLowerCase(), t]),
    );

    const risks: LiquidationRisk[] = [];
    const batchSize = 10;
    for (let i = 0; i < vaults.length; i += batchSize) {
      const batch = vaults.slice(i, i + batchSize);
      const infos = (await Promise.all(
        batch.map((vault) =>
          client.readContract({ address: manager, abi, functionName: "getAgentInfo", args: [vault] }),
        ),
      )) as AgentInfoStruct[];
      for (let j = 0; j < batch.length; j++) {
        const info = infos[j];
        const vaultType = vaultTypeByToken.get(info.vaultCollateralToken.toLowerCase());
        risks.push(
          computeLiquidationRisk(
            batch[j],
            info,
            vaultType?.minCollateralRatioBIPS ?? 0n,
            poolType?.minCollateralRatioBIPS ?? 0n,
            assetPriceUsd,
            assetDecimals,
            vaultType?.safetyMinCollateralRatioBIPS ?? vaultType?.minCollateralRatioBIPS ?? 0n,
            poolType?.safetyMinCollateralRatioBIPS ?? poolType?.minCollateralRatioBIPS ?? 0n,
          ),
        );
      }
    }

    risks.sort((a, b) => {
      const ah = a.cr_headroom < 0 ? Infinity : a.cr_headroom;
      const bh = b.cr_headroom < 0 ? Infinity : b.cr_headroom;
      return ah - bh;
    });

    const totalLiabilityUsd = Number(
      risks.reduce((sum, r) => sum + r.liability_usd, 0).toFixed(2),
    );
    const totalTopupToSafeUsd = Number(
      risks.reduce((sum, r) => sum + r.topup_to_safe_usd, 0).toFixed(2),
    );

    return toolResult({
      asset,
      network,
      asset_manager: manager,
      underlying_price_usd: assetPriceUsd,
      price_feed: feedName,
      price_timestamp: Number(priceTimestamp),
      agents_scanned: risks.length,
      agents_in_liquidation: risks.filter((r) => r.in_liquidation).length,
      agents_within_10pct_of_liquidation: risks.filter(
        (r) => r.cr_headroom > 0 && r.cr_headroom < 1.1,
      ).length,
      agents_liquidated_at_20pct_shock: risks.filter((r) => r.liquidated_at_20pct_shock).length,
      total_liability_usd: totalLiabilityUsd,
      total_topup_to_safe_usd: totalTopupToSafeUsd,
      model_note:
        "Liquidation price assumes collateral USD value constant while the underlying price moves (exact for stablecoin vault collateral, approximate for the FLR/SGB pool). CCB and safety ratios not modeled.",
      agents: risks,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Liquidation scan failed for ${asset} on ${network}: ${message}`);
  }
}

export const fassetsLiquidationScanner = withX402(
  "fassets_liquidation_scanner",
  liquidationScannerCore,
);

export const fdcBulkProofBundleInput = {
  requests: z
    .array(
      z.object({
        voting_round_id: z.number().int().nonnegative(),
        abi_encoded_request: z.string().regex(/^0x[0-9a-fA-F]+$/),
      }),
    )
    .min(1)
    .max(20),
  network: z.enum(["mainnet", "coston2", "songbird", "coston"]),
  ...x402PaymentInput,
};

export async function bulkProofBundleCore(args: {
  requests: Array<{ voting_round_id: number; abi_encoded_request: string }>;
  network: NetworkType;
}) {
  const { requests, network } = args;
  try {
    const results: Array<Record<string, unknown>> = [];
    const concurrency = 3;
    for (let i = 0; i < requests.length; i += concurrency) {
      const batch = requests.slice(i, i + concurrency);
      const settled = await Promise.all(
        batch.map(async (req) => {
          try {
            const proof = await retrieveAndVerifyProof(
              req.voting_round_id,
              req.abi_encoded_request,
              network,
            );
            return {
              voting_round_id: req.voting_round_id,
              status: "verified" as const,
              attestation_type: proof.attestation_type,
              merkle_root: proof.merkle_root,
              response: proof.response,
              merkle_proof: proof.merkle_proof,
            };
          } catch (err) {
            return {
              voting_round_id: req.voting_round_id,
              status: "failed" as const,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      results.push(...settled);
    }

    const verified = results.filter((r) => r.status === "verified").length;
    return toolResult({
      network,
      requested: requests.length,
      verified,
      failed: requests.length - verified,
      verification:
        "Each proof verified locally: keccak256(abi.encode(response)) folded through the Merkle proof equals Relay.merkleRoots(200, round) read on-chain.",
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Bulk proof bundle failed on ${network}: ${message}`);
  }
}

export const fdcBulkProofBundle = withX402(
  "fdc_bulk_proof_bundle",
  bulkProofBundleCore,
);
