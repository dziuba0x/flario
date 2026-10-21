# Flario with the Anthropic tool runner

A small agent that answers questions about Flare Network by calling Flario's tools. It shows the shortest path from "Flario is an MCP server" to "Flario inside my own application":

- Flario runs as a local MCP server over stdio.
- The SDK helper `mcpTools` turns every Flario tool into a runnable tool.
- The SDK's [tool runner](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner) runs the whole loop: it calls Claude, executes the tools Claude asks for, sends the results back, and stops when Claude gives a final answer or hits `max_iterations`.

There is no hand-written `tool_use` / `tool_result` loop in this example. That is the point.

## Run it

```bash
cd examples/tool-runner-agent
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start -- "What is the FLR/USD price on Flare, with a proof I can check?"
```

The answer goes to stdout. Each tool call is logged to stderr, so you can see what the agent did.

The first run downloads Flario through `npx`, which can take around half a minute. If you use the example often, install Flario once and point to it:

```bash
npm install -g flario
FLARIO_COMMAND="flario" npm start -- "..."
```

To try a local build of this repository:

```bash
npm run build                       # in the repo root
FLARIO_COMMAND="node ../../dist/index.js" npm start -- "..."
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none, required | Your Anthropic API key. |
| `AGENT_MODEL` | `claude-sonnet-5-5` | Model used for the loop. |
| `AGENT_MAX_ITERATIONS` | `12` | Upper bound on model calls, so a confused agent cannot loop forever. |
| `FLARIO_COMMAND` | `npx -y flario` | Command that starts Flario over stdio. |

## Read-only by design

The Flario child process receives only the public RPC and data-layer settings (`FLARE_RPC*`, `FDC_VERIFIER_API_KEY`, `FLARE_DA_*`). It does not receive `FLARE_PRIVATE_KEY` or any `X402_*` variable, so this agent cannot sign transactions or spend funds. Attestation tools return a prepared request instead of submitting one. If you want an agent that pays for premium tools, add that deliberately and keep the key out of anything the model can read.

## Why a tool runner here

Flario's tools often return proofs and verification flags. A tool error (bad input, RPC failure) reaches the model as a tool result with `is_error: true`, so Claude can correct its arguments and retry without any code on your side.

Use the manual loop from the docs instead when you need something the runner does not give you: human approval before a tool runs, custom logging, or conditional execution. That matters most if you ever let an agent hold a key.

## Behind a proxy

The MCP SDK starts the child process with a minimal environment on purpose, so proxy variables such as `HTTPS_PROXY` are not passed on. If `npx -y flario` hangs at startup behind a proxy, install Flario globally or use a local build as shown above.
