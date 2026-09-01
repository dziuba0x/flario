// fcc_deployment_status: a live window on Flare 2.0 as it rolls out.
//
// Flare's confidential compute is being deployed right now, one network at a
// time, and Flare has not yet published an ABI for it — FlareTeeManager is
// absent from the periphery artifacts, alpha releases included. So this tool
// does not call FCC. It reads the things that are true on-chain regardless of
// what Flare eventually names anything:
//
//   - is a confidential-compute contract registered in the ContractRegistry
//   - if it is an ERC-2535 diamond, which facets and which function selectors
//   - which capabilities those selectors correspond to
//   - what it is wired to, FDC V2 included
//   - whether the system has live state or is an empty shell
//
// Selectors are facts. A rename changes the signature database entry, not the
// four bytes sitting in the diamond's routing table, so the capability read
// survives it. Where a human-readable name is shown, the report says plainly
// that it came from signature matching rather than an official interface.
import { z } from "zod";
import { getAddress, type Hex } from "viem";
import { getClient, type NetworkType } from "../utils/rpc.js";
import { getAllContracts } from "../utils/contracts.js";
import {
  FCC_SELECTORS,
  CAPABILITY_LABELS,
  type FccCapability,
} from "../utils/fcc-selectors.js";

const NETWORKS = ["mainnet", "songbird", "coston2", "coston"] as const;

const FCC_NAME_PATTERNS: readonly RegExp[] = [
  /fcc/i, /confidential/i, /tee/i, /pmw/i,
  /protocolmanagedwallet/i, /computeextension/i, /fce/i,
];

const LOUPE_ABI = [
  {
    name: "facets",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "facetAddress", type: "address" },
          { name: "functionSelectors", type: "bytes4[]" },
        ],
      },
    ],
  },
] as const;

/** Address-returning getters worth reading if the selector is present. */
const WIRING: ReadonlyArray<{ fn: string; note: string }> = [
  { fn: "fdc2Hub", note: "FDC V2 hub" },
  { fn: "fdc2Verification", note: "FDC V2 verification" },
  { fn: "flareSystemsManager", note: "Flare Systems Manager" },
  { fn: "relay", note: "Relay (Merkle roots)" },
  { fn: "rewardManager", note: "Reward manager" },
  { fn: "getAddressUpdater", note: "Address updater" },
];

export const fccDeploymentStatusInput = {
  network: z
    .enum(["mainnet", "songbird", "coston2", "coston", "all"])
    .default("all")
    .describe("A single network, or all four to see the rollout front."),
  include_deployment_block: z
    .boolean()
    .default(false)
    .describe(
      "Binary-search the first block where the contract had code. Accurate, but ~30 extra RPC calls per contract.",
    ),
};

export async function fccDeploymentStatus(args: {
  network?: NetworkType | "all";
  include_deployment_block?: boolean;
}) {
  const target = args.network ?? "all";
  const nets = target === "all" ? NETWORKS : [target as NetworkType];

  try {
    const report = [];
    for (const network of nets) {
      report.push(
        await inspectNetwork(network, args.include_deployment_block ?? false),
      );
    }

    const live = report.filter((r) => r.confidential_compute_found);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              rollout_summary: live.length
                ? `Confidential compute is registered on: ${live.map((r) => r.network).join(", ")}. Not yet on: ${report.filter((r) => !r.confidential_compute_found).map((r) => r.network).join(", ")}.`
                : "No confidential-compute contract is registered in the ContractRegistry on any network checked.",
              checked_at: Math.floor(Date.now() / 1000),
              caveat:
                "Function names are resolved from a public signature database, because Flare has not published an ABI for these contracts. Selectors, facets, addresses and wiring are read directly from the chain and are exact.",
              networks: report,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to read confidential-compute deployment status: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

async function inspectNetwork(network: NetworkType, wantBlock: boolean) {
  const contracts = await getAllContracts(network);
  const matches = contracts.filter((c) =>
    FCC_NAME_PATTERNS.some((p) => p.test(c.name)),
  );

  if (matches.length === 0) {
    return {
      network,
      confidential_compute_found: false,
      registry_size: contracts.length,
      note: "Nothing matching confidential compute is registered here yet. This tool reports it the moment it is.",
    };
  }

  const details = [];
  for (const m of matches) {
    details.push(await inspectContract(network, m.name, m.address, wantBlock));
  }

  return {
    network,
    confidential_compute_found: true,
    registry_size: contracts.length,
    contracts: details,
  };
}

async function inspectContract(
  network: NetworkType,
  name: string,
  address: string,
  wantBlock: boolean,
) {
  const client = getClient(network);
  const addr = getAddress(address);

  const code = await client.getCode({ address: addr });
  const bytecodeBytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;

  // ERC-2535 loupe. A small bytecode with a routing table means a diamond, and
  // the loupe is the only honest way to learn what it can do without an ABI.
  let facets: Array<{ facetAddress: string; functionSelectors: string[] }> = [];
  let isDiamond = false;
  try {
    facets = (await client.readContract({
      address: addr,
      abi: LOUPE_ABI,
      functionName: "facets",
    })) as typeof facets;
    isDiamond = facets.length > 0;
  } catch {
    // not a diamond, or the loupe is not exposed
  }

  const selectors = facets.flatMap((f) => f.functionSelectors);
  const byCapability = new Map<FccCapability, string[]>();
  let unknown = 0;
  for (const sel of selectors) {
    const hit = FCC_SELECTORS[sel.toLowerCase()];
    if (!hit) {
      unknown++;
      continue;
    }
    const [sig, cap] = hit;
    const list = byCapability.get(cap) ?? [];
    list.push(sig);
    byCapability.set(cap, list);
  }

  const capabilities = [...byCapability.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cap, sigs]) => ({
      capability: cap,
      means: CAPABILITY_LABELS[cap],
      function_count: sigs.length,
      examples: sigs.slice(0, 4),
    }));

  const wiring = await readWiring(client, addr, selectors);
  const liveState = await readLiveState(client, addr, selectors);

  let deployed_at: string | undefined;
  let deployment_block: number | undefined;
  if (wantBlock && bytecodeBytes > 0) {
    const found = await firstBlockWithCode(client, addr);
    if (found) {
      deployment_block = Number(found.block);
      deployed_at = new Date(Number(found.timestamp) * 1000).toISOString();
    }
  }

  return {
    name,
    address: addr,
    bytecode_bytes: bytecodeBytes,
    is_erc2535_diamond: isDiamond,
    facet_count: facets.length,
    selector_count: selectors.length,
    unrecognised_selectors: unknown,
    deployment_block,
    deployed_at,
    capabilities,
    wiring,
    live_state: liveState,
  };
}

