# Changelog

## 1.5.0 (2026-08-31): evidence bundles — attestation of the fact

Everything before this verified a fact at the moment you asked, and then the
verification evaporated into a sentence nobody could re-check. This release
makes a verified fact into something you can hand to someone else.

- **`evidence_bundle`** packages FTSO Scaling anchor feeds and finalized FDC
  attestations (Web2Json included) into one portable object carrying each
  fact's Merkle proof, voting round, protocol id and the Relay address. Every
  fact is folded against the on-chain root *before* inclusion; a fact that
  fails is refused rather than flagged, and a Web2Json fact without
  `expect_source` is refused too, since an unbound proof attests to whatever
  URL sits inside it.

- **`evidence_verify`** is the receiving end. It rebuilds every leaf from its
  own body, folds it through its proof, and compares against
  `Relay.merkleRoots(protocol, round)` read on-chain at verification time. It
  re-binds Web2Json facts to the source recorded in the bundle. Nothing in the
  bundle is trusted, including its own hash.

- **`bundle_hash` is documented as tamper-evidence, not a signature.** Verified
  live on mainnet: an attacker who triples a price *and* recomputes the hash
  still fails verification, because the proof no longer folds to a root the
  validators signed. The hash catches accidents; consensus catches attackers.
  Claiming otherwise would have been security theatre.

- **New prompt `prove_what_you_acted_on`** walks through building a bundle,
  verifying it, then forging it two ways and watching both get caught — and
  ends by stating plainly what a bundle does *not* prove.

- Scope is stated narrowly on purpose: a bundle proves that these specific
  facts were true in these rounds. Not that the agent was honest about its
  reasoning, not that these were the only facts it saw. This is a different
  claim from attesting that a server executed correctly, which still requires
  trusting the operator or their hardware.

- 23 tools, 6 prompts, 2 resources; 103 tests.

## 1.4.1 (2026-08-31): registry ownership metadata

- **`mcpName` in package.json.** The MCP Registry verifies that a server's
  metadata matches its published package by reading an `mcpName` property out
  of the npm tarball, and it must equal the `name` in `server.json`
  (`io.github.dziuba0x/flario`). 1.4.0 shipped without it, so registry
  publication would have failed validation. npm versions are immutable, hence a
  patch release rather than a re-publish.
- No functional changes. Same 21 tools, 5 prompts, 96 tests.

## 1.4.0 (2026-08-31): prompts, two stubs turned real, CI

The release that makes Flario something a stranger can pick up.

- **Five MCP prompts** (`src/prompts/onboarding.ts`): `flare_tour`,
  `verify_a_price`, `prove_a_web_fact`, `fassets_health_check`,
  `why_flare_for_agents`. They appear in the client's prompt list and take
  someone from "I have heard Flare has an oracle" to "I verified a price
  against consensus on my own machine" without reading a doc page. Each one
  drives real calls and is written to admit what is not live yet.

- **`get_ftso_providers` now reads the chain.** It used to fail on install
  unless you pointed `FLARE_PROVIDERS_API` at an indexer that does not exist
  publicly. It now reads the VoterRegistry directly —
  `getRegisteredVotersAndNormalisedWeights` for the current reward epoch, plus
  `getWeightsSums` — and returns providers ranked by share of normalised vote
  weight. 100 providers on mainnet, 65 on Songbird, no external service.
  `FLARE_PROVIDERS_API` is now optional decoration that adds human-readable
  names and can never break the call.

- **`get_smart_account_info` now answers.** It guessed at a `getFlareAddress`
  function that does not exist on the MasterAccountController and returned
  "coming soon". It now uses the published interface: `getPersonalAccount` for
  the forward lookup (XRPL account to its deterministic Flare address) and
  `isSmartAccount` for the reverse (Flare address to its XRPL owner), and it
  distinguishes an address that is *reserved* from one that is *deployed*.

- **CI** (`.github/workflows/ci.yml`): build and the full test suite on Node
  20, 22 and 24, plus a cold-start job (`scripts/smoke-stdio.mjs`) that spawns
  the built server over stdio with no env vars and asserts the handshake,
  `tools/list`, `prompts/list` and `resources/list` — the exact path a new
  user's client takes on first run.

- **`server.json`**: Flario is now publishable to the official MCP registry.

- **`scripts/live-check.ts` no longer fails on rotten fixtures.** The hosted
  FDC verifiers only index a rolling window of source-chain history, so a
  replayed XRP request eventually returns "TRANSACTION DOES NOT EXIST". That is
  the fixture ageing out, not the tool breaking, and it is now reported as SKIP
  instead of turning the whole run red. The script also exercises the two
  repaired tools.

