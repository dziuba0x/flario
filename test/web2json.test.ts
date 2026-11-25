// Tests for Web2Json source binding. Flare's own guide warns that a valid FDC
// proof only says the data came from the URL inside it, not that the URL is
// trustworthy (https://dev.flare.network/fdc/guides/url-parsing-security).
// bindWeb2JsonSource is what closes that gap, so these tests carry the same
// weight as the payment-binding tests.
import { describe, it, expect } from "vitest";
import { encodeAbiParameters } from "viem";
import {
  bindWeb2JsonSource,
  decodeWeb2JsonPayload,
  type SourceExpectation,
} from "../src/tools/web2json.js";

const expected: SourceExpectation = {
  hosts: ["api.coingecko.com"],
  path_prefix: "/api/v3/simple/price",
};

describe("bindWeb2JsonSource: accepts the intended source", () => {
  it("binds an exact match", () => {
    const r = bindWeb2JsonSource(
      "https://api.coingecko.com/api/v3/simple/price?ids=flare",
      "GET",
      expected,
    );
    expect(r.bound).toBe(true);
    expect(r.parsed?.host).toBe("api.coingecko.com");
    expect(r.parsed?.protocol).toBe("https");
  });

  it("accepts a deeper path under the expected prefix", () => {
    const r = bindWeb2JsonSource(
      "https://api.coingecko.com/api/v3/simple/price/extra",
      "GET",
      expected,
    );
    expect(r.bound).toBe(true);
  });

  it("accepts any host from the allowlist", () => {
    const r = bindWeb2JsonSource("https://backup.example.com/data", "GET", {
      hosts: ["api.example.com", "backup.example.com"],
    });
    expect(r.bound).toBe(true);
  });
});

