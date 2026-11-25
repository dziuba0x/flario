// Minimal local x402 facilitator: verify a signed EIP-3009 authorization and
// settle it on Flare. The facilitator NEVER holds funds — the transfer moves
// tokens directly payer → payee inside transferWithAuthorization; the
// operator key only pays gas to broadcast the client-signed authorization.
//
// Flow and payload shape follow the x402 spec (https://www.x402.org/) and
// Flare's reference implementation at
// https://dev.flare.network/fxrp/token-interactions/x402-payments, adapted
// to MCP: requirements/payloads travel in tool results and a tool argument
// instead of HTTP 402 headers.
import {
  getAddress,
  parseUnits,
  verifyTypedData,
  type Hex,
} from "viem";
import { getClient, getSigner, type NetworkType } from "../utils/rpc.js";
import { type X402Config, priceFor } from "./config.js";

// EIP-3009 TransferWithAuthorization typed data, per
// https://eips.ethereum.org/EIPS/eip-3009
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const TOKEN_ABI = [
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "authorizationState",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    // v,r,s variant (canonical EIP-3009)
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const TOKEN_ABI_BYTES_SIG = [
  {
    // packed-signature variant (used by USD₮0 / TetherTokenOFTExtension, per
    // https://dev.flare.network/network/guides/gasless-usdt0-transfers)
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export interface PaymentRequirements {
  scheme: "exact";
  network: NetworkType;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  maxAmountRequired: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
  extra: {
    chainId: number;
    eip712: { name?: string; version: string };
    standard: "EIP-3009";
  };
}

export interface PaymentPayload {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
  // Optional payer-chosen secret salt for the ZK-ready receipt commitment.
  // NOT part of the EIP-712 authorization signature, so it can never affect
  // fund movement — it only blinds the payer_commitment in the receipt.
  commitment_salt?: string;
  // Optional DELICTI mandate the paying agent acts under (decimal id in the
  // registry). Not part of the EIP-712 signature; it only binds the receipt to a
  // mandate commitment and lets the effector refuse deeds without a live mandate.
  mandate_id?: string;
  mandate_registry?: `0x${string}`;
}

const CHAIN_IDS: Record<NetworkType, number> = {
  mainnet: 14,
  coston2: 114,
  songbird: 19,
  coston: 16,
};

// Token EIP-712 names, cached per token address after first read.
const tokenNameCache = new Map<string, string>();

async function tokenName(config: X402Config): Promise<string> {
  const cached = tokenNameCache.get(config.tokenAddress);
  if (cached) return cached;
  const name = (await getClient(config.network).readContract({
    address: config.tokenAddress,
    abi: TOKEN_ABI,
    functionName: "name",
  })) as string;
  tokenNameCache.set(config.tokenAddress, name);
  return name;
}

// Nonces settled or currently in flight in this process. On-chain
// authorizationState is the durable replay barrier once a settlement lands;
// inFlightNonces closes the synchronous TOCTOU window before the first await.
const settledNonces = new Set<string>();
const inFlightNonces = new Set<string>();

function nonceKey(payload: PaymentPayload): string {
  return `${payload.from.toLowerCase()}:${payload.nonce.toLowerCase()}`;
}

/** Synchronously reserve a nonce before any async settlement work. */
export function reserveNonce(payload: PaymentPayload): boolean {
  const key = nonceKey(payload);
  if (settledNonces.has(key) || inFlightNonces.has(key)) {
    return false;
  }
  inFlightNonces.add(key);
  return true;
}

/** Release an in-flight nonce reservation if settlement fails before landing. */
export function releaseNonce(payload: PaymentPayload): void {
  inFlightNonces.delete(nonceKey(payload));
}

export function priceInUnits(config: X402Config, toolName: string): bigint {
  return parseUnits(priceFor(config, toolName), config.tokenDecimals);
}

export function buildRequirements(
  config: X402Config,
  toolName: string,
  eip712Name?: string,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network,
    asset: config.tokenAddress,
    payTo: config.payTo,
    maxAmountRequired: priceInUnits(config, toolName).toString(),
    resource: `mcp://flario/tools/${toolName}`,
    description: `Payment for one ${toolName} call`,
    maxTimeoutSeconds: 300,
    extra: {
      chainId: CHAIN_IDS[config.network],
      eip712: {
        ...(eip712Name ? { name: eip712Name } : {}),
        version: config.eip712Version,
      },
      standard: "EIP-3009",
    },
  };
}

/**
 * Async variant that embeds the cached EIP-712 token name in `extra.eip712.name`,
 * saving every x402 client an extra `name()` RPC round-trip before signing.
 * Falls back gracefully if the RPC is unreachable.
 */
export async function buildRequirementsAsync(
  config: X402Config,
  toolName: string,
): Promise<PaymentRequirements> {
  let name: string | undefined;
  try {
    name = await tokenName(config);
  } catch {
    // Offline or non-standard RPC: omit name so clients can resolve it themselves.
  }
  return buildRequirements(config, toolName, name);
}

export interface VerifyDeps {
  /** Returns true when the nonce was already used on-chain. */
  nonceUsedOnChain: (from: `0x${string}`, nonce: Hex) => Promise<boolean>;
  /** EIP-712 domain name of the token. */
  tokenName: () => Promise<string>;
  nowSeconds?: () => number;
}

function defaultDeps(config: X402Config): VerifyDeps {
  return {
    nonceUsedOnChain: async (from, nonce) =>
      (await getClient(config.network).readContract({
        address: config.tokenAddress,
        abi: TOKEN_ABI,
        functionName: "authorizationState",
        args: [from, nonce],
      })) as boolean,
    tokenName: () => tokenName(config),
  };
}

/**
 * Verify a payment payload against the requirements for a tool. Checks are
 * local (EIP-712 signature recovery) plus one on-chain nonce lookup; throws
 * with a precise reason on failure.
 */
export async function verifyPayment(
  config: X402Config,
  toolName: string,
  payload: PaymentPayload,
  deps: VerifyDeps = defaultDeps(config),
): Promise<void> {
  const now = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
  const required = priceInUnits(config, toolName);

  if (getAddress(payload.to) !== getAddress(config.payTo)) {
    throw new Error(`payment "to" (${payload.to}) is not the configured payee (${config.payTo})`);
  }
  if (BigInt(payload.value) < required) {
    throw new Error(`payment value ${payload.value} is below the required ${required.toString()}`);
  }
  if (now <= Number(payload.validAfter)) {
    throw new Error("authorization is not valid yet (validAfter in the future)");
  }
  if (now >= Number(payload.validBefore)) {
    throw new Error("authorization has expired (validBefore in the past)");
  }
  const key = nonceKey(payload);
  if (settledNonces.has(key)) {
    throw new Error("this payment authorization was already settled by this server (replay)");
  }
  if (inFlightNonces.has(key)) {
    throw new Error("this payment authorization is already being settled by this server (replay)");
  }

  // Verify EIP-712 signature locally BEFORE any on-chain nonce RPC lookup so
  // unsigned or forged payloads cannot amplify RPC calls.
  const domain = {
    name: await deps.tokenName(),
    version: config.eip712Version,
    chainId: CHAIN_IDS[config.network],
    verifyingContract: config.tokenAddress,
  };
  const valid = await verifyTypedData({
    address: payload.from,
    domain,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: payload.from,
      to: payload.to,
      value: BigInt(payload.value),
      validAfter: BigInt(payload.validAfter),
      validBefore: BigInt(payload.validBefore),
      nonce: payload.nonce,
    },
    signature: { r: payload.r, s: payload.s, v: BigInt(payload.v) },
  });
  if (!valid) {
    throw new Error("EIP-712 signature does not match the payer address");
  }

  if (await deps.nonceUsedOnChain(payload.from, payload.nonce)) {
    throw new Error("this payment authorization nonce was already used on-chain (replay)");
  }
}

export interface SettlementReceipt {
  tx_hash: Hex;
  block_number: string;
  payer: `0x${string}`;
  payee: `0x${string}`;
  amount_units: string;
  token: `0x${string}`;
  network: NetworkType;
}

export interface SettleDeps {
  simulateVrs: (
    args: readonly [`0x${string}`, `0x${string}`, bigint, bigint, bigint, Hex, number, Hex, Hex],
  ) => Promise<unknown>;
  simulatePacked: (
    args: readonly [`0x${string}`, `0x${string}`, bigint, bigint, bigint, Hex, Hex],
  ) => Promise<unknown>;
  writeContract: (request: unknown) => Promise<Hex>;
  waitForReceipt: (
    hash: Hex,
  ) => Promise<{ status: string; blockNumber: bigint; transactionHash: Hex }>;
}

/**
 * Broadcast the client-signed transferWithAuthorization. Tries the canonical
 * (v,r,s) variant first, then the packed-signature variant used by USD₮0.
 *
 * The packed-signature fallback runs ONLY when simulation fails — never after
 * writeContract has already broadcast a transaction.
 */
export async function settlePayment(
  config: X402Config,
  payload: PaymentPayload,
  deps?: SettleDeps,
): Promise<SettlementReceipt> {
  // Synchronously reserve the nonce before the first await to close the TOCTOU window.
  if (!reserveNonce(payload)) {
    throw new Error("this payment authorization was already settled or is already in flight (replay)");
  }

  try {
    let settleOps: SettleDeps;
    if (deps) {
      settleOps = deps;
    } else {
      const signer = getSigner(config.network);
      if (!signer) {
        throw new Error(
          "x402 settlement needs FLARE_PRIVATE_KEY (operator gas key) — the client-signed authorization is broadcast by this server and gas is paid by the operator",
        );
      }
      const client = getClient(config.network);
      settleOps = {
        simulateVrs: async (args) => {
          const { request } = await client.simulateContract({
            address: config.tokenAddress,
            abi: TOKEN_ABI,
            functionName: "transferWithAuthorization",
            args,
            account: signer.account,
          });
          return request;
        },
        simulatePacked: async (args) => {
          const { request } = await client.simulateContract({
            address: config.tokenAddress,
            abi: TOKEN_ABI_BYTES_SIG,
            functionName: "transferWithAuthorization",
            args,
            account: signer.account,
          });
          return request;
        },
        writeContract: (request) =>
          signer.wallet.writeContract(request as Parameters<typeof signer.wallet.writeContract>[0]),
        waitForReceipt: (hash) => client.waitForTransactionReceipt({ hash }),
      };
    }

    const base = {
      from: getAddress(payload.from),
      to: getAddress(payload.to),
      value: BigInt(payload.value),
      validAfter: BigInt(payload.validAfter),
      validBefore: BigInt(payload.validBefore),
      nonce: payload.nonce,
    };

    // Simulate first; only fall back to packed signature on simulation failure.
    let request: unknown;
    try {
      request = await settleOps.simulateVrs([
        base.from,
        base.to,
        base.value,
        base.validAfter,
        base.validBefore,
        base.nonce,
        payload.v,
        payload.r,
        payload.s,
      ]);
    } catch {
      const signature = (payload.r +
        payload.s.slice(2) +
        payload.v.toString(16).padStart(2, "0")) as Hex;
      request = await settleOps.simulatePacked([
        base.from,
        base.to,
        base.value,
        base.validAfter,
        base.validBefore,
        base.nonce,
        signature,
      ]);
    }

    // Broadcast once — never fall back after writeContract has been called.
    const txHash = await settleOps.writeContract(request);

    const receipt = await settleOps.waitForReceipt(txHash);
    if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error(
        `settlement transaction ${txHash} was replaced by ${receipt.transactionHash}; refusing mismatched receipt`,
      );
    }
    if (receipt.status !== "success") {
      throw new Error(`settlement transaction ${txHash} reverted`);
    }

    settledNonces.add(nonceKey(payload));
    inFlightNonces.delete(nonceKey(payload));

    return {
      tx_hash: txHash,
      block_number: receipt.blockNumber.toString(),
      payer: base.from,
      payee: base.to,
      amount_units: payload.value,
      token: config.tokenAddress,
      network: config.network,
    };
  } catch (err) {
    releaseNonce(payload);
    throw err;
  }
}

/** Test-only: reset the in-process replay cache. */
export function resetSettledNonces(): void {
  settledNonces.clear();
  inFlightNonces.clear();
}

/** Test-only: mark a payload settled without broadcasting. */
export function markSettledForTest(payload: PaymentPayload): void {
  settledNonces.add(nonceKey(payload));
}
