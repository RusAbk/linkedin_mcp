import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserManager } from "../src/browser/browser-manager.js";
import { loadConfig } from "../src/config.js";
import { ConnectorService } from "../src/connector-service.js";
import { ActionOutcomeUnknownError } from "../src/errors.js";
import type { SalesNavigatorAdapter } from "../src/linkedin/sales-navigator-adapter.js";
import { OperationStore } from "../src/storage/operation-store.js";

function fixture(actionMode: "review" | "execute") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-connector-service-"));
  const config = loadConfig({
    projectRoot: directory,
    dataDir: directory,
    profileDir: path.join(directory, "profile"),
    diagnosticsDir: path.join(directory, "diagnostics"),
    databasePath: path.join(directory, "operations.sqlite"),
    actionMode,
  });
  const store = new OperationStore(config.databasePath);
  let sendCount = 0;
  let sent = false;
  const adapter = {
    async messageAlreadySent() {
      return sent;
    },
    async sendMessage(profileUrl: string) {
      sendCount += 1;
      sent = true;
      return { sent: true, profileUrl };
    },
  } as unknown as SalesNavigatorAdapter;
  const service = new ConnectorService(config, {} as BrowserManager, adapter, store);
  return {
    service,
    store,
    directory,
    sendCount: () => sendCount,
    setSent: (value: boolean) => {
      sent = value;
    },
    replaceSend: (implementation: SalesNavigatorAdapter["sendMessage"]) => {
      (adapter as unknown as { sendMessage: SalesNavigatorAdapter["sendMessage"] }).sendMessage = implementation;
    },
  };
}

test("message preview does not create a durable operation", async () => {
  const f = fixture("review");
  try {
    const result = await f.service.sendMessage({
      operationId: "preview-123",
      profileUrl: "https://www.linkedin.com/in/example/",
      text: "Hello",
      commit: false,
    });
    assert.equal(result.status, "preview");
    assert.equal(f.store.get("preview-123"), null);
  } finally {
    f.store.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("successful message operation is replayed without a second send", async () => {
  const f = fixture("execute");
  const input = {
    operationId: "message-123",
    profileUrl: "https://www.linkedin.com/in/example/",
    text: "Hello",
    commit: true,
  };
  try {
    const first = await f.service.sendMessage(input);
    const replay = await f.service.sendMessage(input);
    assert.equal(first.sent, true);
    assert.equal(replay.replayed, true);
    assert.equal(f.sendCount(), 1);
    assert.equal(f.store.get(input.operationId)?.status, "succeeded");
  } finally {
    f.store.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("uncertain message result is reconciled instead of sent twice", async () => {
  const f = fixture("execute");
  f.replaceSend(async () => {
    f.setSent(true);
    throw new ActionOutcomeUnknownError("No confirmation after click");
  });
  const input = {
    operationId: "message-unknown-123",
    profileUrl: "https://www.linkedin.com/in/example/",
    text: "Hello",
    commit: true,
  };
  try {
    await assert.rejects(() => f.service.sendMessage(input), ActionOutcomeUnknownError);
    assert.equal(f.store.get(input.operationId)?.status, "unknown");
    const reconciled = await f.service.sendMessage(input);
    assert.equal(reconciled.reconciled, true);
    assert.equal(f.store.get(input.operationId)?.status, "succeeded");
  } finally {
    f.store.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
