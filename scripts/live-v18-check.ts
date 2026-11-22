// Live read-only verification for Flario v1.8.0 tools (Contract Sentinel + Market Truth Bundle).
// Run: npx tsx scripts/live-v18-check.ts
import { performance } from "node:perf_hooks";
import { sentinelCore, type BytecodeRiskAnalysis } from "../src/tools/sentinel.js";
import {
  marketTruthCore,
  verifyMarketTruthCertificate,
  type MarketTruthCertificate,
} from "../src/tools/market-truth.js";

interface ToolResponse {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}

interface SentinelPayload extends BytecodeRiskAnalysis {
  address: string;
  network: string;
  balance_wei: string;
  balance_native: string;
}

interface MarketTruthPayload {
  certificate: MarketTruthCertificate;
  verification: string;
}

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  const status = ok ? "PASS" : "FAIL";
  process.stdout.write(`${status}  ${label}${detail ? ` — ${detail}` : ""}\n`);
  if (!ok) failures++;
}

function parseTool<T>(res: ToolResponse): T {
  if (res.isError) {
    throw new Error(res.content[0]?.text ?? "Unknown tool error");
  }
  return JSON.parse(res.content[0].text) as T;
}

function formatSelectors(selectors: BytecodeRiskAnalysis["detected_selectors"]): string {
  if (selectors.length === 0) return "none";
  return selectors.map((s) => `${s.selector} (${s.category})`).join(", ");
}

async function runSentinelCheck(
  label: string,
  address: string,
  network: "coston2" | "mainnet",
): Promise<void> {
  const t0 = performance.now();
  try {
    const data = parseTool<SentinelPayload>(await sentinelCore({ address, network }));
    const elapsedMs = Math.round(performance.now() - t0);

    const validShape =
      data.is_contract === true &&
      data.bytecode_bytes > 0 &&
      typeof data.risk_score === "number" &&
      data.risk_score >= 0 &&
      data.risk_score <= 100 &&
      typeof data.proxy_type === "string" &&
      Array.isArray(data.detected_selectors);

    const proxyDetail =
      data.proxy_type !== "NONE" && data.proxy_implementation
        ? `${data.proxy_type} -> ${data.proxy_implementation}`
        : data.proxy_type;

    check(
      label,
      validShape,
      `${elapsedMs}ms | risk_score=${data.risk_score} (${data.risk_level}) | proxy_type=${proxyDetail} | bytecode=${data.bytecode_bytes}B | detected_selectors=[${formatSelectors(data.detected_selectors)}]`,
    );
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - t0);
    const msg = err instanceof Error ? err.message : String(err);
    check(label, false, `${elapsedMs}ms | error=${msg}`);
  }
}

async function runMarketTruthCheck(): Promise<void> {
  const label = "market_truth_bundle coston2 (FLR/USD, XRP/USD)";
  const claimNote = "Flario v1.8.0 live verification";
  const t0 = performance.now();
  try {
    const body = parseTool<MarketTruthPayload>(
      await marketTruthCore({
        feeds: ["FLR/USD", "XRP/USD"],
        network: "coston2",
        claim_note: claimNote,
      }),
    );
    const elapsedMs = Math.round(performance.now() - t0);

    const cert = body.certificate;
    const verification = verifyMarketTruthCertificate(cert);
    const prices = cert.feeds
      .map((f) => `${f.name}=$${f.price.toFixed(6)} (round ${f.voting_round_id})`)
      .join(", ");

    const ok =
      cert.all_verified === true &&
      cert.feed_count === 2 &&
      cert.feeds.length === 2 &&
      cert.claim_note === claimNote &&
      verification.valid === true;

    check(
      label,
      ok,
      `${elapsedMs}ms | feeds=[${prices}] | certificate_hash=${cert.certificate_hash} | valid=${verification.valid}${verification.reason ? ` (${verification.reason})` : ""}`,
    );
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - t0);
    const msg = err instanceof Error ? err.message : String(err);
    check(label, false, `${elapsedMs}ms | error=${msg}`);
  }
}

async function main(): Promise<void> {
  const totalStart = performance.now();
  process.stdout.write("=== Flario v1.8.0 Live Verification (read-only) ===\n");

  await runSentinelCheck(
    "sentinel coston2 USDT0 (0xce13…d8EB)",
    "0xce13911D4896200b543a61E4ae8E829E661Dd8EB",
    "coston2",
  );

  await runSentinelCheck(
    "sentinel mainnet USD₮0 (0xe7cd…C82D)",
    "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
    "mainnet",
  );

  await runMarketTruthCheck();

  const totalMs = Math.round(performance.now() - totalStart);
  process.stdout.write(
    `\nSummary: ${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} in ${totalMs}ms\n`,
  );

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
