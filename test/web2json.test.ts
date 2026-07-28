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
