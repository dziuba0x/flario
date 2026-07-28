# DECISIONS.md — flare-mcp v2

Ambiguities and deviations flagged during the build, per the v2 build spec
("Flag anything ambiguous in a DECISIONS.md file instead of guessing
silently"). Dates are 2026-07-15/16 unless noted.

## 1. The spec's "published npm package" does not exist on the registry

The spec calls `@dziubatechnology/flare-mcp` an "existing published package".
`npm view @dziubatechnology/flare-mcp` returns **404** — it was never
published (or was unpublished). The local v1 source at `~/flare-mcp`
(v0.1.0) was used as the base instead. Consequence: the "npm weekly
downloads > 3× v1 baseline" metric has no baseline, and the 0.2.0 release
will effectively be the first publish of the scoped package.

## 2. FCC is not publicly addressable → `songbird_fcc_registry` ships as a watcher

The spec says FCC "just deployed to Songbird via STP.13" and asks tool #5 to
read "whatever FCC contract registry/state is publicly exposed". Findings:

- https://dev.flare.network/fcc/overview states (checked 2026-07-15): FCC
  "is not yet publicly available".
- Live `FlareContractRegistry.getAllContracts()` on Songbird (50 entries)
  contains **no** PMW/TEE/FCC-named contracts (recorded in
  `test/fixtures/songbird-registry.json`).

Per the spec's own contingency ("If FCC contracts are not yet publicly
addressable, ship Phase 1 without tool #5 and add it in a point release"),
the tool ships as a **registry watcher**: it scans the live registry for
FCC-related names, reports `not_yet_publicly_addressable` today, and lights
up automatically once contracts are registered. STP.13's final vote result
was not verified at proposals.flare.network (site not fetched); the
registry state is treated as the ground truth for "publicly exposed".

## 3. v1's "READ-ONLY, no private keys" rule vs. v2's `fdc_request_attestation`

The v1 CLAUDE.md forbids transactions and private keys; the v2 spec requires
submitting attestation requests and allows "user-provided keys locally".
Resolution: `FLARE_PRIVATE_KEY` is optional. Unset → the tool returns the
prepared request + fee + FdcHub address (`mode: "prepared_only"`), keeping
the server fully read-only. Set → the key signs locally via viem and is
never logged or transmitted. No other tool can ever spend funds.

## 4. Phase 2 payment-token gate — already largely resolved by official docs

The spec's blocking Phase 2 question (which Flare token supports gasless
authorization transfers) is answered by
https://dev.flare.network/fxrp/token-interactions/x402-payments (fetched
2026-07-15):

- Flare officially documents an x402 flow using **EIP-3009
  `transferWithAuthorization`**, with a **MockUSDT0** demo token and an
  `X402Facilitator` contract that the developer deploys on Coston2.
