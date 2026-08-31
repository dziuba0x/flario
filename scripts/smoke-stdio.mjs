#!/usr/bin/env node
// Cold-start smoke test: spawn the built server over stdio exactly the way an
// MCP client does, complete the handshake, and list tools, prompts and
// resources. No env vars, no network. If this fails, a new user's very first
// experience of Flario is a broken server, so CI treats it as fatal.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
});

let stderr = "";
child.stderr.on("data", (c) => (stderr += c.toString()));

const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not a JSON-RPC frame
  }
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
});

let nextId = 0;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, 20000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const failures = [];
function check(label, ok, detail) {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}\n`);
  if (!ok) failures.push(label);
}

try {
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "flario-smoke", version: "1.0.0" },
  });
  check("initialize", !init.error, init.error ? JSON.stringify(init.error) : `server=${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
  notify("notifications/initialized");

  const tools = await send("tools/list", {});
  const toolNames = (tools.result?.tools ?? []).map((t) => t.name);
  check("tools/list", toolNames.length > 0, `${toolNames.length} tools`);
  check(
    "every tool has a description",
    (tools.result?.tools ?? []).every((t) => typeof t.description === "string" && t.description.length > 20),
    "an agent picks a tool by its description",
  );

  const prompts = await send("prompts/list", {});
  const promptNames = (prompts.result?.prompts ?? []).map((p) => p.name);
  check("prompts/list", !prompts.error && promptNames.length > 0, promptNames.join(", ") || "none");

  const resources = await send("resources/list", {});
  check("resources/list", !resources.error, `${(resources.result?.resources ?? []).length} resources`);
} catch (err) {
  check("stdio session", false, err.message);
} finally {
  child.kill();
}

if (failures.length) {
  process.stderr.write(`\n${failures.length} check(s) failed: ${failures.join(", ")}\n`);
  if (stderr.trim()) process.stderr.write(`server stderr:\n${stderr}\n`);
  process.exit(1);
}
process.stdout.write("\ncold start OK\n");
