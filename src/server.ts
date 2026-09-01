// Tool/resource registration shared by the stdio entry and the HTTP hub.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getFlrBalance,
  getFlrBalanceInput,
} from "./tools/wallet.js";
import {
  getFtsoFeed,
  getFtsoFeedInput,
  getFtsoFeedsAll,
  getFtsoFeedsAllInput,
  getFtsoProviders,
  getFtsoProvidersInput,
  getFtsoHistory,
  getFtsoHistoryInput,
  getFtsoAnchorFeed,
  getFtsoAnchorFeedInput,
} from "./tools/ftso.js";
import {
  getFassetsStatus,
  getFassetsStatusInput,
} from "./tools/fassets.js";
import {
  getFdcProofStatus,
  getFdcProofStatusInput,
} from "./tools/fdc.js";
import {
  getSmartAccountInfo,
  getSmartAccountInfoInput,
} from "./tools/smart-accounts.js";
import {
  fdcRequestAttestation,
  fdcRequestAttestationInput,
  fdcGetAttestationProof,
  fdcGetAttestationProofInput,
} from "./tools/fdc-v2.js";
import {
  fassetsAgentStatus,
  fassetsAgentStatusInput,
  fassetsSystemState,
  fassetsSystemStateInput,
  fassetsAgentDetails,
  fassetsAgentDetailsInput,
} from "./tools/fassets-v2.js";
import { getFlrStakeInfo, getFlrStakeInfoInput } from "./tools/stake.js";
import {
  songbirdFccRegistry,
  songbirdFccRegistryInput,
} from "./tools/fcc.js";
import {
  fassetsLiquidationScanner,
  fassetsLiquidationScannerInput,
  fdcBulkProofBundle,
  fdcBulkProofBundleInput,
} from "./tools/premium.js";
import {
  fdcVerifySettlement,
  fdcVerifySettlementInput,
} from "./tools/fdc-settlement.js";
import {
  fdcWeb2JsonRequest,
  fdcWeb2JsonRequestInput,
  fdcVerifyWeb2Json,
  fdcVerifyWeb2JsonInput,
} from "./tools/web2json.js";
import { registerNetworkResources } from "./resources/network.js";
import {
  evidenceBundle,
  evidenceBundleInput,
  evidenceVerify,
  evidenceVerifyInput,
} from "./tools/evidence.js";
import { registerOnboardingPrompts } from "./prompts/onboarding.js";


export const SERVER_INFO = { name: "flario", version: "1.5.0" } as const;

