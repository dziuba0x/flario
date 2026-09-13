// The single place a flario-receipt/2 is built from a settled x402 payment.
//
// There are two effector paths — the MCP stdio paywall (paywall.ts) and the
// HTTP hub (hub.ts) — and both MUST go through here. They used to build the
// receipt independently, and that is exactly how the DELICTI `mandate_ref`
// ended up bound on the HTTP path and silently dropped on the MCP path: the
// unit tests covered `mandateRefFor` in isolation, so nothing failed. One
// constructor, one gate, no drift.
import type { X402Config } from "./config.js";
import type { PaymentPayload, SettlementReceipt } from "./facilitator.js";
import { mandateRefFor, noteSpend } from "./mandate.js";
import { buildReceipt, type Receipt } from "./receipt.js";

/**
 * Everything that must happen once a payment has settled, in one place so the two effector
 * paths cannot drift apart again: build the receipt, and record the spend on the mandate's
 * running tally. The tally write is fire-and-forget — the funds already moved, so it must not
 * be able to fail the call — but it is not optional in spirit: a tally that falls behind what
 * the FDC can prove is what Bond.challengeUnderReportedSpend convicts.
 */
export function finaliseSettlement(
  config: X402Config,
  payload: PaymentPayload,
  settlement: SettlementReceipt,
  toolId: string,
): Receipt {
  void noteSpend(config.network, payload, settlement.amount_units);
  return receiptFor(config, payload, settlement, toolId);
}

export function receiptFor(
  config: X402Config,
  payload: PaymentPayload,
  settlement: SettlementReceipt,
  toolId: string,
): Receipt {
  return buildReceipt({
    payer: payload.from,
    payee: settlement.payee,
    amount: settlement.amount_units,
    asset: settlement.token,
    network: settlement.network,
    toolId,
    settlementTxHash: settlement.tx_hash,
    commitmentSalt: payload.commitment_salt,
    // Witness 1 is only a DELICTI leaf if it names the mandate it acted under.
    mandateRef: mandateRefFor(config.network, payload),
  });
}
