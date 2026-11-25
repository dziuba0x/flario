// Unit tests for Proof-of-Market-Truth certificates and input guards.
import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import {
  MARKET_TRUTH_SCHEMA_VERSION,
  MAX_MARKET_TRUTH_FEEDS,
  buildMarketTruthCertificate,
  verifyMarketTruthCertificate,
  computeCertificateHash,
  marketTruthCore,
  marketTruthBundleInput,
  verifyMarketTruthCore,
  verifyMarketTruthInput,
  type VerifiedMarketFeed,
} from "../src/tools/market-truth.js";
import { anchorFeedLeaf, anchorFeedPrice } from "../src/utils/ftso-da.js";
import { foldMerkleProof } from "../src/utils/fdc.js";

const PROOF_1 =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const PROOF_2 =
  "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;

const FLR_FEED_ID = "0x01464c522f55534400000000000000000000000000" as Hex;
const XRP_FEED_ID = "0x015852502f55534400000000000000000000000000" as Hex;
const BTC_FEED_ID = "0x014254432f55534400000000000000000000000000" as Hex;

function makeVerifiedFeed(params: {
  name: string;
  feed_id: Hex;
  raw_value: number;
  decimals: number;
  turnout_bips: number;
  voting_round_id: number;
  proof: Hex[];
}): VerifiedMarketFeed {
  const body = {
    votingRoundId: params.voting_round_id,
    id: params.feed_id,
    value: params.raw_value,
    turnoutBIPS: params.turnout_bips,
    decimals: params.decimals,
  };
  const leaf = anchorFeedLeaf(body);
  const merkle_root = foldMerkleProof(leaf, params.proof);
  return {
    name: params.name,
    feed_id: params.feed_id,
    price: anchorFeedPrice(body),
    raw_value: params.raw_value,
    decimals: params.decimals,
    turnout_bips: params.turnout_bips,
    voting_round_id: params.voting_round_id,
    merkle_root,
    proof: params.proof,
    verified: true,
  };
}

function sampleFeeds(): VerifiedMarketFeed[] {
  return [
    makeVerifiedFeed({
      name: "FLR/USD",
      feed_id: FLR_FEED_ID,
      raw_value: 2450,
      decimals: 5,
      turnout_bips: 9500,
      voting_round_id: 912345,
      proof: [PROOF_1, PROOF_2],
    }),
    makeVerifiedFeed({
      name: "XRP/USD",
      feed_id: XRP_FEED_ID,
      raw_value: 241000,
      decimals: 5,
      turnout_bips: 9800,
      voting_round_id: 912345,
      proof: [PROOF_2],
    }),
    makeVerifiedFeed({
      name: "BTC/USD",
      feed_id: BTC_FEED_ID,
      raw_value: 9850025,
      decimals: 2,
      turnout_bips: 9900,
      voting_round_id: 912345,
      proof: [PROOF_1],
    }),
  ];
}