async function readWiring(
  client: ReturnType<typeof getClient>,
  address: Hex,
  selectors: string[],
) {
  const present = new Set(selectors.map((s) => s.toLowerCase()));
  const out: Array<Record<string, unknown>> = [];

  for (const { fn, note } of WIRING) {
    const sel = Object.entries(FCC_SELECTORS).find(([, v]) => v[0] === `${fn}()`)?.[0];
    if (!sel || !present.has(sel)) continue;
    try {
      const value = (await client.readContract({
        address,
        abi: [
          {
            name: fn,
            type: "function",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "address" }],
          },
        ] as const,
        functionName: fn as never,
      })) as string;

      const code = await client.getCode({ address: getAddress(value) });
      out.push({
        getter: `${fn}()`,
        what: note,
        address: value,
        has_code: code !== undefined && code !== "0x",
      });
    } catch {
      // a getter that reverts tells us nothing useful; leave it out
    }
  }
  return out;
}

/**
 * Distinguish a configured, running system from an empty shell. Extension 0 is
 * the first (and currently only) confidential-compute extension.
 */
async function readLiveState(
  client: ReturnType<typeof getClient>,
  address: Hex,
  selectors: string[],
) {
  const present = new Set(selectors.map((s) => s.toLowerCase()));
  const has = (sig: string) =>
    Object.entries(FCC_SELECTORS).some(
      ([sel, v]) => v[0] === sig && present.has(sel),
    );

  const state: Record<string, unknown> = {};

  if (has("getLatestTeeGovernance(uint256)")) {
    try {
      const signers = (await client.readContract({
        address,
        abi: [
          {
            name: "getLatestTeeGovernance",
            type: "function",
            stateMutability: "view",
            inputs: [{ type: "uint256" }],
            outputs: [{ type: "address[]" }],
          },
        ] as const,
        functionName: "getLatestTeeGovernance",
        args: [0n],
      })) as string[];
      state.tee_governance_signers = signers.length;
    } catch {
      state.tee_governance_signers = null;
    }
  }

  if (has("getActiveMachinePathListNonce(uint256)")) {
    try {
      const nonce = (await client.readContract({
        address,
        abi: [
          {
            name: "getActiveMachinePathListNonce",
            type: "function",
            stateMutability: "view",
            inputs: [{ type: "uint256" }],
            outputs: [{ type: "uint256" }],
          },
        ] as const,
        functionName: "getActiveMachinePathListNonce",
        args: [0n],
      })) as bigint;
      state.machine_allowlist_revisions = Number(nonce);
    } catch {
      state.machine_allowlist_revisions = null;
    }
  }

  if (has("getActiveTeeMachines(uint256)")) {
    try {
      const machines = (await client.readContract({
        address,
        abi: [
          {
            name: "getActiveTeeMachines",
            type: "function",
            stateMutability: "view",
            inputs: [{ type: "uint256" }],
            outputs: [{ type: "address[]" }],
          },
        ] as const,
        functionName: "getActiveTeeMachines",
        args: [0n],
      })) as string[];
      state.active_tee_machines = machines.length;
    } catch {
      state.active_tee_machines = null;
    }
  }

  const signers = state.tee_governance_signers;
  const revisions = state.machine_allowlist_revisions;
  state.assessment =
    typeof signers === "number" && signers > 0
      ? `Configured and in use: ${signers} governance signers${typeof revisions === "number" ? `, machine allowlist revised ${revisions} time(s)` : ""}. This is not an empty deployment.`
      : "Deployed but no governance state readable yet.";

  return state;
}

/** Binary search for the first block where the address had code. */
async function firstBlockWithCode(
  client: ReturnType<typeof getClient>,
  address: Hex,
): Promise<{ block: bigint; timestamp: bigint } | null> {
  try {
    let lo = 0n;
    let hi = await client.getBlockNumber();
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const code = await client
        .getCode({ address, blockNumber: mid })
        .catch(() => undefined);
      if (code && code !== "0x") hi = mid;
      else lo = mid + 1n;
    }
    const block = await client.getBlock({ blockNumber: lo });
    return { block: lo, timestamp: block.timestamp };
  } catch {
    return null;
  }
}
