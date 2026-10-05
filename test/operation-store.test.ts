import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConnectorError } from "../src/errors.js";
import { OperationStore, stableStringify } from "../src/storage/operation-store.js";

test("stableStringify produces the same hash input regardless of object key order", () => {
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
});

test("operation ids are idempotent and reject changed parameters", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-connector-store-"));
  const store = new OperationStore(path.join(directory, "operations.sqlite"));
  try {
    const first = store.reserve("operation-123", "send_message", { profileUrl: "https://linkedin.com/in/a", text: "Hi" });
    assert.equal(first.isNew, true);
    assert.equal(first.record.status, "pending");

    const replay = store.reserve("operation-123", "send_message", { text: "Hi", profileUrl: "https://linkedin.com/in/a" });
    assert.equal(replay.isNew, false);

    assert.throws(
      () => store.reserve("operation-123", "send_message", { profileUrl: "https://linkedin.com/in/a", text: "Different" }),
      (error: unknown) => error instanceof ConnectorError && error.code === "ACTION_CONFLICT",
    );
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
