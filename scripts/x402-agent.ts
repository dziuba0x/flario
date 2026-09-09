// x402 agent driver: makes N paid MCP calls against a real flario server over
// stdio, each carrying a DELICTI `mandate_id`, and writes the server's own
// `flario-receipt/2` for each one. This is witness 1 coming out of an actual
// effector process — not a receipt hand-built in a one-liner.
//
// Server env (inherited by the spawned process, set these before running):
//   X402_ENABLED=true X402_NETWORK=coston2 X402_PAY_TO=<payee>
//   X402_TOKEN_ADDRESS=<MockUSDT0>  X402_PRICE_DEFAULT=<whole tokens per call>
//   FLARE_PRIVATE_KEY=<operator/facilitator key, pays gas>
//   DELICTI_REGISTRY=<MandateRegistry>  [DELICTI_REQUIRE_MANDATE=1]
// Client env:
//   X402_CLIENT_PRIVATE_KEY=<payer key = the mandated agent>
//   MANDATE_ID=<id | "" to send no mandate>   N=<calls, default 1>
//   EXPECT_REFUSAL=1 → the run PASSES only if every call is refused (brake test)
//   OUT_DIR=<dir for receipt JSON, default ./x402-out>
//
// Run: npm run build && npx tsx scripts/x402-agent.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "viem";
import { EIP3009_TYPES } from "../src/x402/facilitator.js";

const PAID_TOOL = process.env.PAID_TOOL ?? "fassets_liquidation_scanner";
const NETWORK = process.env.X402_NETWORK ?? "coston2";
const TOOL_ARGS = JSON.parse(
  process.env.TOOL_ARGS_JSON ?? JSON.stringify({ asset: "FXRP", network: NETWORK }),
) as Record<string, unknown>;
const N = Number(process.env.N ?? "1");
const OUT_DIR = process.env.OUT_DIR ?? "./x402-out";
const MANDATE_ID = process.env.MANDATE_ID ?? "";

const clientKey = process.env.X402_CLIENT_PRIVATE_KEY;
if (!clientKey || !/^0x[0-9a-fA-F]{64}$/.test(clientKey)) {
  process.stderr.write("Set X402_CLIENT_PRIVATE_KEY (payer key = the mandated agent).\n");
  process.exit(1);
}
const payer = privateKeyToAccount(clientKey as `0x${string}`);
if (!process.env.FLARE_PRIVATE_KEY || !process.env.X402_PAY_TO) {
  process.stderr.write("Set FLARE_PRIVATE_KEY (operator gas key) and X402_PAY_TO (payee).\n");
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...(process.env as Record<string, string>), X402_ENABLED: "true" },
});
const client = new Client({ name: "delicti-x402-agent", version: "0.1.0" });
await client.connect(transport);
process.stdout.write(`agent ${payer.address} → flario (mandate ${MANDATE_ID || "NONE"}), ${N} paid call(s)\n`);

function body(res: unknown): Record<string, unknown> {
  const text = (res as { content: Array<{ text: string }> }).content[0].text;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

// 1. Unpaid call → payment requirements.
const first = body(await client.callTool({ name: PAID_TOOL, arguments: TOOL_ARGS }));
const req = (first.accepts as
  | Array<{
      asset: `0x${string}`;
      payTo: `0x${string}`;
      maxAmountRequired: string;
      network: string;
      extra: { chainId: number; eip712: { version: string } };
    }>
  | undefined)?.[0];
if (!req) {
  // Print what the server actually said: an argument-validation error from the
  // tool looks identical to "x402 disabled" if you only check for `accepts`.
  process.stderr.write(
    `server did not ask for payment. Check X402_ENABLED/X402_PAY_TO and the tool args (PAID_TOOL/TOOL_ARGS_JSON).\nserver said: ${JSON.stringify(first).slice(0, 600)}\n`,
  );
  process.exit(1);
}
const { getClient } = await import("../src/utils/rpc.js");
const tokenName = (await getClient(req.network as never).readContract({
  address: req.asset,
  abi: [{ name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const,
  functionName: "name",
})) as string;
process.stdout.write(`server: 402 — ${req.maxAmountRequired} units of ${req.asset} (${tokenName}) to ${req.payTo}\n`);

let failures = 0;
for (let i = 0; i < N; i++) {
  const now = Math.floor(Date.now() / 1000);
  const message = {
    from: payer.address,
    to: req.payTo,
    value: BigInt(req.maxAmountRequired),
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + 3600),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await payer.signTypedData({
    domain: { name: tokenName, version: req.extra.eip712.version, chainId: req.extra.chainId, verifyingContract: req.asset },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });
  const payload: Record<string, string | number> = {
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
  // The mandate the agent claims to be acting under. Not part of the EIP-712
  // authorization: a wrong mandate can never move funds, only get the deed
  // refused now or proven false later.
  if (MANDATE_ID) payload.mandate_id = MANDATE_ID;

  const out = body(
    await client.callTool({
      name: PAID_TOOL,
      arguments: { ...TOOL_ARGS, x402_payment: Buffer.from(JSON.stringify(payload)).toString("base64") },
    }),
  );
  if (out.x402_error) {
    failures++;
    process.stdout.write(`  call ${i}: REFUSED — ${String(out.x402_error)}\n`);
    writeFileSync(join(OUT_DIR, `refusal${i}.json`), JSON.stringify(out, null, 2));
    continue;
  }
  const settlement = out.x402_payment_receipt as { tx_hash: string } | undefined;
  const receipt = out.x402_receipt as { receipt_hash: string; mandate_ref: unknown } | undefined;
  if (!receipt || !settlement) {
    failures++;
    process.stdout.write(`  call ${i}: no receipt in result — ${JSON.stringify(out).slice(0, 200)}\n`);
    continue;
  }
  writeFileSync(join(OUT_DIR, `receipt${i}.json`), JSON.stringify(receipt, null, 2));
  process.stdout.write(
    `  call ${i}: paid tx=${settlement.tx_hash} receipt=${receipt.receipt_hash.slice(0, 14)} mandate_ref=${
      receipt.mandate_ref ? "yes" : "NULL"
    } → ${join(OUT_DIR, `receipt${i}.json`)}\n`,
  );
}
await client.close();
// EXPECT_REFUSAL=1 inverts the verdict: the brake test wants every call refused.
const expectRefusal = process.env.EXPECT_REFUSAL === "1";
const ok = expectRefusal ? failures === N : failures === 0;
process.stdout.write(
  `done: ${N - failures}/${N} paid, ${failures} refused, receipts in ${OUT_DIR} — ${ok ? "PASS" : "FAIL"}\n`,
);
process.exit(ok ? 0 : 1);
