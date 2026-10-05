import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface RpcMessage {
  id?: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: unknown;
}

test("MCP tool responses keep text and structured content consistent", { timeout: 15_000 }, async () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-mcp-contract-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp-server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      LINKEDIN_DATA_DIR: dataDir,
      LINKEDIN_PROFILE_DIR: path.join(dataDir, "profile"),
      LINKEDIN_ACTION_MODE: "review",
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
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line) as RpcMessage);
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
        clientInfo: { name: "contract-test", version: "1.0.0" },
      },
    });
    await waitFor(() => messages.some((message) => message.id === 1), () => stderr);
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "linkedin_send_message",
        arguments: {
          operationId: "contract-preview-1",
          profileUrl: "https://www.linkedin.com/in/preview-only-test/",
          text: "Preview only",
          commit: false,
        },
      },
    });
    await waitFor(() => messages.some((message) => message.id === 2), () => stderr);
    assertConsistent(messages.find((message) => message.id === 2)?.result, false);

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "linkedin_get_operation", arguments: { operationId: "missing-operation" } },
    });
    await waitFor(() => messages.some((message) => message.id === 3), () => stderr);
    assertConsistent(messages.find((message) => message.id === 3)?.result, true);
  } finally {
    child.stdin.end();
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function assertConsistent(result: RpcMessage["result"], expectedError: boolean): void {
  assert.ok(result);
  assert.equal(result.isError ?? false, expectedError);
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text);
  assert.deepEqual(JSON.parse(text), result.structuredContent);
}

async function waitFor(predicate: () => boolean, getStderr: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for MCP response. stderr: ${getStderr()}`);
}
