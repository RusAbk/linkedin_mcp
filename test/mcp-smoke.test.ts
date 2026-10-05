import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface RpcMessage {
  id?: number;
  result?: { tools?: Array<{ name: string; inputSchema: { properties: { filters?: { properties: Record<string, unknown> } } } }> };
  error?: unknown;
}

test("MCP server completes a legacy handshake and lists connector tools", { timeout: 15_000 }, async () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-mcp-smoke-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp-server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      LINKEDIN_DATA_DIR: dataDir,
      LINKEDIN_PROFILE_DIR: path.join(dataDir, "profile"),
      LINKEDIN_WORKER_MODE: "embedded",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: RpcMessage[] = [];
  let stdoutBuffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) messages.push(JSON.parse(line) as RpcMessage);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0.0" },
      },
    });
    await waitFor(() => messages.some((message) => message.id === 1), stderr);
    const initialize = messages.find((message) => message.id === 1);
    assert.equal(initialize?.error, undefined, stderr);

    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await waitFor(() => messages.some((message) => message.id === 2), stderr);
    const names = messages
      .find((message) => message.id === 2)
      ?.result?.tools?.map((tool) => tool.name)
      .sort();
    assert.deepEqual(names, [
      "linkedin_get_operation",
      "linkedin_get_profile",
      "linkedin_get_profiles",
      "linkedin_search_people",
      "linkedin_send_connection",
      "linkedin_send_message",
      "linkedin_session_status",
      "linkedin_worker_status",
    ]);
    const search = messages.find((message) => message.id === 2)?.result?.tools?.find((tool) => tool.name === "linkedin_search_people");
    assert.ok(search?.inputSchema.properties.filters?.properties.schools, "School filter must be advertised to MCP clients");
  } finally {
    child.stdin.end();
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, stderr: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for MCP response. stderr: ${stderr}`);
}