- **Documentation sync** carried over from the 1.3.0 follow-up: STATE.md
  rewritten around a "verified vs merely exposed" split, DECISIONS.md and
  README expanded, and the `flario` keyword added to package.json (the package
  was not findable by its own name).

- **Rebrand leftovers closed.** The old `flare-mcp` string is gone from the
  demo client, and the 0.4.0 entry below now notes that `FLARE_MCP_HTTP_*` was
  renamed to `FLARIO_HTTP_*`. Note that the stale Claude Desktop and Cursor
  snippets in the old CLAUDE.md pointed at the npm package `flare-mcp`, which
  belongs to an unrelated product; the rewritten CLAUDE.md in this release no
  longer contains them.

- 21 tools, 5 prompts, 2 resources; 96 tests.

## 1.3.0 (2026-07-21): prove any web fact (Web2Json), plus a hub hardening fix

- **`fdc_web2json_request`** (new): turn any public web API into a fact a smart
  contract can verify. Prepares an FDC Web2Json attestation (URL, jq filter,
  ABI signature) through a Flare-hosted verifier, quotes the fee, and submits
  when permitted.
- **`fdc_verify_web2json`** (new): verifies the Merkle proof locally against the
  on-chain Relay root **and binds it to the source you expected** (host
  allowlist, path prefix, https, method), then decodes the payload with the
  request's own ABI signature. Flare's guide warns that a valid proof only
  proves the data came from the URL inside it, not that the URL is trustworthy,
  so an unbound call is explicitly marked `source_bound: false` with a warning.
  Binding uses a real URL parser, which closes userinfo, IDN homograph and path
  prefix injection bypasses that string matching misses.
- **Security fix:** on-chain attestation submission is now disabled by default in
  hub (HTTP) mode. Previously any anonymous caller of a hosted hub could trigger
  paid attestation requests against the operator key that exists for x402
  settlement. stdio mode is unchanged; hub operators can opt in with
  `FLARIO_HUB_ALLOW_SUBMIT=true`. See DECISIONS 14.
- README gains a "Prove any web fact" section and a "Security posture" section.
- 21 tools; 90 tests.

## 1.2.2 (2026-07-21): README voice (docs only)

- Rewrote the README, npm description and GitHub description in a plain,
  human voice (no em-dashes or other stylistic tells). No code changes.

## 1.2.1 (2026-07-21): README polish (P3, docs only)

- Marketing-oriented README: added **Why Flario** (differentiators), **Examples**
  (natural-language agent asks → tools, with a real proof-carrying price output),
  and a no-client **Verify it works** quickstart. No code changes; ships the
  polished README to the npm package page too.

## 1.2.0 (2026-07-21): Flare portfolio + agent identity (edge path P2)

- **`get_flr_stake_info`** (new): one-call "Flare portfolio" for an address ,
  native FLR + wrapped WFLR, FTSO vote power and delegation (WNat/VPToken),
  claimable protocol rewards broken down by source (RewardManager
  `getStateOfRewards`, read-only, no claim proofs needed), and FlareDrops
  (DistributionToDelegators, best-effort). All four networks; each section
  degrades gracefully where a contract is absent/inactive.
- **`fassets_agent_details`** (new): human-facing agent info, name,
  description, logo/icon URL, terms-of-use URL and whitelist status from the
  AgentOwnerRegistry. Accepts an agent vault or an owner management address.
- 19 tools; 74 tests. Live-verified on mainnet (real agent "Oracle-daemon"
  name/logo resolved; portfolio reads incl. reward source breakdown).

## 1.1.0 (2026-07-21): proof-carrying FTSO feeds

Deepening enshrined-stack coverage (the "be the complete Flare MCP" track).

- **`get_ftso_anchor_feed`** (new): proof-carrying FTSO Scaling price, the
  value plus a Merkle proof verified **locally** against the on-chain Relay
  root (FTSO Scaling protocol id 100). Trust-minimized: an agent or a smart
  contract can rely on it without trusting the DA API. Leaf construction
  (`keccak256(abi.encode(body))`, sorted-pair fold) was resolved empirically
  and cross-confirmed against `FtsoV2Interface.verifyFeedData`. Resolves any
  feed by name (the full ~100+ anchor catalog) or `bytes21` id. All networks.