describe("bindWeb2JsonSource: rejects attacker-controlled sources", () => {
  it("rejects a completely different host", () => {
    const r = bindWeb2JsonSource("https://evil.com/api/v3/simple/price", "GET", expected);
    expect(r.bound).toBe(false);
    expect(r.reason).toContain("not in the expected list");
  });

  it("rejects a lookalike subdomain suffix attack", () => {
    // api.coingecko.com.evil.com is NOT api.coingecko.com
    const r = bindWeb2JsonSource(
      "https://api.coingecko.com.evil.com/api/v3/simple/price",
      "GET",
      expected,
    );
    expect(r.bound).toBe(false);
  });

  it("rejects the userinfo trick, where the real host follows an @", () => {
    // A naive "starts with https://api.coingecko.com" check passes this,
    // but the browser/fetch host here is evil.com.
    const r = bindWeb2JsonSource(
      "https://api.coingecko.com@evil.com/api/v3/simple/price",
      "GET",
      expected,
    );
    expect(r.bound).toBe(false);
    expect(r.parsed?.host).toBe("evil.com");
  });

  it("rejects an IDN homograph host", () => {
    // Cyrillic "а" in "аpi" looks identical but is a different host.
    const r = bindWeb2JsonSource(
      "https://аpi.coingecko.com/api/v3/simple/price",
      "GET",
      expected,
    );
    expect(r.bound).toBe(false);
    expect(r.parsed?.host).not.toBe("api.coingecko.com");
  });

  it("rejects prefix injection on the path", () => {
    // Contains the expected path but does not start with it.
    const r = bindWeb2JsonSource(
      "https://api.coingecko.com/evil/api/v3/simple/price",
      "GET",
      expected,
    );
    expect(r.bound).toBe(false);
    expect(r.reason).toContain("does not start with");
  });

  it("rejects plain http, which can be intercepted", () => {
    const r = bindWeb2JsonSource(
      "http://api.coingecko.com/api/v3/simple/price",
      "GET",
      expected,
    );
    expect(r.bound).toBe(false);
    expect(r.reason).toContain("https");
  });

  it("rejects a mismatched HTTP method", () => {
    const r = bindWeb2JsonSource("https://api.coingecko.com/api/v3/simple/price", "POST", {
      ...expected,
      http_method: "GET",
    });
    expect(r.bound).toBe(false);
    expect(r.reason).toContain("method");
  });

  it("refuses to bind when no hosts are given", () => {
    const r = bindWeb2JsonSource("https://api.coingecko.com/x", "GET", { hosts: [] });
    expect(r.bound).toBe(false);
  });

  it("rejects an unparseable URL instead of throwing", () => {
    const r = bindWeb2JsonSource("not a url", "GET", expected);
    expect(r.bound).toBe(false);
    expect(r.reason).toContain("not parseable");
  });

  it("rejects a non-default port when the allowlist specifies only the hostname (Red-Team HIGH #11)", () => {
    const r = bindWeb2JsonSource(
      "https://api.example.com:8443/v1/price",
      "GET",
      { hosts: ["api.example.com"], path_prefix: "/v1/price" },
    );
    expect(r.bound).toBe(false);
    expect(r.reason).toContain("api.example.com:8443");

    // Explicitly allowing :8443 succeeds, and explicit default :443 matches bare host.
    expect(
      bindWeb2JsonSource("https://api.example.com:8443/v1/price", "GET", {
        hosts: ["api.example.com:8443"],
        path_prefix: "/v1/price",
      }).bound,
    ).toBe(true);
    expect(
      bindWeb2JsonSource("https://api.example.com:443/v1/price", "GET", {
        hosts: ["api.example.com"],
        path_prefix: "/v1/price",
      }).bound,
    ).toBe(true);
  });

  it("enforces path segment boundary on path_prefix (Red-Team HIGH #11)", () => {
    const rule: SourceExpectation = {
      hosts: ["api.example.com"],
      path_prefix: "/v1/price",
    };
    expect(
      bindWeb2JsonSource("https://api.example.com/v1/price", "GET", rule).bound,
    ).toBe(true);
    expect(
      bindWeb2JsonSource("https://api.example.com/v1/price/btc", "GET", rule).bound,
    ).toBe(true);

    const sibling = bindWeb2JsonSource(
      "https://api.example.com/v1/price-attacker",
      "GET",
      rule,
    );
    expect(sibling.bound).toBe(false);
    expect(sibling.reason).toContain("segment boundary");
  });

  it("rejects percent-encoded path traversal sequences (Red-Team HIGH #11)", () => {
    const rule: SourceExpectation = {
      hosts: ["api.example.com"],
      path_prefix: "/v1/price",
    };

    const slashTraversal = bindWeb2JsonSource(
      "https://api.example.com/v1/price/%2F..%2F..%2Fadmin",
      "GET",
      rule,
    );
    expect(slashTraversal.bound).toBe(false);
    expect(slashTraversal.reason).toContain("traversal");

    const dotTraversal = bindWeb2JsonSource(
      "https://api.example.com/v1/price/%2e%2e/secret",
      "GET",
      rule,
    );
    expect(dotTraversal.bound).toBe(false);
    expect(dotTraversal.reason).toContain("traversal");

    const trailingSlashTraversal = bindWeb2JsonSource(
      "https://api.example.com/v1/price/..%2fsecret",
      "GET",
      rule,
    );
    expect(trailingSlashTraversal.bound).toBe(false);
    expect(trailingSlashTraversal.reason).toContain("traversal");
  });

  it("enforces post_process_jq and abi_signature when specified in expect_source (Red-Team HIGH #3)", () => {
    const expectedJq = "{price: .flare.usd}";
    const expectedAbi =
      '{"components":[{"internalType":"uint256","name":"price","type":"uint256"}],"name":"dto","type":"tuple"}';
    const rule: SourceExpectation = {
      hosts: ["api.coingecko.com"],
      path_prefix: "/api/v3/simple/price",
      post_process_jq: expectedJq,
      abi_signature: expectedAbi,
    };

    // Attacker uses trusted URL but injects constant jq filter "{price:123456789}"
    const jqMismatch = bindWeb2JsonSource(
      "https://api.coingecko.com/api/v3/simple/price?ids=flare",
      "GET",
      rule,
      { postProcessJq: "{price: 123456789}", abiSignature: expectedAbi },
    );
    expect(jqMismatch.bound).toBe(false);
    expect(jqMismatch.reason).toContain("postProcessJq");

    // Attacker alters abiSignature
    const abiMismatch = bindWeb2JsonSource(
      "https://api.coingecko.com/api/v3/simple/price?ids=flare",
      "GET",
      rule,
      { postProcessJq: expectedJq, abiSignature: "{}" },
    );
    expect(abiMismatch.bound).toBe(false);
    expect(abiMismatch.reason).toContain("abiSignature");

    // Exact match passes
    const exactMatch = bindWeb2JsonSource(
      "https://api.coingecko.com/api/v3/simple/price?ids=flare",
      "GET",
      rule,
      { postProcessJq: expectedJq, abiSignature: expectedAbi },
    );
    expect(exactMatch.bound).toBe(true);
  });
});

describe("bindWeb2JsonSource: host matching is case-insensitive", () => {
  it("treats an uppercase host as the same host (DNS is case-insensitive)", () => {
    const r = bindWeb2JsonSource(
      "https://API.COINGECKO.COM/api/v3/simple/price",
      "GET",
      expected,
    );
    expect(r.bound).toBe(true);
  });

  it("normalizes the allowlist entry too", () => {
    const r = bindWeb2JsonSource("https://api.example.com/x", "GET", {
      hosts: ["API.Example.COM"],
    });
    expect(r.bound).toBe(true);
  });
});

describe("decodeWeb2JsonPayload", () => {
  const abiSignature = JSON.stringify({
    components: [
      { internalType: "string", name: "name", type: "string" },
      { internalType: "uint256", name: "price", type: "uint256" },
    ],
    internalType: "struct DataTransportObject",
    name: "dto",
    type: "tuple",
  });

  it("decodes the attested payload with the request's ABI signature", () => {
    const encoded = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "name", type: "string" },
            { name: "price", type: "uint256" },
          ],
        },
      ],
      [{ name: "flare", price: 6786n }],
    );
    const decoded = decodeWeb2JsonPayload(abiSignature, encoded) as {
      name: string;
      price: bigint;
    };
    expect(decoded.name).toBe("flare");
    expect(decoded.price).toBe(6786n);
  });

  it("gives a clear error when the ABI signature is not valid JSON", () => {
    expect(() => decodeWeb2JsonPayload("{not json", "0x")).toThrow(/not valid JSON/);
  });
});
