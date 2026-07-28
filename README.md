# Flario

[![npm version](https://img.shields.io/npm/v/flario.svg)](https://www.npmjs.com/package/flario)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org)
[![Model Context Protocol](https://img.shields.io/badge/Model_Context_Protocol-server-6E56CF.svg)](https://modelcontextprotocol.io)

**An MCP server for Flare Network.** Flario gives an AI agent (in Claude, Cursor, VS Code, or any [Model Context Protocol](https://modelcontextprotocol.io) client) plain-language access to Flare's enshrined protocols: FTSO price feeds, FDC cross-chain attestations, and FAssets. It also gives the agent a wallet. Premium tools are paid per call with [x402](https://www.x402.org/) settled on Flare, and every payment comes back with a receipt the chain itself can prove.

Install it with `npx flario`, or run it as an HTTP hub. It works against the public Flare RPCs out of the box, needs no account or key for reads, and never holds or forwards funds.

Flario covers the whole enshrined stack: FTSO prices (including proof-carrying anchor feeds), FDC attestation workflows with local Merkle-proof verification, deep FAssets state (per-agent collateral, liquidation risk, system totals, the redemption queue), a Flare portfolio read (delegation, vote power, claimable rewards), Songbird and Coston support, and a watcher for Flare Confidential Compute contracts. Reads are trust-minimized: FDC and FTSO proofs are checked locally against the on-chain Relay root, never taken from an API on faith. The one write, `fdc_request_attestation`, only submits a transaction if you set `FLARE_PRIVATE_KEY`; otherwise it hands you a prepared request to sign yourself.

> **This is complementary to Flare's official MCP server**, not a replacement. Their server (`dev.flare.network/mcp`) does documentation search, so it gives an agent knowledge. Flario gives an agent hands and a wallet: it calls the enshrined protocols and lets the agent pay for computed results, with receipts the chain can verify. Use both.

---

## Why Flario

- **It goes deep on the protocols that are built into Flare.** FTSO, FDC, and FAssets are enshrined in the chain, and so are Flario's 21 tools. A generic multi-chain MCP server can't reach any of this, and the depth doesn't port to another chain.
- **Answers carry a proof, so you don't have to take my word for it.** Prices and cross-chain facts come with a Merkle proof that Flario checks locally against the on-chain root. An agent, or even a smart contract, can rely on the answer without trusting any API.
- **Agents can pay, and they get a receipt.** Premium tools settle per call over [x402](https://www.x402.org/) on Flare, and each payment returns a portable receipt that Flare's own FDC can prove, not just the facilitator's word for it. No other chain in the x402 ecosystem can do that today.
- **Self-hostable, no custody.** It runs on public RPCs, asks for no account or key to read data, and never touches your funds.

---

## Examples

Once Flario is in your MCP client (see [Install](#install)), you just ask in plain language:

| Ask your agent | Flario runs |
| --- | --- |
| "What's the FLR/USD price on Flare, with a proof I can check?" | `get_ftso_anchor_feed` |
| "Which FXRP agents are closest to liquidation right now?" | `fassets_liquidation_scanner` |
| "Show the FLR portfolio for `0x...`: balance, delegation, claimable rewards." | `get_flr_stake_info` |
| "Who runs FXRP agent `0x...`?" | `fassets_agent_details` |
| "Prove this settlement actually happened, using Flare's FDC." | `fdc_verify_settlement` |
| "Put this API's data on-chain with a proof, and only accept it from the host I trust." | `fdc_web2json_request` then `fdc_verify_web2json` |

A proof-carrying price comes back with the value and a proof the agent can verify on its own (trimmed):

```json
{
  "verified": true,
  "verification": "Local: keccak256(abi.encode(feed body)) folded through the Merkle proof equals Relay.merkleRoots(100, round) read on-chain.",
  "name": "FLR/USD",
  "price": 0.006786,
  "voting_round_id": 1402671,
  "merkle_root": "0x...",
  "proof": ["0x...", "0x..."]
}
```

---

## Install

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add:

```json
{
  "mcpServers": {
    "flario": {
      "command": "npx",
      "args": ["-y", "flario"],
      "env": {
        "FLARE_RPC": "https://flare-api.flare.network/ext/C/rpc",
        "FLARE_RPC_TESTNET": "https://coston2-api.flare.network/ext/C/rpc"
      }
    }
  }
}
```

Restart Claude Desktop, then ask something like "What's the FLR/USD price on Flare?" or "How much FXRP is minted right now?".

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project) and add:

```json
{
  "mcpServers": {
    "flario": {
      "command": "npx",
      "args": ["-y", "flario"]
    }
  }
}
```

The same block works in any MCP client with stdio support (VS Code, Windsurf, Zed, and so on). The `env` block is optional, since the public Flare RPCs are used by default.

### Check it works (no client, ~10 s)

```bash
# List all 21 tools straight from the published package:
npx -y @modelcontextprotocol/inspector --cli npx -y flario --method tools/list

# Or call one, a proof-carrying FLR/USD price on mainnet:
npx -y @modelcontextprotocol/inspector --cli npx -y flario \
  --method tools/call --tool-name get_ftso_anchor_feed \
  --tool-arg feed_id=FLR/USD --tool-arg network=mainnet
```

---

## Tools

Every tool validates its input with [zod](https://zod.dev) and returns a clear error instead of crashing when an RPC call or data source is down. Nineteen tools are free. The two premium tools settle via [x402 on Flare](#how-payments-work-x402) when the operator turns it on, and are free otherwise.

| Tool | Networks | Tier | What it does |
| --- | --- | --- | --- |
| `get_flr_balance` | mainnet, coston2, songbird, coston | Free | Native FLR plus wrapped WFLR (WNat) balance for an address |
| `get_flr_stake_info` | mainnet, coston2, songbird, coston | Free | Portfolio: FLR and WFLR, vote power, delegation, claimable rewards by source, FlareDrops |
| `get_ftso_feed` | mainnet, coston2, songbird, coston | Free | Latest price for one FTSO feed (`"FLR/USD"` or a `bytes21` id) |
| `get_ftso_feeds_all` | mainnet, coston2, songbird, coston | Free | Latest price for every bundled feed |
| `get_ftso_providers` | mainnet, coston2 (see note) | Free | Active FTSO data providers |
| `get_ftso_anchor_feed` | mainnet, coston2, songbird, coston | Free | Proof-carrying FTSO Scaling price plus a Merkle proof, checked locally against the on-chain Relay root |
| `get_ftso_history` | mainnet, coston2, songbird, coston | Free | Recent FTSO Scaling anchor-feed history from the public DA layer, each point Merkle-verified |
| `get_fassets_status` | mainnet, coston2 | Free | FAssets minted total and agent count (short summary; see `fassets_system_state`) |
| `get_fdc_proof_status` | mainnet, coston2, songbird, coston | Free | FDC Merkle root and finalization for a round |
| `get_smart_account_info` | mainnet, coston2 (see note) | Free | Resolve the Flare address of an XRPL account |
| `fdc_request_attestation` | mainnet, coston2, songbird, coston | Free | Prepare, and optionally submit, an FDC attestation request. Returns tx hash and voting round id |
| `fdc_get_attestation_proof` | mainnet, coston2, songbird, coston | Free | Fetch a proof from the DA layer and verify it locally against the on-chain Relay root |
| `fassets_agent_status` | mainnet, coston2, songbird | Free | Per-agent collateral ratios, minting capacity, liquidation status (riskiest first) |
| `fassets_system_state` | mainnet, coston2, songbird | Free | Total minted, lot size, minting cap and pause, aggregate collateral, redemption queue |
| `fassets_agent_details` | mainnet, coston2, songbird | Free | Agent name, description, logo, terms of use, whitelist status (AgentOwnerRegistry) |
| `songbird_fcc_registry` | songbird (default), all | Free | Scan the live contract registry for Flare Confidential Compute (PMW, TEE) deployments |
| `fdc_verify_settlement` | mainnet, coston2, songbird, coston | Free | Prove an x402 settlement via enshrined FDC (EVMTransaction attestation) and bind it to the payment |
| `fdc_web2json_request` | mainnet, coston2, songbird, coston | Free | Turn any public web API into a verifiable fact: URL plus jq filter plus ABI signature, prepared through a Flare verifier |
| `fdc_verify_web2json` | mainnet, coston2, songbird, coston | Free | Verify a Web2Json proof locally AND bind it to the source you expected, then decode the payload |
| `fassets_liquidation_scanner` | mainnet, coston2, songbird | Premium (x402) | FAssets agents joined with live FTSO prices: per-agent liquidation price and how far away it is |
| `fdc_bulk_proof_bundle` | mainnet, coston2, songbird, coston | Premium (x402) | Batch fetch and local verification of up to 20 FDC proofs |

Notes on a few tools:

- Premium tools run free unless the operator sets `X402_ENABLED=true`. See [How payments work](#how-payments-work-x402).
- `get_ftso_providers` needs an external indexer endpoint (set with an env var below). Aggregating providers on-chain isn't practical for a read-only stdio server.
- `get_smart_account_info` is best-effort. The MasterAccountController ABI isn't published in the periphery artifacts yet, so it returns a `has_account: false` notice when it can't resolve.

### The FDC attestation flow

```text
1. fdc_request_attestation  (type: Payment | AddressValidity | EVMTransaction,
                             source_chain: xrp | btc | doge | eth | flr | sgb)
     -> verifier prepareRequest -> fee quote -> FdcHub.requestAttestation
     -> { tx_hash, voting_round_id, abi_encoded_request }
2. wait ~90 to 180 s for the voting round to finalize
3. fdc_get_attestation_proof (voting_round_id, abi_encoded_request)
     -> DA-layer proof -> local keccak256 Merkle fold -> must equal
        Relay.merkleRoots(200, round) read on-chain -> verified response
```

Without `FLARE_PRIVATE_KEY`, step 1 returns `mode: "prepared_only"` with the encoded request, the fee, and the FdcHub address, so you can submit it with your own signer. When the key is set, it only ever signs locally.

---

## How payments work (x402)

Flario implements the [x402 payment protocol](https://www.x402.org/) over MCP. As far as I know it's the first MCP server whose paid tools settle on the same chain they serve. HTTP's 402 status and `X-Payment` header map onto tool results and a tool argument:

```text
1. call a paid tool                -> result: { x402_payment_required: true,
                                                accepts: [requirements] }
2. sign an EIP-3009 TransferWithAuthorization off-chain (gasless for the payer)
3. retry the SAME call with         -> x402_payment: base64(JSON payload)
4. the server checks the EIP-712 signature locally, checks the nonce on-chain,
   settles transferWithAuthorization on Flare, runs the tool
   -> result includes x402_payment_receipt (settlement summary) and
      x402_receipt (a portable, ZK-ready receipt; see RECEIPT_SPEC.md)
```

The built-in facilitator never holds funds. `transferWithAuthorization` moves the tokens straight from payer to payee, and the operator key only pays gas to broadcast the authorization the client already signed. Replay is blocked twice over: EIP-3009 nonces are consumed on-chain, and settled nonces are also cached in the process.

Every paid call returns a portable `x402_receipt`. It's a fixed-schema, self-describing record where the payer shows up only as a Poseidon commitment, never in plaintext, with a keccak256 `receipt_hash` any holder can recompute to check for tampering. A payer can blind the commitment with an optional `commitment_salt` in the payment payload. Full spec: [`RECEIPT_SPEC.md`](RECEIPT_SPEC.md).

---

## Prove any web fact (Web2Json)

FDC's `Web2Json` type fetches JSON from a URL, runs a jq filter over it, and returns ABI-encoded data. That means any public API can become a fact a smart contract is able to check. Flario wraps the whole loop for an agent:

```text
1. fdc_web2json_request  (url + post_process_jq + abi_signature)
     -> a Flare verifier validates it and quotes the fee
     -> submit to FdcHub (your key), get a voting round id
2. wait ~90 to 180 s for the round to finalize
3. fdc_verify_web2json  (voting_round_id + abi_encoded_request + expect_source)
     -> Merkle proof checked locally against Relay.merkleRoots(200, round)
     -> attested URL bound to the source you expected
     -> payload decoded with the request's own ABI signature
```

### Why `expect_source` matters

Flare's own guide is blunt about the trap ([URL parsing security](https://dev.flare.network/fdc/guides/url-parsing-security)):

> A valid FDC proof only guarantees the data came from the URL in the proof. It does not guarantee the URL is trustworthy.

So a proof that passes Merkle verification is only half the story. An attacker can stand up their own endpoint, get a completely valid attestation for it, and hand you that proof. `fdc_verify_web2json` therefore does both jobs: it verifies the proof, and it binds the proof to the source you actually meant to use.

```json
{
  "expect_source": {
    "hosts": ["api.coingecko.com"],
    "path_prefix": "/api/v3/simple/price",
    "require_https": true,
    "http_method": "GET"
  }
}
```

If the attested URL does not match, the call fails loudly even though the cryptography is fine. Leave `expect_source` out and you still get the proof, but the response is marked `source_bound: false` with a warning, because that is the path an attacker can walk through.

Binding uses a real URL parser instead of string prefix matching, which closes three bypasses that naive checks miss:

| Attack | Looks like | Why prefix matching fails |
| --- | --- | --- |
| Userinfo | `https://api.coingecko.com@evil.com/price` | Starts with the trusted string, but the host is `evil.com` |
| Homograph | `https://аpi.coingecko.com/price` (Cyrillic а) | Visually identical, different host |
| Path injection | `https://api.coingecko.com/evil/api/v3/simple/price` | Contains the expected path, does not start with it |

Each of these has a test in `test/web2json.test.ts`.

Here is a real verified response from Coston2, using the same API Flare's own Web2Json guide uses (trimmed):

```json
{
  "verified": true,
  "source_bound": true,
  "verification": "Two checks passed. The Merkle proof folds to Relay.merkleRoots(200, round) read on-chain, and the attested request matches the source you expected (protocol, host, path, method).",
  "voting_round_id": 1409295,
  "source": {
    "url": "https://swapi.info/api/people/3",
    "http_method": "GET",
    "parsed": { "protocol": "https", "host": "swapi.info", "path": "/api/people/3" }
  },
  "data": { "name": "R2-D2", "height": "96", "mass": "32" }
}
```

Ask for the same proof while expecting a different host and the call fails on purpose, even though the cryptography is perfectly valid:

```text
The FDC proof is VALID (Merkle-verified against the on-chain Relay root) but it
does NOT come from the source you expected: attested host "swapi.info" is not in
the expected list (api.coingecko.com). Treat this data as untrusted.
```

### FDC-verified settlement (the part I'm proudest of)

A receipt claims a payment settled. Flare can prove it did, using the chain's own enshrined data connector. `fdc_verify_settlement` takes a settlement tx, gets an FDC EVMTransaction attestation over it, verifies the Merkle proof locally against the on-chain Relay root, and then binds the attestation to the payment: it confirms the attested transaction really contains an ERC-20 `Transfer` of the asset to the payee for at least the amount. The result is a receipt whose `fdc_attestation_ref` makes the settlement provable without trusting the facilitator. No other chain in the x402 ecosystem produces a protocol-level receipt like this. The tool never submits a transaction itself (the attestation request is permissionless, so the holder submits it), which means a hosted hub can't be tricked into burning gas.

Operator setup:

```bash
X402_ENABLED=true
X402_NETWORK=coston2            # mainnet also needs X402_ALLOW_MAINNET=true
X402_PAY_TO=0xYourPayeeAddress
FLARE_PRIVATE_KEY=0x...         # operator gas key for settlements
# optional: X402_TOKEN_ADDRESS, X402_PRICE_DEFAULT=0.001,
#           X402_PRICE_FASSETS_LIQUIDATION_SCANNER=0.005 (whole-token units)
```

Payment tokens (EIP-3009, checked on-chain in July 2026): Coston2 defaults to `0xce13911D4896200b543a61E4ae8E829E661Dd8EB` (a test USDT0), and mainnet defaults to the official [USD₮0](https://docs.usdt0.to/technical-documentation/developer#flare) at `0xe7cd86e13AC4309349F30B3435a9d337750fC82D`. You can walk the whole agent flow with `npx tsx scripts/x402-demo-client.ts`.

---

## Run it as a hub

You can run Flario as a network service instead of a local stdio process:

```bash
npx flario --http 8402         # or FLARIO_HTTP_PORT=8402
# to expose it beyond localhost:
FLARIO_HTTP_HOST=0.0.0.0 npx flario --http 8402
```

| Endpoint | What it serves |
| --- | --- |
| `POST /mcp` | The full MCP server over Streamable HTTP (stateless), all 21 tools, x402 in-band |
| `GET /api/premium/liquidation-scanner?asset=FXRP&network=mainnet` | HTTP x402: `402` plus `accepts[]`, retry with the `X-Payment` header, get the result plus `X-Payment-Response` |
| `POST /api/premium/proof-bundle` | Same x402 flow. Body: `{"requests":[{"voting_round_id":N,"abi_encoded_request":"0x..."}],"network":"..."}` |
| `GET /` | Discovery: endpoints, x402 config, pricing |
| `GET /healthz` | Liveness |

The REST endpoints use the standard x402 wire format (base64 JSON in `X-Payment`), so non-MCP agents and existing x402 clients can pay too. There's a `Dockerfile` in the repo:

```bash
docker build -t flario-hub . && docker run -p 8402:8402 \
  -e X402_ENABLED=true -e X402_PAY_TO=0xYou -e FLARE_PRIVATE_KEY=0x... flario-hub
```

---

## Networks

| Network | Chain ID | Default RPC | Override env var |
| --- | --- | --- | --- |
| Flare Mainnet | `14` | `https://flare-api.flare.network/ext/C/rpc` | `FLARE_RPC` |
| Coston2 Testnet | `114` | `https://coston2-api.flare.network/ext/C/rpc` | `FLARE_RPC_TESTNET` |
| Songbird Canary | `19` | `https://songbird-api.flare.network/ext/C/rpc` | `FLARE_RPC_SONGBIRD` |
| Coston Testnet | `16` | `https://coston-api.flare.network/ext/C/rpc` | `FLARE_RPC_COSTON` |

Contract addresses are never hardcoded. They're resolved at runtime through the Flare `ContractRegistry` at `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` (same address on all four networks). The FDC verifier and Data Availability endpoints default to the Flare-hosted public services listed at [dev.flare.network/network/overview](https://dev.flare.network/network/overview).

### Configuration

Everything here is optional. The server runs against the public RPCs and Flare-hosted FDC services with no config at all.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `FLARE_RPC` | all mainnet calls | Override the mainnet RPC endpoint. |
| `FLARE_RPC_TESTNET` | all Coston2 calls | Override the Coston2 RPC endpoint. |
| `FLARE_RPC_SONGBIRD` | all Songbird calls | Override the Songbird RPC endpoint. |
| `FLARE_RPC_COSTON` | all Coston calls | Override the Coston RPC endpoint. |
| `FLARE_PRIVATE_KEY` | `fdc_request_attestation`, `fdc_web2json_request` | Local signing key for submitting attestation requests. Never logged, never leaves the process except as a signed tx. Leave it out for prepared-only mode. |
| `FLARIO_HUB_ALLOW_SUBMIT` | hub mode | Allow on-chain attestation submission in hub mode. Off by default so an anonymous caller cannot spend the operator's gas. See [Security posture](#security-posture). |
| `FDC_VERIFIER_API_KEY` | `fdc_request_attestation` | Verifier API key. Defaults to the public key `00000000-0000-0000-0000-000000000000`. |
| `FLARE_DA_API_KEY` | `fdc_get_attestation_proof` | DA-layer API key. Defaults to the public key. |
| `FLARE_DA_URL` | `fdc_get_attestation_proof` | Override the DA-layer base URL (for example a self-hosted instance). |
| `X402_ENABLED` | premium tools | `true` turns on the x402 paywall for premium tools. Off by default, so premium tools are free. |
| `X402_NETWORK` | x402 | Settlement network (default `coston2`; `mainnet` also needs `X402_ALLOW_MAINNET=true`). |
| `X402_PAY_TO` | x402 | Payee address that receives payments (required when enabled). |
| `X402_TOKEN_ADDRESS` | x402 | EIP-3009 payment token override (defaults: Coston2 test USDT0, mainnet USD₮0). |
| `X402_PRICE_DEFAULT` / `X402_PRICE_<TOOL>` | x402 | Prices in whole-token units (default `0.001`). |
| `FLARE_PROVIDERS_API` | `get_ftso_providers` | An indexer endpoint that returns a JSON array of providers (or `{ "providers": [...] }`). |
| `FLARE_METRICS_API` | `get_fassets_status` | Optional fallback metrics API, used only if the on-chain read fails. |

See [`.env.example`](.env.example) for a copy-paste template.

---

## Security posture

This thing touches money, so the defaults lean paranoid.

- **No custody, anywhere.** Flario never holds or forwards funds. x402 settlement moves tokens straight from payer to payee inside `transferWithAuthorization`; the operator key only pays gas to broadcast an authorization the client already signed.
- **Verify, then bind.** Every proof-consuming tool does two things, not one. A Merkle proof that checks out is necessary but not sufficient, so `fdc_verify_settlement` binds the attestation to the actual ERC-20 `Transfer`, and `fdc_verify_web2json` binds it to the source you expected. A valid proof for the wrong thing is rejected with a precise reason.
- **Submission is off by default in hub mode.** In stdio mode you are the only caller, so spending your own gas on an attestation request is what you asked for. In hub mode anyone who reaches the port is a caller, and the operator key exists to settle x402 payments, so letting a stranger trigger paid on-chain requests would drain it. Hub mode therefore refuses on-chain submission and returns the prepared request instead, unless the operator sets `FLARIO_HUB_ALLOW_SUBMIT=true`.
- **Keys stay local.** `FLARE_PRIVATE_KEY` is read from the environment, used to sign in-process, and never logged or transmitted anywhere except as an already-signed transaction to the RPC you configured.
- **Replay protection is doubled.** EIP-3009 nonces are consumed on-chain, and settled nonces are also cached in-process to close the window between broadcast and on-chain visibility.
- **No per-user data is collected or stored.** There is no analytics, no database, no transaction-graph logging. Receipts belong to whoever holds them.
- **Contract addresses are never hardcoded.** They resolve at runtime through the Flare `ContractRegistry`, and every protocol constant in the source cites the Flare doc it came from.

Found something? Open an issue, or reach me privately if it's sensitive.

---

## Development

```bash
git clone https://github.com/dziuba0x/flario.git
cd flario
npm install

npm run dev      # watch mode via tsx, no build step
npm run build    # type-check and compile to dist/
npm test         # offline test suite, recorded fixtures, no network
npm start        # run the compiled server
npm run inspect  # open the MCP Inspector against the built server

npx tsx scripts/live-check.ts   # live checks against public RPCs (mainnet, Coston2, Songbird)
```

Stack: TypeScript (ESM, Node 18+), [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk), [`viem`](https://viem.sh), [`zod`](https://zod.dev), and [`@flarenetwork/flare-periphery-contract-artifacts`](https://github.com/flare-foundation/flare-npm-periphery-package).

The build emits an executable `dist/index.js` (with a `#!/usr/bin/env node` shebang) wired to the `flario` bin. You can test a single tool without a client using the Inspector CLI:

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/call --tool-name get_ftso_feed \
  --tool-arg feed_id=FLR/USD --tool-arg network=mainnet
```

---

## License

[MIT](#license), Dziuba Technology / Alan Dziuba.

Built on [Flare Network](https://dev.flare.network). Issues and contributions welcome.