- **`get_ftso_history`** (fixed): now works against the **public** Flare Data
  Availability layer out of the box, no external indexer / `FLARE_DA_LAYER_API`
  needed. Returns recent anchor-feed points, each optionally Merkle-verified.
  All four networks.
- 17 tools; 70 tests (added offline anchor-feed verification fixtures).

## 1.0.0 (2026-07-21): Flario

Project renamed from `@dziuba0x/flare-mcp` to **Flario** (npm: `flario`; command:
`npx flario`; repo: github.com/dziuba0x/flario). Same tool, own brand, an
agent-native MCP server for Flare with x402 payments and chain-verified receipts.

- **No functional changes.** All 16 tools, both transports (stdio + HTTP hub),
  the x402 layer, receipts and FDC-verified settlement are unchanged. Only names
  moved: package `flario`, bin `flario`, MCP server name `flario`, receipt schema
  `flario-receipt/1`, hub env vars `FLARIO_HTTP_HOST`/`FLARIO_HTTP_PORT` (the
  Flare-network vars `FLARE_RPC*`, `FLARE_PRIVATE_KEY` keep the `FLARE_` prefix).
- Migration from `@dziuba0x/flare-mcp`: change the package to `flario` and the
  command to `npx flario`; update the mcpServers key if you used `flare-mcp`.
  The old package is deprecated with a pointer to `flario`.

## 0.5.0 (2026-07-21): ZK-ready receipts + FDC-verified settlement

The settlement layer's organ 3: receipts, and the enshrined-FDC proof that
makes them trust-minimized.

- **`x402_receipt`**: every settled payment now emits a fixed-schema,
  self-describing, portable receipt (`src/x402/receipt.ts`,
  [`RECEIPT_SPEC.md`](RECEIPT_SPEC.md)). The payer appears only as a
  **Poseidon (BN254) commitment**, never in plaintext; a keccak256
  `receipt_hash` gives any holder tamper-evidence. Payers may blind the
  commitment with an optional `commitment_salt` in the payment payload (not
  part of the EIP-712 authorization, it cannot affect fund movement).
  Additive: `x402_payment_receipt` (settlement summary) is unchanged;
  `x402_receipt` is emitted alongside it on both transports.
- **`fdc_verify_settlement`** (new tool): proves an x402 settlement via
  Flare's **enshrined FDC**, an EVMTransaction attestation over the
  settlement tx, locally Merkle-verified against the on-chain Relay root, then
  *bound* to the payment (the attested tx must contain an ERC-20 Transfer of
  the asset to the payee for at least  the amount). Populates the receipt's
  `fdc_attestation_ref`, making the settlement provable without trusting the
  facilitator. Never submits on-chain itself (no gas-griefing surface).
  Live-verified end-to-end on Coston2, including rejection of mismatched
  amount/payee.
- New dependency: `poseidon-lite` (small, dependency-free Poseidon).
- 16 tools total; 65 tests.

## 0.4.0 (2026-07-17): hub mode (hosted HTTP + spec-style x402)

> Note (1.4.0): the `FLARE_MCP_HTTP_*` variables below were renamed to
> `FLARIO_HTTP_*` in the 1.0.0 rebrand. The historical names are kept in this
> entry for accuracy; use `FLARIO_HTTP_PORT` and `FLARIO_HTTP_HOST` today.

- **`--http [port]` / `FLARE_MCP_HTTP_PORT`**: run flare-mcp as a hostable
  service, MCP over Streamable HTTP at `POST /mcp` (stateless, all 15
  tools) plus REST premium endpoints paid via **standard HTTP x402**
  (`402` + `accepts[]` → `X-Payment` header → result +
  `X-Payment-Response` with the settlement tx). Wire-compatible with the
  existing x402 client ecosystem; no new runtime dependencies (plain
  `node:http`).
- `GET /` discovery document (endpoints, x402 config), `GET /healthz`.
- `Dockerfile` + `.dockerignore` for one-command deployment; binds
  `127.0.0.1` by default, `FLARE_MCP_HTTP_HOST=0.0.0.0` to expose.
- stdio mode unchanged and still the default.

## 0.3.0 (2026-07-17): x402 payment layer

- **x402 payments over MCP** (`src/x402/`): paid tools reply with payment
  requirements; the client signs an EIP-3009 `TransferWithAuthorization`
  off-chain and retries with `x402_payment` (base64 JSON); the built-in
  facilitator verifies the EIP-712 signature locally, checks the nonce
  on-chain, settles `transferWithAuthorization` on Flare and attaches the
  settlement tx hash to the result. The facilitator never holds funds.
  Disabled by default (`X402_ENABLED=true` to enable; mainnet additionally
  behind `X402_ALLOW_MAINNET=true`). Prices per tool via env.
