# CLAUDE.md: Flario project brief

Short brief for any session working on this repo. It describes the project as it
actually is today, verified against the code. It is deliberately not a catalogue
of the 21 tools; that lives in README.md.

Companion documents:

- **STATE.md**: where the project stands right now, and what is verified vs merely exposed
- **DECISIONS.md**: why things are the way they are, including corrections and open questions
- **RECEIPT_SPEC.md**: the versioned contract for the x402 settlement receipt

> This file was rewritten on 2026-07-21 because the previous version still
> described the v0.1.0 project (read-only, stdio-only, package `flare-mcp`). Those
> rules are no longer true and following them would break working features. See
> "Rules that changed" below.

---

## 1. What Flario is

**Flario** is an MCP (Model Context Protocol) server for **Flare Network**. It gives
an AI agent plain-language access to Flare's enshrined protocols (FTSO, FDC,
FAssets), and it gives that agent a wallet: premium tools are paid per call with
x402 settled on Flare, and every payment returns a receipt the chain itself can
prove.

- npm package: **`flario`** (bare name, unscoped)
- command: **`npx flario`**, bin name `flario`
- repo: **github.com/dziuba0x/flario**
- MCP server name reported to clients: `flario`
- author: Dziuba Technology / Alan Dziuba

Positioning: complementary to Flare's official MCP server. Theirs does docs search
and gives an agent knowledge; Flario calls the protocols and gives an agent hands
and a wallet.

## 2. State today (v1.3.0)

- **21 tools**: 19 free, 2 premium (`fassets_liquidation_scanner`,
  `fdc_bulk_proof_bundle`, both wrapped with `withX402` in `src/tools/premium.ts`).
  Premium tools run free unless the operator sets `X402_ENABLED=true`.
- **90 tests** passing (`npm test`, vitest, recorded fixtures plus hub integration).
- **Two transports**: stdio (default) and hub mode (`--http [port]`, or
  `FLARIO_HTTP_PORT`), which serves MCP over Streamable HTTP at `POST /mcp` plus
  x402-paid REST endpoints.
- **Four networks**: Flare mainnet (14), Coston2 (114), Songbird (19), Coston (16).

## 3. Architecture

```
src/
  index.ts              entry point; picks stdio or hub mode
  server.ts             buildServer(): registers every tool and resource
  hub.ts                HTTP hub: POST /mcp, x402 REST endpoints, discovery, healthz
  tools/                one module per protocol area
    wallet.ts, stake.ts            balances, delegation, vote power, rewards
    ftso.ts                        FTSO feeds, anchor feeds (proof-carrying), history
    fassets.ts, fassets-v2.ts      FAssets status, agents, system state, agent identity
    fdc.ts, fdc-v2.ts              FDC proof status, attestation request, proof verify
    fdc-settlement.ts              FDC-verified x402 settlement (verify AND bind)
    web2json.ts                    Web2Json request + verify with source binding
    fcc.ts                         Flare Confidential Compute registry watcher
    premium.ts                     the two x402-gated tools
    smart-accounts.ts              XRPL to Flare account resolution
  x402/                 the entire payment layer, isolated so it can be replaced
    config.ts           env-driven config; returns null when disabled
    facilitator.ts      EIP-3009 verify and settle; never holds funds
    paywall.ts          withX402 wrapper: 402 requirements, payment arg, receipt
    receipt.ts          the ZK-ready receipt (see RECEIPT_SPEC.md)
  utils/
    rpc.ts              viem clients per network, optional local signer
    contracts.ts        ContractRegistry lookups, official ABIs
    fdc.ts              FDC helpers: verifier, DA layer, Merkle fold
    ftso-da.ts          FTSO anchor feeds over the DA layer
    runtime.ts          stdio vs hub posture; gates on-chain submission
  resources/network.ts  MCP resources (feed list, contract registry info)
```

## 4. Rules that still apply

1. **No custody, ever.** No tool may hold, forward, or gain signing authority over
   user funds. x402 settlement moves tokens directly payer to payee inside
   `transferWithAuthorization`; the operator key only pays gas to broadcast an
   authorization the client already signed.