export function buildServer(): McpServer {
  const server = new McpServer({ ...SERVER_INFO });

server.tool(
  "get_flr_balance",
  "Get native FLR balance and wrapped WFLR (WNat) balance for an EVM address on Flare mainnet or Coston2 testnet.",
  getFlrBalanceInput,
  getFlrBalance,
);

server.tool(
  "get_flr_stake_info",
  "One-call Flare portfolio for an address: native FLR + wrapped WFLR, FTSO vote power and delegation, claimable protocol rewards (by source), and FlareDrops. All four networks.",
  getFlrStakeInfoInput,
  getFlrStakeInfo,
);

server.tool(
  "get_ftso_feed",
  "Get the latest FTSO price feed (value, decimals, timestamp) for a feed by name (e.g. \"FLR/USD\") or raw bytes21 feed id.",
  getFtsoFeedInput,
  getFtsoFeed,
);

server.tool(
  "get_ftso_feeds_all",
  "Get the latest FTSO price for all known feeds on the given network.",
  getFtsoFeedsAllInput,
  getFtsoFeedsAll,
);

server.tool(
  "get_ftso_providers",
  "Get the list of active FTSO data providers (name, address, vote power, fee, reward rate) for the given network.",
  getFtsoProvidersInput,
  getFtsoProviders,
);

server.tool(
  "get_ftso_anchor_feed",
  "Get a proof-carrying FTSO Scaling anchor feed: the price plus a Merkle proof verified LOCALLY against the on-chain Relay root (FTSO Scaling protocol 100). Trust-minimized — usable by an agent or a smart contract without trusting the DA API. Defaults to the latest finalized round.",
  getFtsoAnchorFeedInput,
  getFtsoAnchorFeed,
);

server.tool(
  "get_ftso_history",
  "Get recent FTSO Scaling anchor-feed history for a feed (by name or bytes21 id) from the public Flare Data Availability layer — no external indexer needed. Each point is optionally Merkle-verified against the on-chain Relay root.",
  getFtsoHistoryInput,
  getFtsoHistory,
);

server.tool(
  "get_fassets_status",
  "Get FAssets status (total minted, active agent count) for FXRP, FBTC or FDOGE on the given network, via the on-chain AssetManager with a flaremetrics.io fallback.",
  getFassetsStatusInput,
  getFassetsStatus,
);

server.tool(
  "get_fdc_proof_status",
  "Get the FDC (protocol id 200) Merkle root and finalization status for a voting round from the Flare Relay contract.",
  getFdcProofStatusInput,
  getFdcProofStatus,
);

server.tool(
  "get_smart_account_info",
  "Resolve between XRPL accounts and Flare Smart Accounts via the on-chain MasterAccountController. Forward: give an XRPL account (r...) to get its deterministic Flare address and whether the account is actually deployed yet. Reverse: give a Flare address (0x...) to find out whether it is a Smart Account and which XRPL account owns it.",
  getSmartAccountInfoInput,
  getSmartAccountInfo,
);

server.tool(
  "fdc_request_attestation",
  "Submit an FDC attestation request (Payment, AddressValidity or EVMTransaction). Prepares the request via a Flare-hosted verifier, queries the request fee, and — if FLARE_PRIVATE_KEY is set — submits it to FdcHub, returning the tx hash and voting round id. Without a key it returns the prepared request for external submission.",
  fdcRequestAttestationInput,
  fdcRequestAttestation,
);

server.tool(
  "fdc_get_attestation_proof",
  "Retrieve an FDC attestation proof from the Data Availability layer for a finalized voting round and verify the Merkle proof locally against the on-chain Relay root (no trust in the DA response).",
  fdcGetAttestationProofInput,
  fdcGetAttestationProof,
);

server.tool(
  "fassets_agent_status",
  "List FAssets agents (FXRP first) with collateral ratios, minting capacity (free lots), minted/reserved amounts and liquidation status, sorted by vault collateral ratio (riskiest first).",
  fassetsAgentStatusInput,
  fassetsAgentStatus,
);

server.tool(
  "fassets_system_state",
  "Global FAssets system state for an asset: total minted, agent count, lot size, minting cap/pause, aggregated vault+pool collateral, and the redemption queue (tickets, value, lots).",
  fassetsSystemStateInput,
  fassetsSystemState,
);

server.tool(
  "fassets_agent_details",
  "Human-facing details of a FAssets agent (name, description, icon/logo URL, terms-of-use URL, whitelist status) from the AgentOwnerRegistry. Accepts an agent vault address or an owner management address.",
  fassetsAgentDetailsInput,
  fassetsAgentDetails,
);

server.tool(
  "fassets_liquidation_scanner",
  "PREMIUM (x402): FAssets agents ranked by liquidation risk, joined with live FTSOv2 prices — per agent: CR headroom, the underlying price at which liquidation starts, and the % price move away from it. Free when the operator has not enabled x402.",
  fassetsLiquidationScannerInput,
  fassetsLiquidationScanner,
);

server.tool(
  "fdc_bulk_proof_bundle",
  "PREMIUM (x402): batch retrieval of up to 20 FDC attestation proofs with local Merkle verification of each against the on-chain Relay root. Free when the operator has not enabled x402.",
  fdcBulkProofBundleInput,
  fdcBulkProofBundle,
);

server.tool(
  "songbird_fcc_registry",
  "Scan the live FlareContractRegistry (Songbird by default) for Flare Confidential Compute contracts (PMW, TEE, compute extensions). Reports FCC deployment status post-STP.13 and lists FDC/Relay contracts plus the full registry.",
  songbirdFccRegistryInput,
  songbirdFccRegistry,
);

server.tool(
  "fdc_web2json_request",
  "Turn any public web API into a fact a smart contract can verify. Prepares an FDC Web2Json attestation request (URL + jq filter + ABI signature) through a Flare-hosted verifier and quotes the request fee. Submits on-chain only if FLARE_PRIVATE_KEY is set and submission is permitted; otherwise returns the prepared request for your own signer.",
  fdcWeb2JsonRequestInput,
  fdcWeb2JsonRequest,
);

server.tool(
  "fdc_verify_web2json",
  "Verify a Web2Json attestation AND bind it to the source you expected. Checks the Merkle proof locally against the on-chain Relay root, confirms the attested URL matches your expected host / path / protocol / method, then decodes the payload with the request's ABI signature. Without expect_source the proof is verified but NOT bound, which an attacker can exploit with a valid proof from their own endpoint.",
  fdcVerifyWeb2JsonInput,
  fdcVerifyWeb2Json,
);

server.tool(
  "fdc_verify_settlement",
  "Prove an x402 settlement via Flare's enshrined FDC (trust-minimized, not the facilitator's word). Given a settlement tx hash it prepares an EVMTransaction attestation request (phase 1, free, no chain write); given a finalized voting_round_id + abi_encoded_request it locally Merkle-verifies the attestation AND binds it to the payment — confirming the attested tx contains an ERC-20 Transfer of >= amount of asset to payee. Never submits on-chain itself.",
  fdcVerifySettlementInput,
  fdcVerifySettlement,
);

server.tool(
  "evidence_bundle",
  "Package several proof-carrying facts into one portable bundle that someone else can verify without trusting you. Takes FTSO Scaling anchor feeds and finalized FDC attestations (Web2Json included), folds each Merkle proof against the on-chain Relay root BEFORE including it, and refuses any fact that fails. Use when an agent needs to hand a downstream consumer, an auditor, or another agent the evidence its decision rested on.",
  evidenceBundleInput,
  evidenceBundle,
);

server.tool(
  "evidence_verify",
  "Verify an evidence bundle from scratch. Rebuilds every leaf from its own body, folds it through its proof, and compares against Relay.merkleRoots(protocol, round) read on-chain right now. Re-binds Web2Json facts to the source recorded in the bundle. Trusts nothing in the bundle, including its own hash. This is the receiving end: run it on a bundle someone hands you.",
  evidenceVerifyInput,
  evidenceVerify,
);

registerNetworkResources(server);
  registerOnboardingPrompts(server);

  return server;
}
