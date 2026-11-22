// Unit tests for flare_contract_sentinel static EVM bytecode & proxy risk analyzer.
import { describe, it, expect } from "vitest";
import {
  analyzeBytecodeRisk,
  mergeProxyAndImplRisk,
  EIP1967_ADMIN_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  flareContractSentinelInput,
} from "../src/tools/sentinel.js";

describe("flare_contract_sentinel: analyzeBytecodeRisk", () => {
  it("identifies an EOA when bytecode is empty (0x or empty string)", () => {
    for (const empty of ["0x", "", "   0X  "]) {
      const res = analyzeBytecodeRisk(empty);
      expect(res.is_contract).toBe(false);
      expect(res.bytecode_bytes).toBe(0);
      expect(res.proxy_type).toBe("NONE");
      expect(res.proxy_implementation).toBeNull();
      expect(res.proxy_admin).toBeNull();
      expect(res.risk_score).toBe(0);
      expect(res.risk_level).toBe("LOW");
      expect(res.red_flags).toEqual([]);
      expect(res.detected_selectors).toEqual([]);
      expect(res.opcodes).toEqual({
        selfdestruct: 0,
        delegatecall: 0,
        create2: 0,
        create: 0,
        origin: 0,
      });
      expect(res.verdict).toMatch(/EOA/i);
    }
  });

  it("scores a clean ERC-20 style contract as LOW risk with zero red flags", () => {
    // PUSH1 0x80, PUSH1 0x40, MSTORE, PUSH4 a9059cbb (transfer), EQ, STOP
    const cleanBytecode = "0x608060405263a9059cbb1400";
    const res = analyzeBytecodeRisk(cleanBytecode);

    expect(res.is_contract).toBe(true);
    expect(res.bytecode_bytes).toBe(12);
    expect(res.proxy_type).toBe("NONE");
    expect(res.risk_score).toBe(0);
    expect(res.risk_level).toBe("LOW");
    expect(res.red_flags).toEqual([]);
    expect(res.detected_selectors).toHaveLength(1);
    expect(res.detected_selectors[0]).toEqual({
      selector: "0xa9059cbb",
      signature: "transfer(address,uint256)",
      category: "ERC-20",
    });
  });

  it("does NOT trigger false positives for 0xff/0xf4/0xf5/0xf0/0x32 inside PUSH32 or PUSH1 immediate data", () => {
    // PUSH32 followed by 32 bytes packed with 0xff, 0xf4, 0xf5, 0xf0, 0x32,
    // followed by PUSH1 0xff, then STOP (0x00).
    const push32Data =
      "fff4f5f032fff4f5f032fff4f5f032fff4f5f032fff4f5f032fff4f5f032ffff";
    expect(push32Data.length).toBe(64);
    const bytecode = `0x7f${push32Data}60ff00`;

    const res = analyzeBytecodeRisk(bytecode);
    expect(res.is_contract).toBe(true);
    expect(res.opcodes).toEqual({
      selfdestruct: 0,
      delegatecall: 0,
      create2: 0,
      create: 0,
      origin: 0,
    });
    expect(res.risk_score).toBe(0);
    expect(res.risk_level).toBe("LOW");
    expect(res.red_flags).toEqual([]);
  });

  it("detects real SELFDESTRUCT (0xff) and ORIGIN (0x32) opcodes as HIGH risk", () => {
    // ORIGIN (0x32), PUSH1 0x00, SELFDESTRUCT (0xff), STOP (0x00)
    const bytecode = "0x326000ff00";
    const res = analyzeBytecodeRisk(bytecode);

    expect(res.opcodes.selfdestruct).toBe(1);
    expect(res.opcodes.origin).toBe(1);
    expect(res.opcodes.delegatecall).toBe(0);
    expect(res.risk_score).toBe(65);
    expect(res.risk_level).toBe("HIGH");
    expect(res.red_flags.some((f) => f.includes("SELFDESTRUCT"))).toBe(true);
    expect(res.red_flags.some((f) => f.includes("ORIGIN"))).toBe(true);
  });

  it("detects EIP-1167 minimal proxy and extracts the implementation address", () => {
    const implLower = "1111111111111111111111111111111111111111";
    // Standard 45-byte EIP-1167 runtime bytecode (contains DELEGATECALL 0xf4).
    const eip1167 = `0x363d3d373d3d3d363d73${implLower}5af43d82803e903d91602b57fd5bf3`;

    const res = analyzeBytecodeRisk(eip1167);
    expect(res.is_contract).toBe(true);
    expect(res.bytecode_bytes).toBe(45);
    expect(res.proxy_type).toBe("EIP-1167");
    expect(res.proxy_implementation).toBe("0x1111111111111111111111111111111111111111");
    expect(res.opcodes.delegatecall).toBe(1);
    expect(res.risk_score).toBe(25);
    expect(res.risk_level).toBe("MEDIUM");
    expect(res.red_flags.some((f) => f.includes("EIP-1167"))).toBe(true);
  });

  it("detects EIP-1967 proxy with implementation and admin slots", () => {
    // Minimal proxy body with DELEGATECALL (0xf4)
    const proxyCode = "0x366000803760008036600073deadbeefdeadbeefdeadbeefdeadbeefdeadbeef5af400";
    const implSlot =
      "0x000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const adminSlot =
      "0x0000000000000000000000001234567890123456789012345678901234567890";

    const res = analyzeBytecodeRisk(proxyCode, {
      eip1967Impl: implSlot,
      eip1967Admin: adminSlot,
    });

    expect(res.proxy_type).toBe("EIP-1967");
    expect(res.proxy_implementation).toBe("0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD");
    expect(res.proxy_admin).toBe("0x1234567890123456789012345678901234567890");
    expect(res.opcodes.delegatecall).toBe(1);
    // 15 (proxy delegatecall) + 15 (EIP-1967 impl) + 10 (EIP-1967 admin) = 40
    expect(res.risk_score).toBe(40);
    expect(res.risk_level).toBe("MEDIUM");
    expect(res.red_flags.some((f) => f.includes("EIP-1967 proxy"))).toBe(true);
    expect(res.red_flags.some((f) => f.includes("proxy admin"))).toBe(true);
  });

  it("ignores zero EIP-1967 storage slots", () => {
    const zeroSlot = "0x" + "0".repeat(64);
    const res = analyzeBytecodeRisk("0x600160020100", {
      eip1967Impl: zeroSlot,
      eip1967Admin: zeroSlot,
    });

    expect(res.proxy_type).toBe("NONE");
    expect(res.proxy_implementation).toBeNull();
    expect(res.proxy_admin).toBeNull();
    expect(res.risk_score).toBe(0);
  });

  it("detects EIP-3009, Ownable, Pausable, Upgradeable, and Mintable selectors", () => {
    // Dispatcher with PUSH4 for each selector:
    // e3ee160e (EIP-3009 v,r,s), cf092995 (EIP-3009 bytes), 8da5cb5b (owner),
    // 8456cb59 (pause), 3659cfe6 (upgradeTo), 40c10f19 (mint)
    const bytecode =
      "0x" +
      "63e3ee160e" +
      "63cf092995" +
      "638da5cb5b" +
      "638456cb59" +
      "633659cfe6" +
      "6340c10f19" +
      "00";

    const res = analyzeBytecodeRisk(bytecode);
    const selectors = res.detected_selectors.map((s) => s.selector);

    expect(selectors).toContain("0xe3ee160e");
    expect(selectors).toContain("0xcf092995");
    expect(selectors).toContain("0x8da5cb5b");
    expect(selectors).toContain("0x8456cb59");
    expect(selectors).toContain("0x3659cfe6");
    expect(selectors).toContain("0x40c10f19");
    // 15 (upgradeTo) + 10 (mint) + 10 (pause) + 5 (owner) = 40
    expect(res.risk_score).toBe(40);
    expect(res.risk_level).toBe("MEDIUM");
  });

  it("clamps risk_score strictly within [0, 100] and reports CRITICAL when saturated", () => {
    // Combine SELFDESTRUCT (0xff), ORIGIN (0x32), DELEGATECALL (0xf4),
    // CREATE2 (0xf5), CREATE (0xf0), plus upgradeTo/mint/pause/owner selectors,
    // plus EIP-1967 impl + admin.
    const kitchenSink =
      "0x" +
      "fff4f5f032" +
      "633659cfe6" +
      "6340c10f19" +
      "638456cb59" +
      "638da5cb5b" +
      "00";

    const res = analyzeBytecodeRisk(kitchenSink, {
      eip1967Impl: "0x0000000000000000000000001111111111111111111111111111111111111111",
      eip1967Admin: "0x0000000000000000000000002222222222222222222222222222222222222222",
    });

    expect(res.risk_score).toBeGreaterThanOrEqual(0);
    expect(res.risk_score).toBeLessThanOrEqual(100);
    expect(res.risk_score).toBe(100);
    expect(res.risk_level).toBe("CRITICAL");
    expect(res.opcodes).toEqual({
      selfdestruct: 1,
      delegatecall: 1,
      create2: 1,
      create: 1,
      origin: 1,
    });
  });

  it("rejects malformed hex strings and exposes valid EIP-1967 constants & input schema", () => {
    expect(() => analyzeBytecodeRisk("0x123")).toThrow(/Invalid hex/i);
    expect(() => analyzeBytecodeRisk("0xzzzz")).toThrow(/Invalid hex/i);
    expect(EIP1967_IMPLEMENTATION_SLOT).toBe(
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    );
    expect(EIP1967_ADMIN_SLOT).toBe(
      "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
    );
    expect(flareContractSentinelInput.address).toBeDefined();
    expect(flareContractSentinelInput.network).toBeDefined();
    expect(flareContractSentinelInput.x402_payment).toBeDefined();
  });
});

