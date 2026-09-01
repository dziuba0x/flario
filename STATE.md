# STATE.md: where Flario stands

Running project state, refreshed at the end of a session so the next one resumes
with no context loss. Companions: CLAUDE.md (the brief), DECISIONS.md (why), and
RECEIPT_SPEC.md (the receipt contract).

Last updated: 2026-08-31, release 1.5.0 (evidence bundles).

## Snapshot (verified against the code)

- Package **`flario` v1.5.0**. Published to npm under the bare name. Repo public at
  github.com/dziuba0x/flario. Command `npx flario`. MCP server name `flario`.
- **23 tools** (21 free, 2 premium), **6 prompts**, **2 resources**. Prompts live in
  `src/prompts/onboarding.ts` and are the onboarding surface for a stranger.
- Tools detail: 19 free, 2 premium (`fassets_liquidation_scanner`,
  `fdc_bulk_proof_bundle`). Registration lives in `src/server.ts`; `src/index.ts` is
  only the entry point that chooses a transport.
- **103 tests** green (`npm test`), plus a cold-start stdio smoke job in CI
  (`scripts/smoke-stdio.mjs`) that asserts the handshake and all three list
  endpoints with no env vars.
- **Transports**: stdio (default) and hub mode (`--http [port]` or
  `FLARIO_HTTP_PORT`), serving MCP over Streamable HTTP at `POST /mcp` plus
  x402-paid REST endpoints. Hub binds `127.0.0.1` unless `FLARIO_HTTP_HOST` says
  otherwise.
- **Networks**: mainnet (14), Coston2 (114), Songbird (19), Coston (16).
- Receipt schema emitted by the code: **`flario-receipt/1`**.

## What is built

**Enshrined-stack coverage.** FTSO (spot feeds, proof-carrying anchor feeds,
history from the public DA layer), FDC (attestation request, proof retrieval with
local Merkle verification, Web2Json), FAssets (agent status, system state, agent
identity, liquidation risk), staking and portfolio reads, Smart Accounts lookup,
and an FCC registry watcher.

**x402 payment layer** (`src/x402/`). EIP-3009 `transferWithAuthorization`
settlement, local EIP-712 verification, on-chain nonce check, replay protection
both on-chain and in-process. Never holds funds. Disabled unless `X402_ENABLED`,
and mainnet needs `X402_ALLOW_MAINNET` on top.

**Receipts.** Every settled payment emits `x402_receipt`: fixed schema, payer only
as a Poseidon/BN254 commitment, keccak256 tamper-evidence hash, optional blinding
salt. Contract in RECEIPT_SPEC.md.

**Verify-then-bind, the signature pattern.** `fdc_verify_settlement` binds an FDC
EVMTransaction attestation to the actual ERC-20 transfer. `fdc_verify_web2json`
binds a Web2Json proof to the source the caller expected. A cryptographically valid
proof for the wrong thing is rejected with a precise reason.

**Hub hardening.** On-chain attestation submission is refused in hub mode unless
`FLARIO_HUB_ALLOW_SUBMIT=true`, so an anonymous caller cannot spend the operator
key that exists to settle payments (DECISIONS 14).

## Verified vs merely exposed

This is the most important section for a new session. "Verified" means exercised
end to end against the live network by this project, not merely documented by Flare
or reachable through a tool signature.

**Verified end to end (Coston2 unless noted)**

| Path | Evidence |
| --- | --- |
| FDC `Payment` / `xrp` | Our own attestation submitted and proof verified, round 1397964 |
| FDC `AddressValidity` / `xrp` | Local Merkle verification against the Relay root, fixture round 1397600 |
| FDC `EVMTransaction` / `flr` (`testFLR`) | Settlement attestation verified and bound, round 1402609 |
| FDC `Web2Json` / `PublicWeb2` | Submitted, verified, source-bound, payload decoded, round 1409295; wrong-host and wrong-path proofs rejected |
| FTSO anchor feeds | Local fold matches `Relay.merkleRoots(100, round)` on Coston2 **and mainnet**, cross-checked against `FtsoV2Interface.verifyFeedData` |
| FTSO history over the public DA layer | Coston2, every point Merkle-verified |
| x402 settlement over MCP | Coston2 tx `0x19eb...a7dd` |
| x402 settlement over HTTP hub | Coston2 tx `0xf230...cab2`, replay rejected |
| Receipt emission and hash | Coston2 tx `0xb380...9184`, blinded commitment, hash verified |
| FAssets reads | mainnet, Coston2, Songbird (FXRP) |
| Portfolio and agent identity reads | mainnet |

