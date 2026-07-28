# STATE.md — Flario / Agent Settlement Layer on Flare

Running project state, updated per session so any future session/model resumes
with zero context loss. Handoff brief: `~/Downloads/claude-code-handoff-prompt.md`.

Last updated: 2026-07-21 (session: audit + receipts + FDC-settlement + rebrand to
Flario, model handoff Fable 5 → Opus 4.8).

**NAME:** project rebranded `@dziuba0x/flare-mcp` → **Flario** (npm `flario`, repo
github.com/dziuba0x/flario, command `npx flario`). Same code, own brand. See
DECISIONS §11. "Flare"/"MCP" kept in tagline+keywords for discovery.

## Snapshot

- Package: **`flario` v1.3.0** on npm (bare name); repo public at
  github.com/dziuba0x/flario; git tree clean.
- Tests: 90 passing (vitest, recorded fixtures + hub integration). `npm test` green.
- Tools: 21 (19 free + 2 premium). Transports: stdio (default) and hub mode
  (`--http`, MCP Streamable HTTP + spec-style x402 REST).
- Strategy: EDGE path (be THE complete Flare MCP), then the proof-carrying moat.
  P1 DONE (proof-carrying FTSO anchor feeds + fixed history, DECISIONS 12).
  P2 DONE (`get_flr_stake_info` portfolio + `fassets_agent_details`).
  P3 DONE (README as a landing page, human voice, no AI tells).
  FLAGSHIP DONE: Web2Json (`fdc_web2json_request` + `fdc_verify_web2json`),
  which turns any public web API into a contract-verifiable fact and BINDS the
  proof to an expected source (DECISIONS 13). Plus a real security fix: hub mode
  no longer lets anonymous callers spend the operator key (DECISIONS 14).
- Architecture decision (operator, 2026-07-21): everything "an agent doing
  something with Flare" lives in Flario as more tools, including FCC when it
  lands. Passport/reputation and marketplace stay separate future projects built
  on Flario's receipts. Do not fragment the brand.
- FCC watch: `songbird_fcc_registry` reports 0 FCC contracts on all four
  networks as of 2026-07-21, but flare-foundation is actively pushing
  `tee-proxy`, `tee-node`, `fce-extension-scaffold`. When contracts appear
  on-chain, being first with an agent interface to FCC is the next big move.
- Live-verified on-chain (Coston2): FDC full cycle (own attestation, round
  1397964), x402 settlement over MCP (tx 0x19eb…a7dd) and over HTTP
  (tx 0xf230…cab2, replay rejected).

## Phase 1 — enshrined-stack coverage: DONE

| Tool | Status |
| --- | --- |
| `fdc_request_attestation` | Done; live-submitted to FdcHub (Coston2). |
| `fdc_get_attestation_proof` | Done; **local** Merkle verify vs on-chain Relay root. |
| `fassets_agent_status` | Done; mainnet/Coston2/Songbird. |
| `fassets_system_state` | Done. |
| `songbird_fcc_registry` | Done as a **watcher**: FCC not yet publicly addressable per docs; reports status, lights up when contracts register. |

Networks: mainnet(14), Coston2(114), Songbird(19), Coston(16). ABIs from official
`@flarenetwork/flare-periphery-contract-artifacts`. Addresses via ContractRegistry
at runtime (never hardcoded).

## Phase 2 — x402 payment layer: PARTIAL

Done:
- `src/x402/` (config, facilitator, paywall) — EIP-3009 `transferWithAuthorization`
  settlement; verify EIP-712 signature locally + on-chain nonce check; never holds
  funds (operator key only pays gas to broadcast the client-signed authorization).
- Premium tools: `fassets_liquidation_scanner` (FAssets × live FTSO), `fdc_bulk_proof_bundle`.
- Replay protection: on-chain EIP-3009 nonce (`authorizationState`) + in-process
  settled-nonce set.
- Payment-token gate resolved on-chain: mainnet USD₮0 has EIP-3009; Coston2 demo
  uses deployed MockUSDT0 (0x3c71…D176). Details in DECISIONS §8a–8d.

## Hub mode (v0.4.0): DONE

