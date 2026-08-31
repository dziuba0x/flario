# RECEIPT_SPEC.md: the Flario x402 settlement receipt

Version: `flario-receipt/1`. Implementation: [`src/x402/receipt.ts`](src/x402/receipt.ts).

Every settled x402 payment emits a **Receipt**: a fixed-schema, self-describing,
ZK-ready artifact that records that a payment settled and a tool was paid for.
The receipt is the settlement layer's "organ 3", the atom that future work (agent
passport, portable reputation) will consume. This document is the versioned
contract for that artifact. No ZK circuits are built here; the receipt is only
*shaped* for them.

## Design principles

1. **Payer as a commitment, never plaintext.** The receipt is shareable; it must
   never carry the payer's address in the clear.
2. **Self-describing crypto.** `schema_version`, `commitment_scheme`,
   `hash_scheme` are explicit, so primitives can evolve without breaking holders
   or a future verifier.
3. **Deterministic + anchorable.** A fixed serialization yields a keccak256
   `receipt_hash` any holder can recompute (tamper-evidence) and that can be
   anchored on-chain.
4. **Honest about what it proves.** See the privacy and trust caveats below; the
   receipt never claims a property it does not have in the current settlement
   scheme.

## Schema (v1)

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | `"flario-receipt/1"` | Receipt format version. |
| `commitment_scheme` | `"poseidon-bn254/v1"` | How `payer_commitment` is computed. |
| `hash_scheme` | `"keccak256/v1"` | How `receipt_hash` is computed. |
| `payer_commitment` | `bytes32` hex | Poseidon commitment to the payer (below). Never the address. |
| `blinded` | bool | `true` iff a payer-supplied secret salt was used (real hiding). |
| `payee_address` | address | Payment recipient (checksummed). |
| `amount` | decimal string | Amount in the token's base units. |
| `asset` | address | Payment token (checksummed). |
| `network` | enum | `mainnet` \| `coston2` \| `songbird` \| `coston`. |
| `timestamp` | uint (unix s) | Settlement time. |
| `tool_id` | string | Paid tool identifier (e.g. `fassets_liquidation_scanner`). |
| `settlement_tx_hash` | `bytes32` hex | On-chain settlement transaction. |
| `fdc_attestation_ref` | object \| null | FDC EVMTransaction attestation proving the settlement; `null` until the FDC-verified path has run (see below). |
| `receipt_hash` | `bytes32` hex | keccak256 of the deterministic serialization of every field above. |

`fdc_attestation_ref` (when present):
`{ network, voting_round_id, request_bytes, merkle_root }`.

## `payer_commitment`, Poseidon over BN254

```
payer_commitment = Poseidon2([ payerField, saltField ])
  payerField = int(payer_address)          mod P
  saltField  = int(commitment_salt)         mod P   (0 when no salt supplied)
  P = 21888242871839275222246405745257275088548364400416034343698204186575808495617
      (BN254 scalar field modulus)
```

- **Why Poseidon/BN254.** It is the ZK-native hash for the Circom/snarkjs
  (BabyJubjub + Poseidon) stack that the future passport/reputation project will
  use, cheap inside a circuit, unlike keccak (~150k constraints). Choosing it
  now costs one small dependency (`poseidon-lite`) and avoids rewriting the
  foundation later. The choice is recorded because it is load-bearing
  (handoff Principle 3); `commitment_scheme` makes it upgradeable.
- **Salt semantics.** `commitment_salt` is an **optional, payer-chosen secret**
  passed in the x402 payment payload. With a salt, the commitment is *hiding*
  (only the payer can reopen it, by re-supplying `payer_address` + `salt` to a
  circuit). Without a salt, `saltField = 0`: the commitment is well-formed and
  ZK-consumable but **publicly recomputable**, i.e. not hiding. `blinded` records
  this truthfully.
- **The salt cannot move funds.** It is *not* part of the EIP-712
  `TransferWithAuthorization` signature. It only parameterizes the receipt's
  commitment; a wrong or malicious salt affects nothing but the payer's own
  receipt.

### Privacy caveat (do not overclaim)

Under the current **EIP-3009** settlement, the payer address is already public
on-chain: it appears in the `transferWithAuthorization` calldata and the `Transfer`
event. Therefore `payer_commitment` provides **no additional hiding today**, even
when `blinded = true`: an observer can read the payer from the settlement tx. The
commitment is **structural and forward-looking**. It becomes privacy-bearing
only once settlement runs through a privacy-preserving path (future work). We
emit it now because it costs ~nothing and prevents a foundation rewrite; we do
not claim present-day payer privacy.

## `receipt_hash`, deterministic serialization + keccak256

`receipt_hash = keccak256( utf8( canonical(receipt \ {receipt_hash}) ) )`.

`canonical(...)` (see `canonicalize` in `receipt.ts`) fixes:
- field order exactly as in the schema table;
- addresses checksummed (`getAddress`), all hashes lowercased;
- `fdc_attestation_ref` serialized with its own fixed field order, or `null`.

keccak256 (not Poseidon) is used here on purpose: `receipt_hash` is the
Solidity-native, on-chain-anchorable, tamper-evidence hash. Any holder recomputes
it with `verifyReceiptHash(receipt)`.

**On-chain anchoring (deferred, documented).** v1 does not push `receipt_hash` to
a dedicated anchor contract, because that would add one transaction per paid call and double the gas on
fraction-of-a-cent pricing (a real economics tradeoff, flagged
to the operator). Today the anchor is the immutable `settlement_tx_hash`; when the
FDC-verified path lands, the FDC EVMTransaction attestation is itself an enshrined,
chain-verifiable anchor. A `receipt_hash` anchor contract may be added later
behind a config flag if the economics justify it.

## Trust model

- **v1 (implemented): facilitator-attested.** The server settles the transfer and
  emits the receipt. A holder trusts that the settlement tx exists (verifiable:
  the tx hash is on-chain) but takes the receipt's *binding to a specific tool
  call* on the facilitator's word.
- **v-next (implemented): FDC-verified.** `fdc_attestation_ref` is populated by
  Flare's enshrined FDC **EVMTransaction** attestation over the settlement
  transaction (not Payment, that is for native BTC/DOGE/XRP; see DECISIONS §10),
  so the receipt is provable without trusting the facilitator. This is the
  project's headline differentiator and the reason it is built on Flare.

  Obtain it with the `fdc_verify_settlement` tool: it verifies the attestation's
  Merkle proof locally against the on-chain Relay root **and binds it**: the
  attested tx must contain an ERC-20 `Transfer` of the asset to the payee for at
  least the amount. `attachFdcRef(receipt, ref)` upgrades a receipt to its
  FDC-verified form (populates `fdc_attestation_ref`, recomputes `receipt_hash`;
  every other field, including `payer_commitment`, is preserved).

## Compatibility

The receipt is emitted as `x402_receipt` in both transports:
- MCP: field on the paid tool's JSON result (alongside `x402_payment_receipt`,
  the payer's own settlement summary).
- HTTP hub: field in the 200 response body; the settlement summary stays in the
  `X-Payment-Response` header for x402-client compatibility.

Consumers must ignore unknown fields and branch on `schema_version` /
`commitment_scheme` / `hash_scheme` rather than assuming v1.
