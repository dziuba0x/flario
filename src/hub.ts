// Hub mode: Flario as a hostable paid service.
//
//   POST /mcp                            MCP Streamable HTTP (stateless) —
//                                        every Flario tool, x402 in-band
//   GET  /api/premium/liquidation-scanner   x402 over real HTTP (spec-style):
//   POST /api/premium/proof-bundle          402 + accepts → X-Payment header
//                                           → result + X-Payment-Response
//   GET  /healthz, GET /                 liveness + discovery
//
// The REST endpoints speak the same x402 payload encoding as the HTTP
// ecosystem (base64 JSON in the X-Payment header, receipt in
// X-Payment-Response), so existing x402 clients can pay without MCP.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, SERVER_INFO } from "./server.js";
import { loadX402Config } from "./x402/config.js";
import {
  buildRequirements,
  verifyPayment,
  settlePayment,
  type SettlementReceipt,
} from "./x402/facilitator.js";
import { decodePayload } from "./x402/paywall.js";
import { type Receipt } from "./x402/receipt.js";
import { checkMandate } from "./x402/mandate.js";
import { finaliseSettlement } from "./x402/emit.js";
import {
  liquidationScannerCore,
  bulkProofBundleCore,
} from "./tools/premium.js";
import type { NetworkType } from "./utils/rpc.js";
import { setHubMode } from "./utils/runtime.js";

