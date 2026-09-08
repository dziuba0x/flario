// x402-for-MCP adapter. HTTP has status 402 and the X-Payment header; MCP
// over stdio has neither, so the mapping is:
//
//   - call a paid tool without payment  → result contains
//     { x402_payment_required: true, accepts: [PaymentRequirements] }
//   - client signs the EIP-3009 authorization off-chain and retries the SAME
//     call with the extra argument `x402_payment` = base64(JSON PaymentPayload)
//     (the same encoding the HTTP X-Payment header uses)
//   - server verifies + settles, runs the tool, and attaches
//     { x402_payment_receipt } with the settlement tx hash to the result.
//
// With X402_ENABLED unset the wrapper is a passthrough and paid tools are free.
import { z } from "zod";
import { loadX402Config } from "./config.js";
import {
  buildRequirements,
  verifyPayment,
  settlePayment,
  type PaymentPayload,
} from "./facilitator.js";
import { buildReceipt } from "./receipt.js";
import { checkMandate, mandateRefFor } from "./mandate.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

export const x402PaymentInput = {
  x402_payment: z
    .string()
    .optional()
    .describe(
      "x402 payment: base64-encoded JSON EIP-3009 authorization payload. Omit to receive payment requirements.",
    ),
};

function textResult(data: unknown, isError = false): ToolResult {
  return {
    ...(isError ? { isError } : {}),
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function decodePayload(b64: string): PaymentPayload {
  const json = Buffer.from(b64, "base64").toString("utf8");
  const raw = JSON.parse(json) as Record<string, unknown>;
  const required = ["from", "to", "value", "validAfter", "validBefore", "nonce", "v", "r", "s"];
  for (const field of required) {
    if (!(field in raw)) {
      throw new Error(`x402 payment payload is missing "${field}"`);
    }
  }
  return {
    from: String(raw.from) as PaymentPayload["from"],
    to: String(raw.to) as PaymentPayload["to"],
    value: String(raw.value),
    validAfter: String(raw.validAfter),
    validBefore: String(raw.validBefore),
    nonce: String(raw.nonce) as PaymentPayload["nonce"],
    v: Number(raw.v),
    r: String(raw.r) as PaymentPayload["r"],
    s: String(raw.s) as PaymentPayload["s"],
    ...(raw.commitment_salt !== undefined
      ? { commitment_salt: String(raw.commitment_salt) }
      : {}),
    ...(raw.mandate_id !== undefined ? { mandate_id: String(raw.mandate_id) } : {}),
    ...(raw.mandate_registry !== undefined
      ? { mandate_registry: String(raw.mandate_registry) as `0x${string}` }
      : {}),
  };
}

/**
 * Wrap a tool handler with the x402 paywall. The handler's own args are
 * passed through minus `x402_payment`.
 */
export function withX402<T>(
  toolName: string,
  handler: (args: T) => Promise<ToolResult>,
): (args: T & { x402_payment?: string }) => Promise<ToolResult> {
  return async (args: T & { x402_payment?: string }): Promise<ToolResult> => {
    const { x402_payment, ...restSpread } = args;
    // Removing the paywall-only key cannot change the handler's own arg type.
    const rest = restSpread as unknown as T;
    const config = loadX402Config();

    if (!config) {
      return handler(rest);
    }

    if (!x402_payment) {
      return textResult({
        x402_payment_required: true,
        x402Version: 1,
        accepts: [buildRequirements(config, toolName)],
        how_to_pay:
          "Sign an EIP-712 TransferWithAuthorization (EIP-3009) for the token/payee/amount in `accepts[0]` with a random bytes32 nonce and a ~5 min validity window. Base64-encode the JSON payload {from,to,value,validAfter,validBefore,nonce,v,r,s} and retry this call with it as `x402_payment`.",
      });
    }

    let payload: PaymentPayload;
    try {
      payload = decodePayload(x402_payment);
    } catch (err) {
      return textResult(
        { x402_error: `invalid x402_payment: ${err instanceof Error ? err.message : String(err)}` },
        true,
      );
    }

    try {
      await verifyPayment(config, toolName, payload);
    } catch (err) {
      return textResult(
        {
          x402_error: `payment verification failed: ${err instanceof Error ? err.message : String(err)}`,
          accepts: [buildRequirements(config, toolName)],
        },
        true,
      );
    }

    // Settle BEFORE running the tool: a paid call is only released once the
    // transfer is final on-chain (the settlement result carries the tx hash).
    // DELICTI gate (optional): the effector is the final common pathway — a deed
    // without a live mandate is "a muscle moving with no signal". Refuse before
    // any funds move.
    const gate = await checkMandate(config.network, payload);
    if (!gate.ok) {
      return textResult({ x402_error: gate.reason, delicti: gate }, true);
    }
    let receipt;
    try {
      receipt = await settlePayment(config, payload);
    } catch (err) {
      return textResult(
        { x402_error: `payment settlement failed: ${err instanceof Error ? err.message : String(err)}` },
        true,
      );
    }

    // ZK-ready, shareable receipt (payer only as a commitment); see receipt.ts.
    const zkReceipt = buildReceipt({
      payer: payload.from,
      payee: receipt.payee,
      amount: receipt.amount_units,
      asset: receipt.token,
      network: receipt.network,
      toolId: toolName,
      settlementTxHash: receipt.tx_hash,
      commitmentSalt: payload.commitment_salt,
    });

    const result = await handler(rest);
    if (result.isError) {
      return result;
    }
    // Attach both the settlement summary (payer's own record) and the
    // canonical shareable receipt to the (JSON) tool output.
    try {
      const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
      body.x402_payment_receipt = receipt;
      body.x402_receipt = zkReceipt;
      return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
    } catch {
      return {
        content: [
          ...result.content,
          {
            type: "text",
            text: JSON.stringify(
              { x402_payment_receipt: receipt, x402_receipt: zkReceipt },
              null,
              2,
            ),
          },
        ],
      };
    }
  };
}