`POST /mcp` (stateless MCP Streamable HTTP, all 15 tools) + REST premium endpoints
with real HTTP 402 / `X-Payment` / `X-Payment-Response`. Dockerfile included.
Binds 127.0.0.1 by default; `FLARE_MCP_HTTP_HOST=0.0.0.0` to expose.

---

## GAPS vs the handoff brief (this is the work ahead)

### G1 — ZK-ready receipt (Principle 3). **DONE (2026-07-21), organ 3 shipped.**
Built `src/x402/receipt.ts` + `RECEIPT_SPEC.md`. Receipt `x402_receipt` emitted
on both transports (additive; `x402_payment_receipt` unchanged). Payer only as a
Poseidon/BN254 commitment (operator chose Poseidon — DECISIONS §8e), optional
`commitment_salt` blinding, keccak256 `receipt_hash` tamper-evidence,
`fdc_attestation_ref` reserved (null until G2). 12 unit tests + live-verified
end-to-end on Coston2 (settlement tx 0xb380…9184). Honest privacy caveat
documented (EIP-3009 exposes payer on-chain; commitment is forward-looking).
Not yet published to npm (pending operator: publish now vs batch with G2).

### G2 — FDC-verified settlement (Principle 4). **DONE (2026-07-21), the differentiator.**
New tool `fdc_verify_settlement` (`src/tools/fdc-settlement.ts`): FDC
**EVMTransaction** attestation over the settlement tx (corrected from the
handoff's "Payment" — that's BTC/DOGE/XRP only; DECISIONS §10), locally
Merkle-verified, then **bound** to the payment (attested tx must contain an
ERC-20 `Transfer` of the asset → payee for ≥ amount). `attachFdcRef` upgrades a
receipt to its FDC-verified form. Tool never submits on-chain (anti-gas-grief).
10 unit tests (binding security core + attachFdcRef). Live end-to-end on
Coston2: pending final confirmation of the running background test (submit →
finalize → verify+bind, incl. rejection of wrong amount/payee/asset).

### G3 — README lacks explicit complementary positioning (Phase 1 criterion).
No mention of the official docs-MCP (dev.flare.network/mcp) or the framing
"they give agents knowledge; we give agents hands and a wallet." Cheap to fix.

### G4 — Principle 2 (no central behavioral DB): currently SATISFIED, keep it so.
`settledNonces` is in-memory only, ephemeral, holds `payer:nonce` pairs for
replay defense. Must **never** be persisted per-payer to a server we control. The
durable replay barrier is the on-chain `authorizationState`; a hosted hub across
restarts must rely on-chain, not build a per-payer nonce DB.

### G5 — Principle 5 (private-until-release): SATISFIED/moot.
Repo went public post-v2 release, which is what the principle prescribes.

## Proposed shortest path (my recommendation)

1. **Receipt schema + `RECEIPT_SPEC.md`** (G1) — **DONE**.
2. **FDC-verified settlement path** (G2) — **NEXT**. The differentiator; composes
   the already-verified FDC tools; populates `fdc_attestation_ref`. Security-
   critical. Open sub-decision D2 below (anchoring) resolves here.
3. **README positioning + docs** (G3) — **DONE** (complementary framing + receipt).

## Open decisions for the operator (flagged, not guessed — Principles 3 & 6)

- **D1 (crypto):** commitment primitive — **RESOLVED**: operator chose Poseidon
  (DECISIONS §8e). Self-describing schemes keep it upgradeable.
- **D2 (economics, for the FDC path):** an on-chain receipt-hash anchor contract
  would add one tx per call — doubles gas on fraction-of-a-cent pricing.
  Recommendation: defer; use settlement tx hash + FDC attestation as the anchor.
  Confirm when building G2.
- **D3 (Principle 6):** production revenue address — operator provides later;
  until then payment flows target the `.env` placeholder on testnet.
- **D4 (release):** publish receipt layer now as 0.5.0, or batch with the
  FDC-verified path (G2) into one 0.5.0? Recommendation: batch, so the headline
  differentiator ships with the receipt that carries it — but priority is already
  timestamped in git/GitHub.

## Out of scope (do NOT build): ZK circuits, agent passport, reputation,
marketplace, public third-party facilitator, FCE, any UI beyond README/demo.
Design formats to be ready for them; do not build them.