- **FXRP does not implement EIP-3009 yet** ("FXRP will be supported once it
  implements the required EIP-3009 standard").
- Whether the *production* USD₮0/USDC.e mainnet deployments implement
  EIP-3009 remains to be verified on-chain in Phase 2 (the docs also have a
  "Gasless USD₮0 Transfers" guide worth checking). For the Coston2 demo
  required by Phase 2 acceptance, the documented MockUSDT0 path (option (a)
  in the spec) works today; the Coston2 faucet even dispenses USDT0.
- Implication: "no x402 facilitator exists for Flare" is now only true for
  *hosted* facilitators; a reference on-chain facilitator contract exists in
  the official flare-hardhat-starter.

## 5. FAssets scope: FXRP only

Only `AssetManagerFXRP` exists in the registries of mainnet, Coston2 and
Songbird (verified live). FBTC/FDOGE inputs are accepted and probed but
return a clear "not live" error. Registry name variants from v1
(`FXrpAssetManager`, etc.) were dropped — the canonical name is confirmed.

## 6. Collateral totals are sampled

`fassets_system_state` aggregates vault/pool collateral by reading
`getAgentInfo` for up to 50 agents (all current networks have ≤ 8), and the
redemption queue is paginated up to 10 × `maxRedeemedTickets` tickets. If
agent counts grow past these caps the numbers become partial; the response
reports `agents_sampled` so consumers can tell.

## 7. Live-network testing of transaction submission — RESOLVED (2026-07-17)

The full FDC cycle was executed live on Coston2 with our own attestation:
`fdc_request_attestation` submitted a Payment request to FdcHub (tx
`0xb9c504fe613f49a7dfe16456727e053fca77708c68524b872618d350c91328fe`, fee
1000 wei, voting round 1397964); after finalization (~3 min),
`fdc_get_attestation_proof` retrieved the proof from the DA layer and
verified it locally against the Relay root
(`0x5fbdc8463844afea63…`, proof depth 2). Earlier, local Merkle verification
was also validated against third-party attestations (round 1397600).

## 8a. Phase 2 payment-token gate — RESOLVED (option (a), 2026-07-16)

On-chain probes (see also §4):

- **Mainnet USD₮0** `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` (proxy,
  2227-byte stub): `authorizationState` and `DOMAIN_SEPARATOR` respond →
  EIP-3009 live. Docs confirm the **packed-signature variant**
  `transferWithAuthorization(...,bytes signature)`; the facilitator tries the
  canonical (v,r,s) form first and falls back to the bytes form.
- **Coston2** `0xce13911D4896200b543a61E4ae8E829E661Dd8EB` ("USDT0", 6 dec):
  bytecode contains BOTH transferWithAuthorization selectors,
  receiveWithAuthorization and EIP-2612 permit. `mint` is restricted
  (owner-only), so demo payers need tokens from the faucet/DEX or a
  self-deployed MockUSDT0 (override via `X402_TOKEN_ADDRESS`). This token is
  a community/mock deployment — NOT claimed official. The Coston2 faucet
  labels a token "USDT0" but its address could not be extracted from the
  faucet app; verify which token the faucet dispenses before the demo.
- The spec's fallback (c) (FLR + FDC Payment attestation) is **not needed**
  but remains attractive as a second, fully-native scheme later.

## 8b. x402-for-MCP mapping (stdio has no HTTP status/headers)

x402 is HTTP-native. Over stdio, this server maps: HTTP 402 body → tool
result `{ x402_payment_required, accepts: [...] }`; `X-Payment` header →
optional tool argument `x402_payment` (same base64-JSON encoding);
`X-Payment-Response` → `x402_payment_receipt` attached to the tool result.
Settlement happens BEFORE the tool runs; a failed settlement never releases
the result. This mapping is our own design (no MCP payment standard exists);
documented in README for interop.

## 8c. Settlement — RESOLVED end-to-end on Coston2 (2026-07-17)

Full x402 flow executed live via `scripts/x402-demo-client.ts`: 402
requirements → off-chain EIP-3009 signature → verify → settlement tx
`0x19eb12939c66f495ce4e5c60f6a00a8e3418a0d049e38dc796a54c94906fa7dd`
(Coston2) → paid result released with the receipt attached. Balances
confirmed on-chain (payee +0.001 mUSDT0).

Two findings from the live run:
- The **faucet USDT0** (`0xC1A5B41512496B80903D1f32d6dEa3a73212E71F`,
  "USDT0 test") has **no EIP-3009**, so it cannot pay x402. The demo instead
  deployed the official flare-hardhat-starter `MockUSDT0` (public mint,
  canonical (v,r,s) EIP-3009) to Coston2 at
  `0x3c71Fb2b7da7CE85dd1aF0A54174668e41BcD176` — set as `X402_TOKEN_ADDRESS`
  for demos. The compiled source is vendored in `contracts/MockUSDT0.sol`.
- The in-process settled-nonce cache does not survive restarts; the durable
  replay barrier is the on-chain EIP-3009 nonce, consumed at settlement.

## 8d. npm identity + a publishing false alarm

The user's npm account is `dziuba0x` (no `dziubatechnology` org), and the
unscoped name `flare-mcp` is taken by an unrelated ticketing product (since
2026-04). Published as **`@dziuba0x/flare-mcp`**; the spec's
`@dziubatechnology/flare-mcp` never existed on the registry (§1).

Correction for the record: the commit message of the 0.3.1 bump claims 0.3.0
was "burned by npm spam-block" — that diagnosis was **wrong**. The registry
was simply replicating slowly (several minutes of 404s after a successful
publish), and www.npmjs.com returns HTTP 403 to curl for *every* page (bot
protection), which mimicked a quarantine. Both 0.3.0 (published by the user)
and 0.3.1 are live. Lesson: always run a control probe (a known-good package)
before concluding anything from registry/site responses.

Source repository: https://github.com/dziuba0x/flare-mcp (pushed 2026-07-17).

## 8e. Receipt commitment primitive — Poseidon/BN254 (operator decision, 2026-07-21)

Handoff Principle 3 requires receipts where the payer appears only as a
commitment. The commitment primitive is load-bearing (it must match the future
ZK stack) and cryptographic, so per Principle 3 it was flagged to the operator
rather than guessed. Operator chose **Poseidon over BN254** (via `poseidon-lite`)
over keccak256, because the future passport/reputation project uses the
BabyJubjub + Poseidon (Circom/snarkjs) stack, where keccak-in-circuit costs
~150k constraints. The receipt is self-describing (`commitment_scheme`,
`hash_scheme`) so the choice can evolve. Full contract: `RECEIPT_SPEC.md`.

Honest caveat recorded in the spec: under EIP-3009 the payer is already public
on-chain, so the commitment is structural/forward-looking, not present-day
privacy. We do not overclaim it.

On-chain receipt-hash anchoring was **deferred** (would add one tx per call,
doubling gas on sub-cent pricing); the anchor today is the settlement tx hash,
and the FDC attestation becomes the enshrined anchor once that path lands.

## 14. Hub mode must not let strangers spend the operator key (found 2026-07-21)

Found while building the Web2Json request tool, and it applies to the existing
`fdc_request_attestation` too. An attestation request costs a fee plus gas. In
hub (HTTP) mode the operator sets `FLARE_PRIVATE_KEY` for a completely
different reason (settling x402 payments), and all tools are exposed over
`POST /mcp` to whoever can reach the port. So any anonymous caller could have
triggered unlimited paid on-chain submissions and drained the operator's funds.

Fix: `src/utils/runtime.ts` tracks the runtime posture. stdio mode keeps the old
behaviour (you are the only caller, so it is your own gas by definition). Hub
mode refuses on-chain submission and returns the prepared request instead,
unless the operator explicitly opts in with `FLARIO_HUB_ALLOW_SUBMIT=true`.
Both request tools honour it. This mirrors the same reasoning already used in
§10 for `fdc_verify_settlement`, which never submits at all.

## 13. Web2Json: verify AND bind the source (P-flagship, 2026-07-21)

`Web2Json` turns any public web API into a fact a contract can verify, which is
the single most general capability FDC offers. Resolved empirically first:
the verifier route is `/verifier/web2/Web2Json/prepareRequest`, the source id is
the fixed string `PublicWeb2` on every network (no `test` prefix, unlike the
chain-sourced types, so it needed its own prepare helper), and the request body
is `{url, httpMethod, headers, queryParams, body, postProcessJq, abiSignature}`.
Confirmed VALID live against the testnet verifier before any code was written.

The important part is the security model. Flare's own guide
(https://dev.flare.network/fdc/guides/url-parsing-security) states plainly that
"a valid FDC proof only guarantees the data came from the URL in the proof. It
does not guarantee the URL is trustworthy." A Merkle-valid proof for an
attacker's own endpoint is trivially obtainable. So `fdc_verify_web2json` takes
an optional `expect_source` (hosts allowlist, path prefix, https, method) and
rejects a valid proof whose attested URL does not match. Without
`expect_source` the response is explicitly marked `source_bound: false` with a
warning rather than silently looking trustworthy.

Binding uses the WHATWG `URL` parser instead of the string prefix matching the
Solidity guide has to use on-chain. That closes three bypasses that naive
matching misses, each with a test: userinfo
(`https://api.trusted.com@evil.com/`, real host is evil.com), IDN homographs
(Cyrillic lookalikes normalise to punycode and therefore fail exact match), and
path prefix injection (`/evil/api/v3/...` contains but does not start with the
expected path). Host comparison is case-insensitive because DNS is.

Verified end-to-end live on Coston2: submit, finalize, verify, bind, decode,
plus negative cases (wrong host, wrong path prefix) rejected.

## 12. Proof-carrying FTSO anchor feeds (P1, 2026-07-21)

Edge-path P1: make FTSO trust-minimized. FTSO Scaling anchor feeds are published
per voting epoch with a Merkle proof. Resolved empirically (as promised, not
guessed): the on-chain root is `Relay.merkleRoots(100, votingRoundId)` (FTSO
Scaling = protocol id 100; FDC = 200), and the Merkle leaf is
`keccak256(abi.encode(body))` where body = `{votingRoundId uint32, id bytes21,
value int32, turnoutBIPS uint16, decimals int8}`, sorted-pair fold — confirmed
two ways: local fold == on-chain root, AND `FtsoV2Interface.verifyFeedData`
returns true. DA endpoints: `/api/v0/ftso/anchor-feeds-with-proof` (POST,
feed_ids + voting_round_id) and `/api/v0/ftso/anchor-feed-names`. `get_ftso_history`
rewired to the public DA layer (dropped the `FLARE_DA_LAYER_API` requirement).
Live-verified on Coston2 + mainnet (FLR/USD, plus a non-bundled feed AAVE/USD to
prove name resolution).

## 11. Rebrand to Flario (operator decision, 2026-07-21)

The project moved off the descriptive/generic name to an ownable brand: **Flario**
(npm `flario` — the bare, unscoped name was free; repo github.com/dziuba0x/flario;
command `npx flario`). Rationale: the bare `flare-mcp` was never available (taken
by an unrelated product), and a generic name collides with the official Flare MCP
and can't be owned. "Flario" = "Flare I/O" — reads as the input/output layer to
Flare, keeps the Flare family association without impersonating (distinct word,
own meaning), and is fully ownable (npm + flario.io/.xyz/.dev free). Checks: no
crypto/dev collision; one unrelated `Flairio Labs` exists (different spelling
FLAIRIO, video-commerce SaaS — different class, low risk); a formal trademark
search is advisable before heavy brand spend but fine for an OSS launch. Version
reset to 1.0.0 as the brand launch. Positioning keeps "Flare" and "MCP" in the
tagline/keywords for discovery.

## 10. FDC-verified settlement — EVMTransaction, not Payment (operator-confirmed, 2026-07-21)

The handoff (Principle 4) describes the differentiator as an "FDC **Payment**
attestation." Correction, flagged and confirmed with the operator: FDC Payment
attests native-currency payments on **BTC/DOGE/XRP** only (per `IPayment`
`@custom:supported BTC, DOGE, XRP`). An x402 settlement on Flare is an **ERC-20
transfer on an EVM chain**, so the correct enshrined primitive is the FDC
**EVMTransaction** attestation over the settlement tx (source = the Flare network
itself; Flare/Songbird are documented EVMTransaction sources). Verified live: the
testnet verifier accepts `EVMTransaction/flr` for a Coston2 tx → `VALID`.
Operator confirmed this direction ("kierunek fenomenalny i unikatowy").

**Binding is the security core.** Proving "tx X is confirmed" is insufficient; the
attestation is bound to the payment by scanning the attested tx's events for an
ERC-20 `Transfer(asset → payee, value ≥ amount)`. A VALID Merkle proof whose tx
does not contain the claimed transfer is rejected. Live-verified on Coston2,
including rejection of overclaimed amount, wrong payee, and wrong asset.

**No on-chain submission from the tool (anti-griefing).** `fdc_verify_settlement`
never submits an FdcHub transaction. Submitting an attestation request costs a
fee + gas; if a hosted hub auto-submitted on every call it could be griefed into
draining the operator's gas. The request is permissionless — the holder submits
it themselves (via `fdc_request_attestation`, which they run with their own key).
Phase 1 of the tool only *prepares* (verifier API, no chain write); phase 2
verifies + binds. This keeps the verification tool free and abuse-resistant.

**Anchoring (D2) resolved as planned:** the FDC EVMTransaction attestation is
itself the enshrined, chain-verifiable anchor for the settlement; no separate
receipt-hash anchor contract is added (would double gas on sub-cent pricing).

## 9. EVMTransaction source chains

Verifier docs list Ethereum, Flare and Songbird as EVMTransaction sources
(`eth`, `flr`, `sgb` path segments; `testETH` etc. on testnet). Only the
`eth` path is exercised in the docs; `flr`/`sgb` are exposed by the tool but
unverified against the hosted verifiers.
