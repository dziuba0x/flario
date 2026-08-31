// End-to-end x402 demo: an MCP client (the "agent") calls a paid tool over
// stdio, receives payment requirements, signs an EIP-3009 authorization
// off-chain, retries with the payment attached, and prints the result with
// the on-chain settlement tx hash.
//
// The server (spawned below) is the facilitator+seller; it needs:
//   X402_ENABLED=true  X402_NETWORK=coston2  X402_PAY_TO=<payee address>
//   FLARE_PRIVATE_KEY=<operator key with C2FLR for gas>
// The client (this script) needs:
//   X402_CLIENT_PRIVATE_KEY=<payer key holding the payment token on Coston2>
//
// Run: npm run build && npx tsx scripts/x402-demo-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "viem";
import { EIP3009_TYPES } from "../src/x402/facilitator.js";

const PAID_TOOL = "fassets_liquidation_scanner";
const TOOL_ARGS = { asset: "FXRP", network: "coston2" };

const clientKey = process.env.X402_CLIENT_PRIVATE_KEY;
if (!clientKey || !/^0x[0-9a-fA-F]{64}$/.test(clientKey)) {
  process.stderr.write("Set X402_CLIENT_PRIVATE_KEY (payer key holding the payment token on Coston2).\n");
  process.exit(1);
}
const payer = privateKeyToAccount(clientKey as `0x${string}`);

const operatorKey = process.env.FLARE_PRIVATE_KEY;
const payTo = process.env.X402_PAY_TO;
if (!operatorKey || !payTo) {
  process.stderr.write("Set FLARE_PRIVATE_KEY (operator gas key) and X402_PAY_TO (payee) for the server.\n");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env as Record<string, string>,
    X402_ENABLED: "true",
    X402_NETWORK: process.env.X402_NETWORK ?? "coston2",
    X402_PAY_TO: payTo,
    FLARE_PRIVATE_KEY: operatorKey,
  },
});
const client = new Client({ name: "x402-demo-agent", version: "0.1.0" });
await client.connect(transport);
process.stdout.write(`agent: connected to flario, payer = ${payer.address}\n\n`);

// 1. Call the paid tool with no payment → expect x402 requirements.
process.stdout.write(`agent: calling ${PAID_TOOL} (unpaid)...\n`);
const first = await client.callTool({ name: PAID_TOOL, arguments: TOOL_ARGS });
const firstBody = JSON.parse((first.content as Array<{ text: string }>)[0].text) as {
  x402_payment_required?: boolean;
  accepts?: Array<{
    asset: `0x${string}`;
    payTo: `0x${string}`;
    maxAmountRequired: string;
    network: string;
    extra: { chainId: number; eip712: { version: string } };
  }>;
};
if (!firstBody.x402_payment_required || !firstBody.accepts?.[0]) {
  process.stdout.write("No payment required (x402 disabled?) — result received for free:\n");
  process.stdout.write((first.content as Array<{ text: string }>)[0].text.slice(0, 400) + "\n");
  process.exit(0);
}
const req = firstBody.accepts[0];
process.stdout.write(`server: 402 — ${req.maxAmountRequired} units of ${req.asset} to ${req.payTo}\n\n`);

// 2. Sign the EIP-3009 authorization off-chain (gasless for the payer).
//    The EIP-712 domain name must match the token contract's name().
const tokenNameAbi = [{ name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;
const { getClient } = await import("../src/utils/rpc.js");
const tokenName = (await getClient(req.network as never).readContract({
  address: req.asset,
  abi: tokenNameAbi,
  functionName: "name",
})) as string;

const now = Math.floor(Date.now() / 1000);
const message = {
  from: payer.address,
  to: req.payTo,
  value: BigInt(req.maxAmountRequired),
  validAfter: BigInt(now - 60),
  validBefore: BigInt(now + 300),
  nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
};
const signature = await payer.signTypedData({
  domain: {
    name: tokenName,
    version: req.extra.eip712.version,
    chainId: req.extra.chainId,
    verifyingContract: req.asset,
  },
  types: EIP3009_TYPES,
  primaryType: "TransferWithAuthorization",
  message,
});
const payload = {
  from: message.from,
  to: message.to,
  value: message.value.toString(),
  validAfter: message.validAfter.toString(),
  validBefore: message.validBefore.toString(),
  nonce: message.nonce,
  v: parseInt(signature.slice(130, 132), 16),
  r: signature.slice(0, 66),
  s: `0x${signature.slice(66, 130)}`,
};
process.stdout.write("agent: signed EIP-3009 authorization off-chain (no gas spent by payer)\n");

// 3. Retry with the payment attached.
process.stdout.write(`agent: retrying ${PAID_TOOL} with x402_payment...\n\n`);
const second = await client.callTool({
  name: PAID_TOOL,
  arguments: {
    ...TOOL_ARGS,
    x402_payment: Buffer.from(JSON.stringify(payload)).toString("base64"),
  },
});
const secondText = (second.content as Array<{ text: string }>)[0].text;
const secondBody = JSON.parse(secondText) as {
  x402_error?: string;
  x402_payment_receipt?: { tx_hash: string; block_number: string };
  agents_scanned?: number;
};
if (secondBody.x402_error) {
  process.stdout.write(`FAILED: ${secondBody.x402_error}\n`);
  process.exit(1);
}
process.stdout.write("=== PAID RESULT ===\n");
process.stdout.write(secondText.slice(0, 600) + "\n...\n\n");
process.stdout.write(`settlement tx: ${secondBody.x402_payment_receipt?.tx_hash}\n`);
process.stdout.write(`explorer:      https://coston2-explorer.flare.network/tx/${secondBody.x402_payment_receipt?.tx_hash}\n`);
await client.close();