- **`fassets_liquidation_scanner`** (premium): joins FAssets agent state with
  live FTSOv2 prices, per agent: CR headroom against the collateral-type
  minimums, the underlying price at which liquidation starts, and the % move
  away from it.
- **`fdc_bulk_proof_bundle`** (premium): batch retrieval of up to 20 FDC
  proofs, each Merkle-verified locally against the on-chain Relay root.
- Demo agent: `scripts/x402-demo-client.ts` (MCP stdio client that pays and
  retries autonomously).
- Payment tokens verified on-chain: mainnet USD₮0 has EIP-3009 (docs +
  functional probe); Coston2 default is a verified EIP-3009 test USDT0.

## 0.2.0 (2026-07-15)

flare-mcp v2: FDC attestation workflows, deep FAssets state, Songbird/Coston
support, FCC registry watcher.

### Added

- **`fdc_request_attestation`**, prepare an FDC attestation request
  (`Payment`, `AddressValidity`, `EVMTransaction`) via the Flare-hosted
  verifiers, quote the request fee from `FdcRequestFeeConfigurations`, and ,
  when `FLARE_PRIVATE_KEY` is set, submit it to `FdcHub` and return the tx
  hash and voting round id. Without a key, returns the prepared request for
  submission with your own signer.
- **`fdc_get_attestation_proof`**, fetch an attestation proof from the Data
  Availability layer and verify it **locally**: the response struct is
  ABI-encoded and keccak-hashed into a Merkle leaf, folded through the proof,
  and compared to `Relay.merkleRoots(200, round)` read on-chain. A DA-layer
  response that does not match the on-chain root is rejected.
- **`fassets_agent_status`**, per-agent view (FXRP live on mainnet, Coston2,
  Songbird): collateral ratios, minting capacity in free lots,
  minted/reserved/redeeming amounts, liquidation status; sorted riskiest
  first.
- **`fassets_system_state`**, global stats: total minted, agent count, lot
  size, minting cap and pause flag, aggregated vault + pool collateral, and
  the redemption queue (tickets, value, lots) with pagination.
- **`songbird_fcc_registry`**, scans the live FlareContractRegistry for
  Flare Confidential Compute contracts (PMW / TEE / compute extensions).
  Reports `not_yet_publicly_addressable` today (per dev.flare.network/fcc,
  FCC is not yet public) and will surface the contracts the moment they are
  registered.
- **Songbird (chain 19) and Coston (chain 16)** network support; existing
  tools `get_flr_balance`, `get_ftso_feed`, `get_ftso_feeds_all` and
  `get_fdc_proof_status` now accept them too.
- Offline test suite (`npm test`, vitest) with recorded on-chain fixtures,
  plus `scripts/live-check.ts` acceptance checks against public RPCs.

### Changed

- Contract ABIs now come from the official
  `@flarenetwork/flare-periphery-contract-artifacts` package at runtime
  instead of being hand-written, for the large FDC/FAssets interfaces.
- DA-layer JSON is parsed with 64-bit-safe number handling
  (`lowestUsedTimestamp = 2^64-1` no longer loses precision).

### Migration notes (0.1.x → 0.2.0)

- **No breaking changes** to existing tools: names, inputs and outputs are
  unchanged. The `network` enum on the four tools listed above now
  *additionally* accepts `"songbird"` and `"coston"`.
- The server is no longer strictly read-only **only if you opt in**: setting
  `FLARE_PRIVATE_KEY` lets `fdc_request_attestation` submit transactions
  (attestation requests cost a small fee, e.g. 1000 wei on Coston2, plus
  gas). Leave it unset for the previous read-only behaviour, every other
  tool remains read-only regardless.
- New optional env vars: `FLARE_RPC_SONGBIRD`, `FLARE_RPC_COSTON`,
  `FLARE_PRIVATE_KEY`, `FDC_VERIFIER_API_KEY`, `FLARE_DA_API_KEY`,
  `FLARE_DA_URL`.

## 0.1.0 (2026-05-28)

Initial release: `get_flr_balance`, `get_ftso_feed`, `get_ftso_feeds_all`,
`get_ftso_providers`, `get_ftso_history`, `get_fassets_status`,
`get_fdc_proof_status`, `get_smart_account_info`; mainnet + Coston2; stdio
transport.