describe("buildMarketTruthCertificate & verifyMarketTruthCertificate", () => {
  it("builds a complete certificate with expected fields and stats", () => {
    const cert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      claim_note: "Collateral snapshot before rebalance",
      feeds: sampleFeeds(),
    });

    expect(cert.network).toBe("mainnet");
    expect(cert.created_at).toBe(1790000000);
    expect(cert.claim_note).toBe("Collateral snapshot before rebalance");
    expect(cert.feeds).toHaveLength(3);
    expect(cert.feed_count).toBe(3);
    expect(cert.all_verified).toBe(true);
    expect(cert.certificate_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('sets literal schema_version === "flario-market-truth/1"', () => {
    const cert = buildMarketTruthCertificate({
      network: "coston2",
      created_at: 1790000001,
      feeds: sampleFeeds().slice(0, 1),
    });

    expect(MARKET_TRUTH_SCHEMA_VERSION).toBe("flario-market-truth/1");
    expect(cert.schema_version).toBe("flario-market-truth/1");
  });

  it("produces a deterministic certificate_hash independent of key order", () => {
    const certA = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      claim_note: "Deterministic check",
      feeds: sampleFeeds(),
    });
    const certB = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      claim_note: "Deterministic check",
      feeds: sampleFeeds(),
    });

    expect(certA.certificate_hash).toBe(certB.certificate_hash);

    // Reorder top-level keys on the unsigned payload and confirm identical hash.
    const reorderedUnsigned = {
      all_verified: certA.all_verified,
      feed_count: certA.feed_count,
      feeds: certA.feeds,
      claim_note: certA.claim_note,
      created_at: certA.created_at,
      network: certA.network,
      schema_version: certA.schema_version,
    };
    expect(computeCertificateHash(reorderedUnsigned)).toBe(certA.certificate_hash);
  });

  it("verifies valid certificates both with and without claim_note", () => {
    const withNote = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      claim_note: "Settlement reference",
      feeds: sampleFeeds(),
    });
    const withoutNote = buildMarketTruthCertificate({
      network: "songbird",
      created_at: 1790000000,
      feeds: sampleFeeds().slice(0, 1),
    });

    expect(verifyMarketTruthCertificate(withNote)).toEqual({ valid: true });
    expect(verifyMarketTruthCertificate(withoutNote)).toEqual({ valid: true });
  });

  it("detects price tampering", () => {
    const cert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      feeds: sampleFeeds(),
    });
    const tampered = {
      ...cert,
      feeds: cert.feeds.map((f, i) => (i === 0 ? { ...f, price: 0.9999 } : f)),
    };

    const res = verifyMarketTruthCertificate(tampered);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("certificate_hash mismatch");
  });

  it("detects voting_round_id tampering", () => {
    const cert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      feeds: sampleFeeds(),
    });
    const tampered = {
      ...cert,
      feeds: cert.feeds.map((f, i) =>
        i === 1 ? { ...f, voting_round_id: f.voting_round_id + 1 } : f,
      ),
    };

    const res = verifyMarketTruthCertificate(tampered);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("certificate_hash mismatch");
  });

  it("detects claim_note tampering (modified or injected)", () => {
    const cert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      claim_note: "Original note",
      feeds: sampleFeeds(),
    });

    const modified = { ...cert, claim_note: "Altered note" };
    const modRes = verifyMarketTruthCertificate(modified);
    expect(modRes.valid).toBe(false);
    expect(modRes.reason).toContain("certificate_hash mismatch");

    const noNoteCert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      feeds: sampleFeeds(),
    });
    const injected = { ...noNoteCert, claim_note: "Injected after signing" };
    const injRes = verifyMarketTruthCertificate(injected);
    expect(injRes.valid).toBe(false);
    expect(injRes.reason).toContain("certificate_hash mismatch");
  });

  it("detects certificate_hash tampering", () => {
    const cert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      feeds: sampleFeeds(),
    });
    const tampered = {
      ...cert,
      certificate_hash:
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex,
    };

    const res = verifyMarketTruthCertificate(tampered);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("certificate_hash mismatch");
  });

  it("rejects invalid schema_version", () => {
    const cert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      feeds: sampleFeeds(),
    });
    const badSchema = { ...cert, schema_version: "flario-market-truth/99" };

    const res = verifyMarketTruthCertificate(badSchema);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("invalid schema_version");
  });

  it("rejects certificates with missing feeds or missing Merkle proofs", () => {
    const emptyFeedsCert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      feeds: [],
    });
    const emptyRes = verifyMarketTruthCertificate(emptyFeedsCert);
    expect(emptyRes.valid).toBe(false);
    expect(emptyRes.reason).toContain("non-empty array");

    const noProofFeed: VerifiedMarketFeed = {
      name: "FLR/USD",
      feed_id: FLR_FEED_ID,
      price: 0.0245,
      raw_value: 2450,
      decimals: 5,
      turnout_bips: 9500,
      voting_round_id: 912345,
      merkle_root: PROOF_1,
      proof: [],
      verified: true,
    };
    const noProofCert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      feeds: [noProofFeed],
    });
    const noProofRes = verifyMarketTruthCertificate(noProofCert);
    expect(noProofRes.valid).toBe(false);
    expect(noProofRes.reason).toContain("proof");
  });

  it("rejects a forged certificate with recomputed certificate_hash and fake price=1 (Red-Team CRITICAL #1)", () => {
    const legit = sampleFeeds();

    // Attack A: alter price to 1 and recompute certificate_hash (keeping original raw_value/proof).
    const forgedPriceOnly = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      feeds: legit.map((f, i) => (i === 0 ? { ...f, price: 1 } : f)),
    });
    const resA = verifyMarketTruthCertificate(forgedPriceOnly);
    expect(resA.valid).toBe(false);
    expect(resA.reason).toContain("does not match raw_value/10^decimals");

    // Attack B: alter BOTH price=1 AND raw_value=100000 (consistent with decimals=5),
    // keep the real merkle_root + proof, and recompute certificate_hash.
    const forgedBodyAndPrice = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      feeds: legit.map((f, i) =>
        i === 0 ? { ...f, price: 1, raw_value: 100000 } : f,
      ),
    });
    const resB = verifyMarketTruthCertificate(forgedBodyAndPrice);
    expect(resB.valid).toBe(false);
    expect(resB.reason).toContain("Merkle proof does not fold to merkle_root");

    // Attack C: tamper with a Merkle proof sibling and recompute certificate_hash.
    const forgedProof = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      feeds: legit.map((f, i) =>
        i === 0
          ? {
              ...f,
              proof: [
                "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex,
                ...f.proof.slice(1),
              ],
            }
          : f,
      ),
    });
    const resC = verifyMarketTruthCertificate(forgedProof);
    expect(resC.valid).toBe(false);
    expect(resC.reason).toContain("Merkle proof does not fold to merkle_root");
  });
});