describe("flare_contract_sentinel: mergeProxyAndImplRisk", () => {
  it("merges an EIP-1967 proxy with a clean ERC-20 + EIP-3009 implementation and attaches implementation_analysis", () => {
    const proxyCode =
      "0x366000803760008036600073deadbeefdeadbeefdeadbeefdeadbeefdeadbeef5af400";
    const implSlot =
      "0x000000000000000000000000779ded0c9e1022225f8e0630b35a9b54be713736";
    const proxyAnalysis = analyzeBytecodeRisk(proxyCode, { eip1967Impl: implSlot });
    expect(proxyAnalysis.detected_selectors).toEqual([]);
    expect(proxyAnalysis.risk_score).toBe(30); // 15 (delegatecall) + 15 (EIP-1967)

    // Clean implementation exposing ERC-20 transfer + EIP-3009 transferWithAuthorization (v,r,s)
    const implCode = "0x63a9059cbb63e3ee160e00";
    const implAnalysis = analyzeBytecodeRisk(implCode);

    const merged = mergeProxyAndImplRisk(proxyAnalysis, implAnalysis);
    expect(merged.proxy_type).toBe("EIP-1967");
    expect(merged.proxy_implementation).toBe("0x779Ded0c9e1022225f8E0630b35a9b54bE713736");
    expect(merged.risk_score).toBe(30);
    expect(merged.risk_level).toBe("MEDIUM");
    expect(merged.detected_selectors.map((s) => s.selector)).toEqual([
      "0xa9059cbb",
      "0xe3ee160e",
    ]);
    expect(merged.implementation_analysis).toBeDefined();
    expect(merged.implementation_analysis?.is_contract).toBe(true);
    expect(merged.implementation_analysis?.bytecode_bytes).toBe(11);
    expect(merged.implementation_analysis?.detected_selectors).toHaveLength(2);
    expect(merged.implementation_analysis?.red_flags).toEqual([]);
  });

  it("escalates risk to HIGH/CRITICAL when a proxy hides SELFDESTRUCT and ORIGIN in its implementation", () => {
    const implLower = "1111111111111111111111111111111111111111";
    const eip1167 = `0x363d3d373d3d3d363d73${implLower}5af43d82803e903d91602b57fd5bf3`;
    const proxyAnalysis = analyzeBytecodeRisk(eip1167);
    expect(proxyAnalysis.risk_score).toBe(25);
    expect(proxyAnalysis.risk_level).toBe("MEDIUM");

    // Malicious implementation with SELFDESTRUCT (0xff) and ORIGIN (0x32)
    const maliciousImpl = analyzeBytecodeRisk("0x326000ff00");
    const merged = mergeProxyAndImplRisk(proxyAnalysis, maliciousImpl);

    // 25 (EIP-1167) + 45 (SELFDESTRUCT) + 20 (ORIGIN) = 90 -> CRITICAL
    expect(merged.risk_score).toBe(90);
    expect(merged.risk_level).toBe("CRITICAL");
    expect(merged.verdict).toMatch(/Critical risk/i);
    expect(
      merged.red_flags.some((f) => f.includes("[Implementation]") && f.includes("SELFDESTRUCT")),
    ).toBe(true);
    expect(
      merged.red_flags.some((f) => f.includes("[Implementation]") && f.includes("ORIGIN")),
    ).toBe(true);
    expect(merged.implementation_analysis?.opcodes.selfdestruct).toBe(1);
    expect(merged.implementation_analysis?.opcodes.origin).toBe(1);
  });

  it("deduplicates overlapping selectors and avoids double-counting shared selector risk penalties", () => {
    // Proxy shell containing upgradeTo (3659cfe6) and owner (8da5cb5b) + DELEGATECALL
    const proxyCode = "0x633659cfe6638da5cb5b5af400";
    const proxyAnalysis = analyzeBytecodeRisk(proxyCode, {
      eip1967Impl: "0x000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    });
    // 15 (delegatecall) + 15 (EIP-1967) + 15 (upgradeTo) + 5 (owner) = 50
    expect(proxyAnalysis.risk_score).toBe(50);

    // Implementation also has upgradeTo (3659cfe6) and owner (8da5cb5b), plus mint (40c10f19) & transfer (a9059cbb)
    const implCode = "0x633659cfe6638da5cb5b6340c10f1963a9059cbb00";
    const implAnalysis = analyzeBytecodeRisk(implCode);

    const merged = mergeProxyAndImplRisk(proxyAnalysis, implAnalysis);
    const selectors = merged.detected_selectors.map((s) => s.selector);

    expect(selectors).toEqual([
      "0x8da5cb5b",
      "0x3659cfe6",
      "0xa9059cbb",
      "0x40c10f19",
    ]);
    expect(new Set(selectors).size).toBe(selectors.length);
    // Only mint (+10) is newly added; upgradeTo and owner were already counted on proxy shell.
    expect(merged.risk_score).toBe(60);
    expect(merged.risk_level).toBe("HIGH");
  });

  it("flags a proxy pointing to an empty/EOA implementation and clamps risk_score within [0, 100]", () => {
    const proxyCode =
      "0x366000803760008036600073deadbeefdeadbeefdeadbeefdeadbeefdeadbeef5af400";
    const proxyAnalysis = analyzeBytecodeRisk(proxyCode, {
      eip1967Impl: "0x0000000000000000000000001111111111111111111111111111111111111111",
    });
    const emptyImpl = analyzeBytecodeRisk("0x");

    const merged = mergeProxyAndImplRisk(proxyAnalysis, emptyImpl);
    expect(merged.risk_score).toBe(50); // 30 + 20
    expect(merged.risk_level).toBe("HIGH");
    expect(merged.implementation_analysis?.is_contract).toBe(false);
    expect(merged.implementation_analysis?.bytecode_bytes).toBe(0);
    expect(
      merged.red_flags.some((f) => f.includes("[Implementation]") && f.includes("no deployed bytecode")),
    ).toBe(true);
  });
});