2. **Private keys sign locally and are never logged or transmitted.**
   `FLARE_PRIVATE_KEY` is read from the environment, used in-process, and leaves
   only as an already-signed transaction to the configured RPC.
3. **viem, not ethers.js.**
4. **zod validation on every tool input.** No exceptions.
5. **Contract ABIs come from `@flarenetwork/flare-periphery-contract-artifacts`**
   (`interfaceToAbi`), and addresses resolve at runtime through the
   `ContractRegistry`. Never hardcode an address. Every protocol constant cites its
   Flare doc URL in a comment.
6. **No `console.log`.** stdout belongs to the MCP protocol. Logs go to stderr.
7. **No central behavioural database, ever.** `settledNonces` is in-memory only and
   must never be persisted per payer. The durable replay barrier is the on-chain
   EIP-3009 `authorizationState`.
8. **Every tool handles RPC failure** and returns a clear error rather than throwing.
9. **Verify, then bind.** A valid Merkle proof is necessary but never sufficient.
   Tools that consume proofs must also bind them to the thing the caller cared
   about (the actual ERC-20 transfer, the expected source URL). This is the
   project's signature pattern.
10. **Do not guess on anything financial or cryptographic.** Resolve it empirically
    against the live network or the official docs, or flag it in DECISIONS.md.

## 5. Rules that changed (v0.1.0 to today)

| Old rule | Why it changed | Rule today |
| --- | --- | --- |
| "READ-ONLY, no transactions, no private keys" | v2 needs FDC attestation requests, and x402 has to settle on-chain | Writes are **opt-in**. Without `FLARE_PRIVATE_KEY` every tool is read-only and attestation tools return a prepared request. With a key, only attestation requests and x402 settlement may spend. Custody is still forbidden. |
| "stdio transport only, do not implement HTTP/SSE" | Hosting the server for agents requires a network transport | stdio **and** hub mode (Streamable HTTP). Both are supported and tested. |
| npm name `flare-mcp`, repo `[USERNAME]/flare-mcp` | The bare name was taken, and a generic name cannot be owned | npm `flario`, repo `dziuba0x/flario`. See DECISIONS 11. |
| Two networks (mainnet, Coston2) | Protocol work needs the canary chains | Four networks: mainnet, Coston2, Songbird, Coston. |
| The v1 tool catalogue (8 tools) | Superseded | 21 tools; see README.md. |

## 6. Security posture

- **stdio vs hub is a trust boundary.** In stdio mode the only caller is the person
  who launched the process, so spending their own gas is what they asked for. In hub
  mode anyone who can reach the port is a caller, and the operator key exists to
  settle x402 payments.
- Therefore **on-chain attestation submission is disabled by default in hub mode**
  (`src/utils/runtime.ts`). It returns the prepared request instead. An operator who
  intends to pay for callers' requests sets `FLARIO_HUB_ALLOW_SUBMIT=true`. See
  DECISIONS 14.
- **`fdc_verify_settlement` never submits a transaction at all**, by design. The
  attestation request is permissionless, so the holder submits it with their own
  key. That removes any gas-griefing surface from the verification path.
- **Mainnet x402 is behind a second flag** (`X402_ALLOW_MAINNET=true`) on top of
  `X402_ENABLED`.
- Secrets live only in `.env` (gitignored). `.env.example` documents every variable.

## 7. Working rules for a session

- Verify facts against the code and the live network before writing them down.
- Before touching FDC, FTSO or FAssets behaviour, read the relevant page under
  `dev.flare.network` (append `.md` to any docs URL for the machine-readable form;
  the index is at `dev.flare.network/llms.txt`).
- Tests accompany every tool. Recorded fixtures live in `test/fixtures/`.
  Live checks: `npx tsx scripts/live-check.ts`.
- Keep STATE.md current at the end of a session so the next one resumes cleanly.
- Public-facing text (README, npm and GitHub descriptions) is written in a plain
  human voice, without em-dashes or other stylistic tells.

## 8. Out of scope

ZK circuits, the agent passport, reputation systems, a marketplace, a public
facilitator service for third parties, and FCE implementations. Design data formats
so those remain possible later, but do not build them here. FCC tooling belongs in
Flario when the contracts become publicly addressable; passport and marketplace do
not.