describe("marketTruthCore input guards & x402 schema", () => {
  it("exposes x402_payment on marketTruthBundleInput", () => {
    expect(marketTruthBundleInput).toHaveProperty("x402_payment");
    expect(marketTruthBundleInput).toHaveProperty("feeds");
    expect(marketTruthBundleInput).toHaveProperty("network");
  });

  it("refuses empty feeds and > 8 feeds before touching network", async () => {
    const emptyRes = await marketTruthCore({ feeds: [], network: "mainnet" });
    expect(emptyRes.isError).toBe(true);
    expect(emptyRes.content[0].text).toContain("At least one");

    const tooMany = Array.from(
      { length: MAX_MARKET_TRUTH_FEEDS + 1 },
      (_, i) => `FEED${i}/USD`,
    );
    const overRes = await marketTruthCore({ feeds: tooMany, network: "mainnet" });
    expect(overRes.isError).toBe(true);
    expect(overRes.content[0].text).toContain(String(MAX_MARKET_TRUTH_FEEDS));
  });
});

describe("verifyMarketTruthCore (free offline companion tool)", () => {
  it("exposes certificate input without x402_payment", () => {
    expect(verifyMarketTruthInput).toHaveProperty("certificate");
    expect(verifyMarketTruthInput).not.toHaveProperty("x402_payment");
  });

  it("verifies a valid certificate passed as an object", async () => {
    const cert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      claim_note: "Object input check",
      feeds: sampleFeeds(),
    });

    const res = await verifyMarketTruthCore({ certificate: cert });
    const parsed = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(parsed).toEqual({
      valid: true,
      schema_version: MARKET_TRUTH_SCHEMA_VERSION,
      network: "mainnet",
      feed_count: 3,
      certificate_hash: cert.certificate_hash,
    });
  });

  it("verifies a valid certificate passed as a JSON string", async () => {
    const cert = buildMarketTruthCertificate({
      network: "coston2",
      created_at: 1790000005,
      feeds: sampleFeeds().slice(0, 2),
    });

    const res = await verifyMarketTruthCore({ certificate: JSON.stringify(cert) });
    const parsed = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(parsed).toEqual({
      valid: true,
      schema_version: MARKET_TRUTH_SCHEMA_VERSION,
      network: "coston2",
      feed_count: 2,
      certificate_hash: cert.certificate_hash,
    });
  });

  it("reports tampered certificates as invalid with reason", async () => {
    const cert = buildMarketTruthCertificate({
      network: "mainnet",
      created_at: 1790000000,
      claim_note: "Original",
      feeds: sampleFeeds(),
    });
    const tampered = { ...cert, claim_note: "Tampered" };

    const res = await verifyMarketTruthCore({ certificate: tampered });
    const parsed = JSON.parse(res.content[0].text) as {
      valid: boolean;
      reason?: string;
      schema_version: string | null;
      network: string | null;
      feed_count: number | null;
      certificate_hash: string | null;
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.reason).toContain("certificate_hash mismatch");
    expect(parsed.schema_version).toBe(MARKET_TRUTH_SCHEMA_VERSION);
    expect(parsed.network).toBe("mainnet");
    expect(parsed.feed_count).toBe(3);
    expect(parsed.certificate_hash).toBe(cert.certificate_hash);
  });

  it("handles malformed JSON strings safely without throwing", async () => {
    const res = await verifyMarketTruthCore({ certificate: "{broken-json" });
    const parsed = JSON.parse(res.content[0].text) as {
      valid: boolean;
      reason?: string;
      schema_version: string | null;
      network: string | null;
      feed_count: number | null;
      certificate_hash: string | null;
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.reason).toContain("invalid JSON string");
    expect(parsed.schema_version).toBeNull();
    expect(parsed.network).toBeNull();
    expect(parsed.feed_count).toBeNull();
    expect(parsed.certificate_hash).toBeNull();
  });
});