**Exposed but not verified by us**

| Path | Status |
| --- | --- |
| FDC `EVMTransaction` / `eth` | Documented by Flare, never exercised here |
| FDC `EVMTransaction` / `sgb` | Exposed by the tool, never exercised here |
| FDC `Payment` and `AddressValidity` / `btc`, `doge` | Exposed by the tool, never exercised here |
| FDC submission on mainnet, Songbird, Coston | Only Coston2 has been submitted to; the others are reads only |
| x402 on mainnet | Never exercised. Behind `X402_ALLOW_MAINNET`, off by default |
| FAssets FBTC and FDOGE | No AssetManager exists yet; only FXRP is live |
| FCC contracts | Zero found in the registry on all four networks; the tool is a watcher |

This resolves the older contradiction between DECISIONS 9 (which said `flr` was
unverified) and DECISIONS 10 (which reported it verified). DECISIONS 10 is correct
and later: `flr` on Coston2 is verified. `eth` and `sgb` remain unverified.

## Open items

- **Mainnet x402 has never run.** Before enabling it, exercise one settlement on
  mainnet with a small amount, and set `X402_PAY_TO` to the production address
  recorded in `.env` as `X402_PAY_TO_PRODUCTION`.
- **No test asserts the receipt `schema_version` string literally.** The existing
  test compares against the imported constant, so it cannot catch a spec drift like
  the one this sync just fixed. Adding a literal assertion would close that.
- **No demo recording yet.** The operator records it; `scripts/x402-demo-client.ts`
  is the scenario.
- **FCC watch.** flare-foundation is actively pushing `tee-proxy`, `tee-node` and
  `fce-extension-scaffold`, but nothing is registered on-chain yet. When it lands,
  being first with an agent interface to FCC is the next big move.

## Direction

Strategy is the "edge" path: be the obvious, complete MCP server for Flare, then
deepen the proof-carrying moat that no other chain can copy. Architecture decision
by the operator: anything that is "an agent doing something with Flare" belongs in
Flario as more tools, including FCC when it arrives. The agent passport, reputation
and a marketplace stay separate future projects built on top of Flario's receipts,
so the brand does not fragment.

Not in scope here: ZK circuits, passport, reputation, marketplace, a public
facilitator for third parties, FCE implementations, and any UI beyond the README.

## Where the loop actually stands (2026-08-31)

Honest status, because this is the section a future session should trust.

- **Shipped and working:** the code. Cold install of the published package comes
  up and answers `tools/list`. Live mainnet reads verified this session: FTSO
  spot and anchor feeds, history off the DA layer, FAssets system state and
  agents on three networks, FTSO providers (100 mainnet / 65 Songbird), Smart
  Account forward and reverse lookup.
- **Not yet done, and this is the whole remaining problem:** distribution.
  Flario is not in the official MCP registry (`server.json` is written, not
  published). No GitHub Release exists despite a full CHANGELOG. npm downloads
  are registry mirrors, not people: ~4/day, 26 in the last seven days. One star.
- **The lesson this repo keeps teaching:** a documentation rewrite sat
  uncommitted from 12 August to 31 August. The bottleneck was never the code.

### Next, in order

1. Publish 1.4.0 to npm; tag `v1.4.0` and cut the GitHub Release from the
   CHANGELOG entry.
2. `mcp-publisher login github` then `mcp-publisher publish` with `server.json`.
3. List on Glama, mcp.so, PulseMCP.
4. Announce with a concrete claim and a paste-able call, not "I built an MCP
   server": an agent gets an FLR price with a Merkle proof it verifies locally
   against the on-chain Relay root, in one call.

### Then, and only then: 1.5.0

The differentiator worth building next is *attestation of the fact*, not
*attestation of execution*. The crowded field (VeritasChain VAP, Vouched
Checkpoint, Attest MCP, ZK-for-MCP-execution) proves the server ran correctly,
which still asks you to trust the operator or the hardware. Flario can prove the
fact itself against enshrined consensus, which is a different claim and needs a
chain with an enshrined oracle to make.

The missing piece is small: a bundler that packs several already-verifiable
facts (FTSO anchor, FDC EVMTransaction, Web2Json, receipt hash) into one
portable artefact a recipient verifies offline, without trusting Flario, the DA
API, or the agent. Every primitive exists; only the glue is missing.

