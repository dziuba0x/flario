// Runtime posture: who can reach this process, and therefore what it may do.
//
// Flario runs in two very different trust settings:
//
//   stdio  - a local process started by YOUR MCP client. The only caller is
//            you, so spending your own gas on an attestation request is
//            exactly what you asked for.
//   hub    - an HTTP service that may be reachable by anonymous callers. Here
//            an operator key exists for a different reason (settling x402
//            payments), and letting any caller trigger an on-chain attestation
//            request would let a stranger drain the operator's gas and fees.
//
// So on-chain submission is allowed by default in stdio mode and DENIED by
// default in hub mode. A hub operator who really wants it can opt in with
// FLARIO_HUB_ALLOW_SUBMIT=true.
let hubMode = false;

export function setHubMode(enabled: boolean): void {
  hubMode = enabled;
}

export function isHubMode(): boolean {
  return hubMode;
}

/** True when a tool may spend the operator key on an on-chain submission. */
export function isSubmitAllowed(): boolean {
  if (!hubMode) {
    return true;
  }
  return process.env.FLARIO_HUB_ALLOW_SUBMIT === "true";
}

/** Why submission was refused, for a precise, actionable tool error. */
export const SUBMIT_BLOCKED_REASON =
  "Refusing to submit an on-chain attestation request from hub (HTTP) mode: any caller could spend the operator's gas and request fees. The prepared request is returned instead, so you can submit it with your own signer. A hub operator who intends to pay for submissions can set FLARIO_HUB_ALLOW_SUBMIT=true.";
