/**
 * Flario + Anthropic tool runner: a minimal agent in one file.
 *
 * What it does: starts Flario as a local MCP server over stdio, turns every Flario
 * tool into a runnable tool with the SDK's `mcpTools` helper, and lets the SDK's
 * tool runner drive the whole loop (call Claude, run the requested tools, send the
 * results back) until Claude gives a final answer.
 *
 * Read-only by design: the Flario child process does NOT receive FLARE_PRIVATE_KEY
 * or any X402 variable, so it cannot sign or spend anything.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npm install
 *   npm start -- "What is the FLR/USD price on Flare, with a proof I can check?"
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  mcpTools,
  type MCPCallToolResultLike,
  type MCPClientLike,
} from "@anthropic-ai/sdk/helpers/beta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-5-5";
const MAX_ITERATIONS = Number(process.env.AGENT_MAX_ITERATIONS ?? 12);

// By default run the published package. To test a local build instead:
//   FLARIO_COMMAND="node ../../dist/index.js" npm start -- "..."
const [command, ...args] = (process.env.FLARIO_COMMAND ?? "npx -y flario").split(" ");

// Only forward non-secret settings. StdioClientTransport already starts the child
// with a minimal safe environment, so nothing else leaks in.
const FORWARDED_ENV = [
  "FLARE_RPC",
  "FLARE_RPC_TESTNET",
  "FLARE_RPC_SONGBIRD",
  "FLARE_RPC_COSTON",
  "FDC_VERIFIER_API_KEY",
  "FLARE_DA_API_KEY",
  "FLARE_DA_URL",
] as const;

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of FORWARDED_ENV) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error('Usage: npm start -- "your question about Flare"');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY first.");
    process.exit(1);
  }

  // 1. Connect to Flario over stdio MCP.
  const mcp = new Client({ name: "flario-tool-runner-example", version: "1.0.0" });
  await mcp.connect(new StdioClientTransport({ command, args, env: childEnv() }));

  try {
    const { tools } = await mcp.listTools();
    console.error(`Connected to Flario: ${tools.length} tools available.`);

    // 2. Wrap each MCP tool so the tool runner can execute it. The adapter exists
    // because the MCP SDK's callTool type also allows a legacy result shape with
    // no `content`; Flario never returns it, so we fail loudly if one appears.
    const adapter: MCPClientLike = {
      async callTool(params) {
        const result = await mcp.callTool(params);
        if (!("content" in result) || !Array.isArray(result.content)) {
          throw new Error(`Unexpected result shape from tool ${params.name}`);
        }
        return result as MCPCallToolResultLike;
      },
    };
    const runnable = mcpTools(tools, adapter).map((tool) => ({
      ...tool,
      // Log every call to stderr so stdout stays clean for the final answer.
      run: async (input: Record<string, unknown>) => {
        console.error(`-> ${tool.name}(${JSON.stringify(input)})`);
        return tool.run(input);
      },
    }));

    // 3. Let the tool runner drive the agent loop.
    const client = new Anthropic();
    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 2048,
      max_iterations: MAX_ITERATIONS,
      system:
        "You are a Flare Network analyst. Use the Flario tools to answer from live " +
        "on-chain data. When a tool returns a proof or a verification flag, say " +
        "whether the answer was verified. Never invent numbers.",
      tools: runnable,
      messages: [{ role: "user", content: question }],
    });

    const finalMessage = await runner.done();
    for (const block of finalMessage.content) {
      if (block.type === "text") console.log(block.text);
    }
  } finally {
    await mcp.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
