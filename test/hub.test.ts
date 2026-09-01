// Integration tests for hub mode (HTTP transport + spec-style x402 REST).
// Fully offline: only endpoints that don't reach the chain are exercised.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { startHub } from "../src/hub.js";

const PORT = 18402 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PAYEE = "0x00000000000000000000000000000000000000A1";

let server: Server;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["X402_ENABLED", "X402_NETWORK", "X402_PAY_TO"]) {
    saved[k] = process.env[k];
  }
  process.env.X402_ENABLED = "true";
  process.env.X402_NETWORK = "coston2";
  process.env.X402_PAY_TO = PAYEE;
  server = await startHub(PORT);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((resolve) => server.close(resolve));
});

describe("hub HTTP endpoints", () => {
  it("serves discovery info at /", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      endpoints: Record<string, string>;
      x402: { enabled: boolean; payTo?: string };
    };
    expect(body.name).toBe("flario");
    expect(body.endpoints.mcp).toContain("POST /mcp");
    expect(body.x402.enabled).toBe(true);
    expect(body.x402.payTo).toBe(PAYEE);
  });

  it("serves /healthz", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
  });

  it("lists all 24 tools over MCP Streamable HTTP", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.length).toBe(24);
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("fassets_liquidation_scanner");
    expect(names).toContain("fdc_request_attestation");
    // Hub mode must expose the evidence tools too: a bundle is most useful
    // when the party verifying it is reaching a hosted endpoint, not stdio.
    expect(names).toContain("evidence_bundle");
    expect(names).toContain("evidence_verify");
    expect(names).toContain("fcc_deployment_status");
  });

  it("returns 402 with x402 requirements on unpaid premium REST", async () => {
    const res = await fetch(
      `${BASE}/api/premium/liquidation-scanner?asset=FXRP&network=coston2`,
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      x402Version: number;
      accepts: Array<{ payTo: string; resource: string; scheme: string }>;
    };
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0].scheme).toBe("exact");
    expect(body.accepts[0].payTo).toBe(PAYEE);
    expect(body.accepts[0].resource).toContain("/api/premium/liquidation-scanner");
  });

  it("rejects a malformed X-Payment with 402, not 500", async () => {
    const res = await fetch(
      `${BASE}/api/premium/liquidation-scanner?asset=FXRP&network=coston2`,
      { headers: { "X-Payment": Buffer.from('{"from":"0x1"}').toString("base64") } },
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("payment failed");
  });

  it("validates the proof-bundle body", async () => {
    const res = await fetch(`${BASE}/api/premium/proof-bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [], network: "coston2" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s unknown routes and 405s GET /mcp", async () => {
    expect((await fetch(`${BASE}/nope`)).status).toBe(404);
    expect((await fetch(`${BASE}/mcp`)).status).toBe(405);
  });
});
