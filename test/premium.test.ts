// Tests for the premium tools' computation cores.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { computeLiquidationRisk } from "../src/tools/premium.js";

interface Fixture {
  vault: string;
  assetDecimals: number;
  info: Record<string, string | number | boolean>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/mainnet-fxrp-agent-info.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function agentSlice(over: Partial<Record<string, bigint | number>> = {}) {
  return {
    status: 0,
    vaultCollateralRatioBIPS: BigInt(fixture.info.vaultCollateralRatioBIPS as string),
    poolCollateralRatioBIPS: BigInt(fixture.info.poolCollateralRatioBIPS as string),
    mintedUBA: BigInt(fixture.info.mintedUBA as string),
    ...over,
  } as Parameters<typeof computeLiquidationRisk>[1];
}

describe("fassets_liquidation_scanner: risk math", () => {
  // Recorded mainnet FXRP agent; typical FAssets minimums: vault 1.3, pool 1.4
  const MIN_VAULT = 13_000n;
  const MIN_POOL = 14_000n;
  const XRP_PRICE = 3.0;

  it("computes headroom from the binding constraint", () => {
    const r = computeLiquidationRisk(
      fixture.vault, agentSlice(), MIN_VAULT, MIN_POOL, XRP_PRICE, 6,
    );
    const expectVault = r.vault_collateral_ratio / 1.3;
    const expectPool = r.pool_collateral_ratio / 1.4;
    expect(r.cr_headroom).toBeCloseTo(Math.min(expectVault, expectPool), 9);
    expect(r.binding_constraint).toBe(expectVault <= expectPool ? "vault" : "pool");
  });

  it("liquidation price scales linearly with headroom", () => {
    const r = computeLiquidationRisk(
      fixture.vault, agentSlice(), MIN_VAULT, MIN_POOL, XRP_PRICE, 6,
    );
    expect(r.asset_price_at_liquidation).toBeCloseTo(XRP_PRICE * r.cr_headroom, 9);
    expect(r.price_rise_to_liquidation_pct).toBeCloseTo((r.cr_headroom - 1) * 100, 9);
  });

  it("an agent exactly at the minimum has zero distance", () => {
    const r = computeLiquidationRisk(
      fixture.vault,
      agentSlice({ vaultCollateralRatioBIPS: 13_000n, poolCollateralRatioBIPS: 99_000n }),
      MIN_VAULT, MIN_POOL, XRP_PRICE, 6,
    );
    expect(r.cr_headroom).toBeCloseTo(1, 9);
    expect(r.price_rise_to_liquidation_pct).toBeCloseTo(0, 9);
    expect(r.asset_price_at_liquidation).toBeCloseTo(XRP_PRICE, 9);
  });

  it("flags agents already in liquidation", () => {
    const r = computeLiquidationRisk(
      fixture.vault, agentSlice({ status: 2 }), MIN_VAULT, MIN_POOL, XRP_PRICE, 6,
    );
    expect(r.status).toBe("LIQUIDATION");
    expect(r.in_liquidation).toBe(true);
  });

  it("reports no liquidation price for an agent with nothing minted", () => {
    const r = computeLiquidationRisk(
      fixture.vault, agentSlice({ mintedUBA: 0n }), MIN_VAULT, MIN_POOL, XRP_PRICE, 6,
    );
    expect(r.asset_price_at_liquidation).toBeNull();
    expect(r.price_rise_to_liquidation_pct).toBeNull();
    expect(r.liability_usd).toBe(0);
    expect(r.topup_to_safe_usd).toBe(0);
    expect(r.liquidated_at_20pct_shock).toBe(false);
  });

  it("computes vault-defense top-up USD and +20% shock cascade flag", () => {
    // 1000 FXRP minted at $3.00 = $3000 liability.
    // Vault CR = 1.40 (above min 1.30 -> headroom 1.077 <= 1.20 -> liquidated at +20% shock).
    // Safety vault CR = 1.60 -> deficit = $3000 * (1.60 - 1.40) = $600.
    const r = computeLiquidationRisk(
      fixture.vault,
      agentSlice({
        vaultCollateralRatioBIPS: 14_000n,
        poolCollateralRatioBIPS: 99_000n,
        mintedUBA: 1_000_000_000n, // 1000 FXRP (6 decimals)
      }),
      MIN_VAULT,
      MIN_POOL,
      XRP_PRICE,
      6,
      16_000n,
      18_000n,
    );
    expect(r.liability_usd).toBeCloseTo(3000, 2);
    expect(r.topup_to_safe_usd).toBeCloseTo(600, 2);
    expect(r.liquidated_at_20pct_shock).toBe(true);
  });
});