const NETWORKS = ["mainnet", "coston2", "songbird", "coston"] as const;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "X-Payment-Response",
    ...headers,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw new Error("request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Run a premium core handler behind spec-style HTTP x402: no X-Payment
 * header → 402 with requirements; valid header → verify, settle, run, and
 * attach the receipt in X-Payment-Response.
 */
async function handlePaidRest(
  req: IncomingMessage,
  res: ServerResponse,
  toolName: string,
  resourceUrl: string,
  run: () => Promise<ToolResult>,
): Promise<void> {
  const config = loadX402Config();

  let receipt: SettlementReceipt | null = null;
  let zkReceipt: Receipt | null = null;
  if (config) {
    const header = req.headers["x-payment"];
    const requirements = {
      ...buildRequirements(config, toolName),
      resource: resourceUrl,
    };
    if (!header || typeof header !== "string") {
      sendJson(res, 402, {
        error: "Payment Required",
        x402Version: 1,
        accepts: [requirements],
      });
      return;
    }
    try {
      const payload = decodePayload(header);
      await verifyPayment(config, toolName, payload);
      // DELICTI brake, same as the MCP path: refuse before any funds move.
      const gate = await checkMandate(config.network, payload);
      if (!gate.ok) {
        throw new Error(gate.reason ?? "DELICTI: mandate check failed");
      }
      receipt = await settlePayment(config, payload);
      zkReceipt = finaliseSettlement(config, payload, receipt, toolName);
    } catch (err) {
      sendJson(res, 402, {
        error: `payment failed: ${err instanceof Error ? err.message : String(err)}`,
        x402Version: 1,
        accepts: [requirements],
      });
      return;
    }
  }

  const result = await run();
  let body: unknown;
  try {
    body = JSON.parse(result.content[0].text);
  } catch {
    body = { result: result.content[0].text };
  }
  if (result.isError) {
    sendJson(res, 500, { error: body });
    return;
  }
  // Canonical shareable receipt travels in the body; the settlement summary
  // stays in X-Payment-Response for x402-client compatibility.
  if (zkReceipt && body && typeof body === "object") {
    (body as Record<string, unknown>).x402_receipt = zkReceipt;
  }
  const headers: Record<string, string> = {};
  if (receipt) {
    headers["X-Payment-Response"] = Buffer.from(
      JSON.stringify({ settled: true, ...receipt }),
    ).toString("base64");
  }
  sendJson(res, 200, body, headers);
}

function parseNetwork(value: string | null): NetworkType {
  return (NETWORKS as readonly string[]).includes(value ?? "")
    ? (value as NetworkType)
    : "mainnet";
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Payment, Mcp-Session-Id, Mcp-Protocol-Version",
      "Access-Control-Expose-Headers": "X-Payment-Response",
    });
    res.end();
    return;
  }

  if (path === "/mcp") {
    if (req.method !== "POST") {
      sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Stateless server: use POST /mcp" },
        id: null,
      });
      return;
    }
    // Stateless: fresh server + transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const raw = await readBody(req);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    return;
  }

  if (path === "/healthz") {
    sendJson(res, 200, { status: "ok", ...SERVER_INFO });
    return;
  }

  if (path === "/" && req.method === "GET") {
    const config = loadX402Config();
    sendJson(res, 200, {
      ...SERVER_INFO,
      description:
        "Flario hub — Flare Network data + payments for AI agents. MCP over Streamable HTTP at POST /mcp; premium REST endpoints paid via x402 (EIP-3009 on Flare).",
      endpoints: {
        mcp: "POST /mcp (MCP Streamable HTTP, stateless; all 21 tools)",
        liquidation_scanner:
          "GET /api/premium/liquidation-scanner?asset=FXRP&network=mainnet&max_agents=50",
        proof_bundle:
          'POST /api/premium/proof-bundle {"requests":[{"voting_round_id":N,"abi_encoded_request":"0x…"}],"network":"coston2"}',
        health: "GET /healthz",
      },
      x402: config
        ? {
            enabled: true,
            network: config.network,
            asset: config.tokenAddress,
            payTo: config.payTo,
            flow: "call → HTTP 402 + accepts[] → sign EIP-3009 TransferWithAuthorization → retry with X-Payment: base64(JSON payload) → result + X-Payment-Response",
          }
        : { enabled: false, note: "premium endpoints currently free" },
      source: "https://github.com/dziuba0x/flario",
    });
    return;
  }

  if (path === "/api/premium/liquidation-scanner" && req.method === "GET") {
    const asset = (url.searchParams.get("asset") ?? "FXRP").toUpperCase();
    if (!["FXRP", "FBTC", "FDOGE"].includes(asset)) {
      sendJson(res, 400, { error: `unknown asset "${asset}"` });
      return;
    }
    const maxAgents = Number(url.searchParams.get("max_agents") ?? "50");
    await handlePaidRest(
      req,
      res,
      "fassets_liquidation_scanner",
      `${url.origin}${path}`,
      () =>
        liquidationScannerCore({
          asset: asset as "FXRP" | "FBTC" | "FDOGE",
          network: parseNetwork(url.searchParams.get("network")),
          max_agents: Number.isFinite(maxAgents)
            ? Math.min(Math.max(1, maxAgents), 100)
            : 50,
        }),
    );
    return;
  }

  if (path === "/api/premium/proof-bundle" && req.method === "POST") {
    let parsed: { requests?: unknown; network?: unknown };
    try {
      parsed = JSON.parse(await readBody(req)) as typeof parsed;
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const requests = Array.isArray(parsed.requests) ? parsed.requests : null;
    if (
      !requests ||
      requests.length === 0 ||
      requests.length > 20 ||
      !requests.every(
        (r: unknown): r is { voting_round_id: number; abi_encoded_request: string } =>
          typeof r === "object" &&
          r !== null &&
          Number.isInteger((r as { voting_round_id?: unknown }).voting_round_id) &&
          typeof (r as { abi_encoded_request?: unknown }).abi_encoded_request === "string" &&
          /^0x[0-9a-fA-F]+$/.test((r as { abi_encoded_request: string }).abi_encoded_request),
      )
    ) {
      sendJson(res, 400, {
        error:
          'body must be {"requests":[{"voting_round_id":N,"abi_encoded_request":"0x…"}] (1–20), "network":"…"}',
      });
      return;
    }
    await handlePaidRest(
      req,
      res,
      "fdc_bulk_proof_bundle",
      `${url.origin}${path}`,
      () =>
        bulkProofBundleCore({
          requests,
          network: parseNetwork(typeof parsed.network === "string" ? parsed.network : null),
        }),
    );
    return;
  }

  sendJson(res, 404, { error: `no route: ${req.method} ${path}` });
}

export async function startHub(
  port: number,
): Promise<ReturnType<typeof createServer>> {
  // Anonymous callers may reach this process, so on-chain submission is
  // denied unless the operator explicitly opted in. See utils/runtime.ts.
  setHubMode(true);
  const host = process.env.FLARIO_HTTP_HOST ?? "127.0.0.1";
  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      process.stderr.write(`hub error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      } else {
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  process.stderr.write(
    `flario hub listening on http://${host}:${port} (MCP: POST /mcp; set FLARIO_HTTP_HOST=0.0.0.0 to expose)\n`,
  );
  return server;
}
